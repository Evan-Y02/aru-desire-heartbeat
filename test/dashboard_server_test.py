import base64
import copy
import hashlib
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
        "appliedEffectIds": [],
    }


def settlement_fact(index, settlement_type, epoch_ms, result=None):
    return {
        "factFingerprint": "fact-private-" + str(index),
        "effectId": "effect-private-" + str(index),
        "eventIds": ["event-private-" + str(index)],
        "carryoverFactor": 0.3,
        "type": settlement_type,
        "at": pair(epoch_ms),
        "result": result,
        "raw": "must never be exposed",
        "thought": "must never be exposed",
        "token": "must never be exposed",
        "url": "https://private.invalid/secret/path",
    }


def settlement_result(before=0.8, after=0.24, duplicate=False):
    return {
        "libidoBefore": before,
        "libidoAfter": after,
        "arousalBefore": 0.9,
        "arousalAfter": 0.18,
        "refractoryUntil": pair(NOW + 3600000),
        "cooldownUntil": None,
        "receiptStatus": "settled",
        "settled": True,
        "duplicateIgnored": duplicate,
        "payload": "must never be exposed",
        "credential": "must never be exposed",
    }


def fixture_interaction(facts=None, sessions=None):
    return {
        "schema": "aru.desire-heartbeat.interaction-state.v1",
        "version": 1,
        "chat": {"settlementFacts": facts or [], "pendingSettlementReceipt": None},
        "arousal": {"refractoryUntil": None, "pendingReleaseReceipt": None},
        "soloSessions": {"sessions": sessions or []},
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
        self.auth_path = self.data / "dashboard-auth.json"
        self.password = "correct-horse-battery"
        salt = b"0123456789abcdef"
        self.auth_path.write_text(json.dumps({
            "schema": "aru.desire-dashboard.auth.v1",
            "version": 1,
            "username": "xinchao",
            "salt": base64.b64encode(salt).decode("ascii"),
            "digest": hashlib.scrypt(
                self.password.encode("utf-8"), salt=salt,
                n=2 ** 14, r=8, p=1, dklen=32,
            ).hex(),
        }), encoding="utf-8")
        os.chmod(self.auth_path, 0o600)
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.temporary.cleanup()
    def serve(self, config_path=None):
        server = dashboard.DashboardServer(("127.0.0.1", 0), dashboard.DashboardHandler)
        server.config_path = self.config if config_path is None else config_path
        server.data_directory = self.data
        server.public_directory = self.public
        server.auth_record = dashboard.load_auth_record(self.auth_path)
        server.sessions = {}
        server.login_attempts = {}
        server.auth_lock = threading.Lock()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append(server)
        return "http://127.0.0.1:" + str(server.server_address[1])

    def login(self, origin, username="xinchao", password=None):
        request = Request(
            origin + "/api/login",
            method="POST",
            data=json.dumps({
                "username": username,
                "password": self.password if password is None else password,
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=3) as response:
            cookie = response.headers["Set-Cookie"]
        return cookie.split(";", 1)[0], cookie

    def authenticated_open(self, origin, path):
        cookie, _ = self.login(origin)
        return urlopen(Request(origin + path, headers={"Cookie": cookie}), timeout=3)

    def test_snapshot_maps_all_drives_without_mutation(self):
        state = fixture_state()
        before = copy.deepcopy(state)
        config = json.loads(self.config.read_text(encoding="utf-8"))
        result = dashboard.create_dashboard_snapshot(state, config, NOW + 60000)
        self.assertEqual(len(result["drives"]), 8)
        self.assertEqual(result["strongest"]["drive"], "attachment")
        self.assertEqual(result["strongest"]["valuePercent"], 72)
        self.assertEqual(result["expression"]["intent"], "reach_owner")
        self.assertEqual(result["expression"]["consecutiveWithholds"], 0)
        self.assertEqual(result["expression"]["maxConsecutiveWithholds"], 3)
        self.assertEqual(result["thoughts"][0]["text"], state["thoughts"][0]["text"])
        self.assertEqual(result["thoughts"][0]["sourceLabel"], "自然形成")
        self.assertEqual(result["timelineTotal"], 1)
        self.assertEqual(result["timeline"][0]["outcomeLabel"], "来找你了")
        self.assertEqual(result["timeline"][0]["reasons"], ["Aru 已接收"])
        self.assertEqual(result["timeline"][0]["reasonCodes"], ["delivery-accepted"])
        self.assertEqual(len(result["timeline"][0]["drives"]), 8)
        self.assertTrue(result["solo"]["enabled"])
        self.assertEqual(result["solo"]["count"], 0)
        self.assertFalse(result["solo"]["cooldownActive"])
        self.assertEqual(result["settlements"]["history"], [])
        self.assertIsNone(result["settlements"]["latestAt"])
        self.assertEqual(state, before)

    def test_settlement_view_maps_all_four_types_and_values(self):
        state = fixture_state()
        types = [
            "partnered_release", "partnered_no_release", "solo_release", "solo_no_release",
        ]
        facts = [
            settlement_fact(index, settlement_type, NOW + index * 1000,
                            settlement_result(0.8, 0.2 + index * 0.1, index == 3))
            for index, settlement_type in enumerate(types)
        ]
        state["appliedEffectIds"] = [fact["effectId"] for fact in facts]
        config = json.loads(self.config.read_text(encoding="utf-8"))
        view = dashboard.create_dashboard_snapshot(
            state, config, NOW + 5000, fixture_interaction(facts),
        )["settlements"]
        self.assertEqual([item["type"] for item in reversed(view["history"])], types)
        self.assertEqual({item["typeLabel"] for item in view["history"]}, {
            "双方亲密，明确高潮/射精", "双方亲密，未高潮/未射精",
            "自己解决，明确高潮/射精", "自己解决，未高潮/未射精",
        })
        self.assertEqual(view["history"][-1]["libido"], {
            "beforePercent": 80, "afterPercent": 20, "changePercent": -60,
        })
        self.assertEqual(view["history"][-1]["arousal"]["beforePercent"], 90)
        self.assertTrue(view["history"][0]["duplicateIgnored"])

    def test_settlement_history_is_descending_and_limited_to_ten(self):
        facts = [
            settlement_fact(index, "partnered_release", NOW + index * 1000,
                            settlement_result())
            for index in range(12)
        ]
        state = fixture_state()
        state["appliedEffectIds"] = [fact["effectId"] for fact in facts]
        config = json.loads(self.config.read_text(encoding="utf-8"))
        history = dashboard.create_dashboard_snapshot(
            state, config, NOW + 20000, fixture_interaction(facts),
        )["settlements"]["history"]
        self.assertEqual(len(history), 10)
        self.assertEqual(history[0]["time"], pair(NOW + 11000)["iso"])
        self.assertEqual(history[-1]["time"], pair(NOW + 2000)["iso"])

    def test_legacy_missing_and_damaged_settlements_are_safe(self):
        missing = settlement_fact(1, "partnered_no_release", NOW, None)
        damaged = settlement_fact(2, "unknown_type", NOW + 1000, settlement_result())
        partial = settlement_fact(3, "solo_no_release", NOW + 2000, {
            "libidoBefore": 0.7,
            "libidoAfter": "damaged",
            "receiptStatus": "damaged",
        })
        config = json.loads(self.config.read_text(encoding="utf-8"))
        view = dashboard.create_dashboard_snapshot(
            fixture_state(), config, NOW + 3000,
            fixture_interaction([missing, damaged, partial, "broken"]),
        )["settlements"]
        self.assertEqual(len(view["history"]), 2)
        self.assertEqual(view["history"][0]["receiptStatus"], "unknown")
        self.assertEqual(view["history"][0]["libido"], {
            "beforePercent": 70, "afterPercent": None, "changePercent": None,
        })
        self.assertEqual(view["history"][1]["libido"]["beforePercent"], None)

    def test_pending_receipt_overrides_an_older_settled_result(self):
        fact = settlement_fact(1, "partnered_release", NOW, settlement_result())
        interaction = fixture_interaction([fact])
        interaction["chat"]["pendingSettlementReceipt"] = {
            "factFingerprint": fact["factFingerprint"],
        }
        config = json.loads(self.config.read_text(encoding="utf-8"))
        view = dashboard.create_dashboard_snapshot(
            fixture_state(), config, NOW + 1, interaction,
        )["settlements"]
        self.assertEqual(view["receiptStatus"], "pending")
        self.assertEqual(view["history"][0]["receiptStatus"], "pending")
        self.assertFalse(view["history"][0]["settled"])

    def test_refractory_cooldown_and_solo_settlement_are_projected(self):
        state = fixture_state()
        state["solo"] = {
            "count": 1, "lastSoloAt": pair(NOW),
            "refractoryUntil": pair(NOW + 120000), "lastLibidoChoice": "solo",
        }
        session = {
            "outcome": "completed_release", "settlementAt": pair(NOW),
            "libidoBefore": 0.9, "libidoAfter": 0.342,
            "arousalBefore": 1, "arousalAfter": 0.2,
            "refractoryUntil": pair(NOW + 60000),
            "cooldownUntil": pair(NOW + 120000),
            "receiptStatus": "settled", "settled": True, "duplicateIgnored": False,
        }
        interaction = fixture_interaction(sessions=[session])
        interaction["arousal"]["refractoryUntil"] = pair(NOW + 60000)
        config = json.loads(self.config.read_text(encoding="utf-8"))
        view = dashboard.create_dashboard_snapshot(
            state, config, NOW + 30000, interaction,
        )["settlements"]
        self.assertTrue(view["refractory"]["active"])
        self.assertEqual(view["refractory"]["remainingSeconds"], 30)
        self.assertTrue(view["cooldown"]["active"])
        self.assertEqual(view["cooldown"]["remainingSeconds"], 90)
        self.assertEqual(view["history"][0]["type"], "solo_release")

    def test_settlement_projection_filters_private_fields(self):
        fact = settlement_fact(1, "partnered_release", NOW, settlement_result())
        state = fixture_state()
        state["appliedEffectIds"] = [fact["effectId"]]
        config = json.loads(self.config.read_text(encoding="utf-8"))
        view = dashboard.create_dashboard_snapshot(
            state, config, NOW + 1, fixture_interaction([fact]),
        )["settlements"]
        serialized = json.dumps(view, ensure_ascii=False)
        for forbidden in ("raw", "thought", "token", "credential", "payload",
                          "private.invalid", "fact-private", "effect-private", "event-private"):
            self.assertNotIn(forbidden, serialized)

    def test_api_is_read_only_and_non_cacheable(self):
        before = self.state_path.read_bytes()
        interaction_path = self.data / "interaction-state.json"
        interaction_path.write_text(json.dumps(fixture_interaction()), encoding="utf-8")
        os.chmod(interaction_path, 0o600)
        interaction_before = interaction_path.read_bytes()
        origin = self.serve()
        with self.authenticated_open(origin, "/api/snapshot") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("no-store", response.headers["Cache-Control"])
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
            result = json.loads(response.read())
        self.assertEqual(result["schema"], "aru.desire-dashboard.snapshot.v1")
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertEqual(interaction_path.read_bytes(), interaction_before)

    def test_web_login_protects_snapshot_and_uses_secure_cookie(self):
        origin = self.serve()
        with urlopen(origin + "/api/session", timeout=3) as response:
            self.assertFalse(json.loads(response.read())["authenticated"])
        with self.assertRaises(HTTPError) as unauthenticated:
            urlopen(origin + "/api/snapshot", timeout=3)
        self.assertEqual(unauthenticated.exception.code, 401)
        with self.assertRaises(HTTPError) as rejected:
            self.login(origin, password="wrong-password")
        self.assertEqual(rejected.exception.code, 401)
        cookie, full_cookie = self.login(origin)
        self.assertIn("HttpOnly", full_cookie)
        self.assertIn("Secure", full_cookie)
        self.assertIn("SameSite=Strict", full_cookie)
        request = Request(origin + "/api/snapshot", headers={"Cookie": cookie})
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
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
        self.assertIn("暂无射精或满足结算记录", script)
        page = (self.public / "index.html").read_text(encoding="utf-8")
        self.assertIn("射精与满足结算", page)

    def test_timeline_rejects_raw_text_and_unknown_reasons(self):
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry["text"] = "raw private chat"
        with self.assertRaisesRegex(ValueError, "timeline entry is invalid"):
            dashboard.timeline_view(entry)
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry["reasons"] = ["untrusted-reason"]
        with self.assertRaisesRegex(ValueError, "timeline reasons are invalid"):
            dashboard.timeline_view(entry)

    def test_timeline_accepts_private_fingerprint_without_exposing_it(self):
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry["decisionFingerprint"] = "a" * 64
        entry["outcome"] = "pending_expired"
        entry["reasons"] = ["pending-expired", "pending-cooldown"]
        view = dashboard.timeline_view(entry)
        self.assertEqual(view["outcomeLabel"], "等待意图已过期")
        self.assertNotIn("decisionFingerprint", view)

    def test_autonomous_silence_and_local_psychology_are_visible(self):
        entry = copy.deepcopy(fixture_state()["timeline"][0])
        entry.update({
            "outcome": "withheld",
            "reasons": ["expression-withheld", "withheld-third"],
        })
        view = dashboard.timeline_view(entry)
        self.assertEqual(view["outcomeLabel"], "暂时没开口")
        self.assertEqual(view["reasonCodes"], ["expression-withheld", "withheld-third"])
        script = (self.public / "app.js").read_text(encoding="utf-8")
        self.assertIn("这是连续第三次选择暂时不说", script)
        self.assertIn("此前已经连续三次没有开口", script)
        self.assertIn("欲望已经到达 100%", script)
        self.assertIn("Solo 仅复用授权自主检查回合", script)

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
            self.authenticated_open(origin, "/api/snapshot")
        self.assertEqual(unavailable.exception.code, 503)

    def test_solo_session_detail_requires_login_and_exposes_only_private_view(self):
        config = json.loads(self.config.read_text(encoding="utf-8"))
        config["soloSessionsEnabled"] = True
        enabled_config = self.data / "enabled-config.json"
        enabled_config.write_text(json.dumps(config), encoding="utf-8")
        interaction = {
            "schema": "aru.desire-heartbeat.interaction-state.v1",
            "version": 1,
            "chat": {},
            "arousal": {},
            "soloSessions": {
                "activeSessionId": None,
                "processedRunIds": ["run-internal"],
                "processedStepIds": ["step-internal"],
                "sessions": [{
                    "sessionId": "solo-session-1-1",
                    "selectedAt": pair(NOW),
                    "endedAt": pair(NOW + 1000),
                    "triggerReason": "Synthetic private trigger.",
                    "thought": "Synthetic generated thought.",
                    "processSummary": "Synthetic ordered process summary.",
                    "released": True,
                    "outcome": "completed_release",
                    "climaxQuality": 0.88,
                    "output": 0.25,
                    "afterThought": "Synthetic afterthought.",
                }],
            },
        }
        interaction_path = self.data / "interaction-state.json"
        interaction_path.write_text(json.dumps(interaction), encoding="utf-8")
        os.chmod(interaction_path, 0o600)
        origin = self.serve(enabled_config)
        with self.assertRaises(HTTPError) as rejected:
            urlopen(origin + "/api/snapshot", timeout=3)
        self.assertEqual(rejected.exception.code, 401)
        with self.authenticated_open(origin, "/api/snapshot") as response:
            snapshot = json.loads(response.read())
        solo = snapshot["soloSession"]
        self.assertEqual(solo["triggerReason"], "Synthetic private trigger.")
        serialized = json.dumps(solo)
        self.assertNotIn("processedRunIds", serialized)
        self.assertNotIn("sessionId", serialized)
        self.assertNotIn("step-internal", serialized)

    def test_private_auth_permissions_are_enforced(self):
        os.chmod(self.auth_path, 0o644)
        with self.assertRaisesRegex(ValueError, "unsafe private file"):
            dashboard.create_server(
                "127.0.0.1", 18760, self.config, self.data, self.public, self.auth_path,
            )

    def test_public_factory_refuses_non_loopback(self):
        with self.assertRaisesRegex(ValueError, "must bind to 127.0.0.1"):
            dashboard.create_server(
                "0.0.0.0", 18760, self.config, self.data, self.public, self.auth_path,
            )


if __name__ == "__main__":
    unittest.main()
