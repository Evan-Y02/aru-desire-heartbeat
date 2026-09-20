import copy
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("aru_dashboard", ROOT / "dashboard" / "server.py")
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)

NOW = 1789372800000


def pair(epoch_ms):
    return {"iso": dashboard.iso(epoch_ms), "epochMs": epoch_ms}


def fixture_state():
    drives = {name: 0.20 for name in dashboard.DRIVES}
    drives["attachment"] = 0.72
    drives["libido"] = 0.64
    return {
        "schema": "aru.desire-heartbeat.state.v2",
        "version": 2,
        "sequence": 1,
        "createdAt": pair(NOW),
        "updatedAt": pair(NOW + 1),
        "lastTickAt": pair(NOW),
        "lastDecisionAt": None,
        "drives": drives,
        "lastSatisfiedAt": {name: None for name in dashboard.DRIVES},
        "thoughts": [{
            "id": "thought-test",
            "drive": "attachment",
            "type": "flit",
            "intensity": 0.68,
            "fedCount": 0,
            "text": "<img src=x onerror=alert(1)> 想靠近她",
            "source": "automatic",
            "createdAt": pair(NOW + 1),
            "updatedAt": pair(NOW + 1),
        }],
        "timeline": [{
            "at": pair(NOW),
            "nextCheckAt": pair(NOW + 600000),
            "outcome": "submitted",
            "drive": "attachment",
            "intent": "reach_owner",
            "score": 0.72,
            "willingness": 0.81,
            "reasons": ["delivery-accepted"],
            "drives": copy.deepcopy(drives),
        }],
        "pendingDecision": None,
    }


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aru-dashboard-test-")
        self.data = Path(self.temporary.name)
        os.chmod(self.data, 0o700)
        self.state_path = self.data / "state.json"
        self.state_path.write_text(
            json.dumps(fixture_state(), ensure_ascii=False),
            encoding="utf-8",
        )
        os.chmod(self.state_path, 0o600)
        self.config = ROOT / "config" / "default.json"
        self.public = ROOT / "dashboard" / "public"
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.temporary.cleanup()
    def serve(self):
        server = dashboard.DashboardServer(("127.0.0.1", 0), dashboard.DashboardHandler)
        server.config_path = self.config
        server.data_directory = self.data
        server.public_directory = self.public
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append(server)
        return "http://127.0.0.1:" + str(server.server_address[1])

    def test_snapshot_maps_all_drives_without_mutation(self):
        state = fixture_state()
        before = copy.deepcopy(state)
        config = json.loads(self.config.read_text(encoding="utf-8"))
        result = dashboard.create_dashboard_snapshot(state, config, NOW + 60000)
        self.assertEqual(len(result["drives"]), 8)
        self.assertEqual(result["strongest"]["drive"], "attachment")
        self.assertEqual(result["strongest"]["valuePercent"], 72)
        self.assertEqual(result["expression"]["intent"], "reach_owner")
        self.assertEqual(result["thoughts"][0]["text"], state["thoughts"][0]["text"])
        self.assertEqual(result["thoughts"][0]["sourceLabel"], "自然形成")
        self.assertEqual(result["timelineTotal"], 1)
        self.assertEqual(result["timeline"][0]["outcomeLabel"], "来找你了")
        self.assertEqual(result["timeline"][0]["reasons"], ["Aru 已接收"])
        self.assertEqual(len(result["timeline"][0]["drives"]), 8)
        self.assertTrue(result["solo"]["enabled"])
        self.assertEqual(result["solo"]["count"], 0)
        self.assertFalse(result["solo"]["cooldownActive"])
        self.assertEqual(state, before)

    def test_api_is_read_only_and_non_cacheable(self):
        before = self.state_path.read_bytes()
        origin = self.serve()
        with urlopen(origin + "/api/snapshot", timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("no-store", response.headers["Cache-Control"])
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
            result = json.loads(response.read())
        self.assertEqual(result["schema"], "aru.desire-dashboard.snapshot.v1")
        self.assertEqual(self.state_path.read_bytes(), before)
    def test_writes_and_unknown_paths_are_rejected(self):
        origin = self.serve()
        request = Request(origin + "/api/snapshot", method="POST", data=b"{}")
        with self.assertRaises(HTTPError) as rejected:
            urlopen(request, timeout=3)
        self.assertEqual(rejected.exception.code, 405)
        with self.assertRaises(HTTPError) as missing:
            urlopen(origin + "/..%2f..%2fetc%2fpasswd", timeout=3)
        self.assertEqual(missing.exception.code, 404)

    def test_mobile_drive_grid_uses_two_compact_columns(self):
        styles = (self.public / "styles.css").read_text(encoding="utf-8")
        grid = ".drive-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));"
        self.assertIn(grid, styles)
        self.assertIn(".drive {\n  --accent: #b680a2;\n  min-width: 0;", styles)

    def test_frontend_uses_text_nodes_for_untrusted_thoughts(self):
        origin = self.serve()
        with urlopen(origin + "/app.js", timeout=3) as response:
            script = response.read().decode("utf-8")
        self.assertIn("textContent", script)
        self.assertNotIn("innerHTML", script)

    def test_timeline_rejects_raw_text_and_unknown_reasons(self):
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry["text"] = "raw private chat"
        with self.assertRaisesRegex(ValueError, "timeline entry is invalid"):
            dashboard.timeline_view(entry)
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry["reasons"] = ["untrusted-reason"]
        with self.assertRaisesRegex(ValueError, "timeline reasons are invalid"):
            dashboard.timeline_view(entry)

    def test_solo_timeline_and_cooldown_are_visible(self):
        state = fixture_state()
        state["solo"] = {
            "count": 2,
            "lastSoloAt": pair(NOW),
            "refractoryUntil": pair(NOW + 10800000),
            "lastLibidoChoice": "solo",
        }
        state["timeline"][0].update({
            "outcome": "solo_completed",
            "drive": "libido",
            "intent": "solo",
            "score": 0.90,
            "willingness": 1,
            "reasons": ["solo-completed"],
        })
        config = json.loads(self.config.read_text(encoding="utf-8"))
        result = dashboard.create_dashboard_snapshot(state, config, NOW + 60000)
        self.assertEqual(result["timeline"][0]["outcomeLabel"], "自己处理了")
        self.assertEqual(result["timeline"][0]["intentLabel"], "想独处消解")
        self.assertEqual(result["solo"]["count"], 2)
        self.assertTrue(result["solo"]["cooldownActive"])

    def test_private_state_permissions_are_enforced(self):
        os.chmod(self.state_path, 0o644)
        origin = self.serve()
        with self.assertRaises(HTTPError) as unavailable:
            urlopen(origin + "/api/snapshot", timeout=3)
        self.assertEqual(unavailable.exception.code, 503)

    def test_public_factory_refuses_non_loopback(self):
        with self.assertRaisesRegex(ValueError, "must bind to 127.0.0.1"):
            dashboard.create_server(
                "0.0.0.0", 18760, self.config, self.data, self.public,
            )


if __name__ == "__main__":
    unittest.main()