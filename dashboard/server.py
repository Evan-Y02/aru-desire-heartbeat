#!/usr/bin/env python3
import json
import os
import stat
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "default.json"
DEFAULT_DATA = ROOT / "data"
DEFAULT_PUBLIC = ROOT / "dashboard" / "public"

DRIVES = (
    "attachment", "curiosity", "reflection", "duty",
    "social", "fatigue", "libido", "stress",
)
ACTIVE_DRIVES = ("attachment", "curiosity", "reflection", "social", "libido", "stress")
DRIVE_LABELS = {
    "attachment": "依恋", "curiosity": "好奇", "reflection": "反思", "duty": "责任",
    "social": "社交", "fatigue": "疲劳", "libido": "性欲", "stress": "压力",
}
INTENT_BY_DRIVE = {
    "attachment": "reach_owner", "curiosity": "share", "reflection": "confide",
    "social": "reach_owner", "libido": "seek_closeness", "stress": "confide",
}
INTENT_LABELS = {
    "reach_owner": "想靠近你", "seek_closeness": "想寻求亲近",
    "solo": "想独处消解", "share": "想与你分享", "confide": "想向你倾诉",
}
TIMELINE_OUTCOME_LABELS = {
    "idle": "继续积累", "withheld": "旧版未开口",
    "held_disabled": "意图被门禁留住", "submitting": "正在提交",
    "submitted": "来找你了", "held_claimed": "已避免重复发送",
    "delivery_failed": "发送未确认", "solo_completed": "自己处理了",
}
TIMELINE_REASON_LABELS = {
    "clock-anomaly": "时钟异常", "pending-decision": "已有待处理意图",
    "fatigue-gate": "疲劳门禁", "below-trigger-threshold": "尚未达到门槛",
    "observe-only": "仅观察", "delivery-disabled": "发送尚未开启",
    "delivery-adapter-disabled": "Aru 传输尚未开启",
    "expression-withheld": "旧版概率门控记录", "delivery-accepted": "Aru 已接收",
    "delivery-already-claimed": "已阻止重复发送", "delivery-failed": "发送结果未确认",
    "solo-completed": "Solo 已完成",
}
SECURITY_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Content-Security-Policy": (
        "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; "
        "frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; "
        "script-src 'self'; style-src 'self'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
MAX_FILE_BYTES = 1024 * 1024


def iso(epoch_ms):
    return datetime.fromtimestamp(epoch_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def percentage(value):
    result = round(float(value) * 100, 1)
    return int(result) if result.is_integer() else result


def require_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
        raise ValueError(label + " is invalid")
def read_regular(path, *, private=False):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE_BYTES:
        raise ValueError("unsafe file")
    if private and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600):
        raise ValueError("unsafe private file")
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            return handle.read(MAX_FILE_BYTES + 1)
    finally:
        os.close(descriptor)


def read_json(path, *, private=False):
    raw = read_regular(path, private=private)
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError("file too large")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON root is invalid")
    return value


def load_snapshot_inputs(config_path, data_directory):
    directory = Path(data_directory)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError("unsafe data directory")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("unsafe data directory mode")
    config = read_json(config_path)
    state = read_json(directory / "state.json", private=True)
    return state, config
def validate_inputs(state, config):
    if state.get("schema") != "aru.desire-heartbeat.state.v2":
        raise ValueError("state schema is invalid")
    if config.get("schema") != "aru.desire-heartbeat.config.v2":
        raise ValueError("config schema is invalid")
    drives = state.get("drives")
    if not isinstance(drives, dict) or set(drives) != set(DRIVES):
        raise ValueError("drives are invalid")
    for drive in DRIVES:
        require_number(drives[drive], drive)
    for field in ("updatedAt", "lastTickAt"):
        pair = state.get(field)
        if not isinstance(pair, dict) or not isinstance(pair.get("iso"), str):
            raise ValueError(field + " is invalid")
        if not isinstance(pair.get("epochMs"), int):
            raise ValueError(field + " is invalid")
    heartbeat = config.get("heartbeatSeconds")
    threshold = config.get("triggerThreshold")
    fatigue_gate = config.get("fatigueGate")
    if not isinstance(heartbeat, int) or heartbeat < 1:
        raise ValueError("heartbeat is invalid")
    require_number(threshold, "threshold")
    require_number(fatigue_gate, "fatigue gate")
    thoughts = state.get("thoughts")
    if not isinstance(thoughts, list) or len(thoughts) > 128:
        raise ValueError("thoughts are invalid")
    timeline = state.get("timeline", [])
    if not isinstance(timeline, list) or len(timeline) > 72:
        raise ValueError("timeline is invalid")
    return drives, thoughts, timeline


def strongest(drives, names):
    drive = max(names, key=lambda name: drives[name])
    return drive, drives[drive]


def intent_matches_drive(drive, intent):
    return INTENT_BY_DRIVE.get(drive) == intent or (drive == "libido" and intent == "solo")


def thought_view(thought):
    drive = thought.get("drive")
    kind = thought.get("type")
    intensity = thought.get("intensity")
    content = thought.get("text")
    source = thought.get("source", "manual")
    updated = thought.get("updatedAt")
    if drive not in DRIVES or kind not in ("flit", "fixation"):
        raise ValueError("thought is invalid")
    if source not in ("automatic", "manual"):
        raise ValueError("thought source is invalid")
    require_number(intensity, "thought intensity")
    if not isinstance(content, str) or not 0 < len(content) <= 280:
        raise ValueError("thought text is invalid")
    if any(ord(character) < 32 or ord(character) == 127 for character in content):
        raise ValueError("thought text is invalid")
    if not isinstance(updated, dict) or not isinstance(updated.get("iso"), str):
        raise ValueError("thought time is invalid")
    return {
        "type": kind,
        "typeLabel": "执念" if kind == "fixation" else "浮念",
        "drive": drive,
        "driveLabel": DRIVE_LABELS[drive],
        "source": source,
        "sourceLabel": "自然形成" if source == "automatic" else "手动记录",
        "intensityPercent": percentage(intensity),
        "text": content,
        "updatedAt": updated["iso"],
    }


def timeline_view(entry):
    expected_fields = {
        "at", "nextCheckAt", "outcome", "drive", "intent",
        "score", "willingness", "reasons", "drives",
    }
    if not isinstance(entry, dict) or set(entry) != expected_fields:
        raise ValueError("timeline entry is invalid")
    at = entry.get("at")
    next_check = entry.get("nextCheckAt")
    if not isinstance(at, dict) or not isinstance(at.get("iso"), str):
        raise ValueError("timeline time is invalid")
    if not isinstance(next_check, dict) or not isinstance(next_check.get("iso"), str):
        raise ValueError("timeline next check is invalid")
    outcome = entry.get("outcome")
    if outcome not in TIMELINE_OUTCOME_LABELS:
        raise ValueError("timeline outcome is invalid")
    drive = entry.get("drive")
    intent = entry.get("intent")
    score = entry.get("score")
    if drive is None:
        if intent is not None or score is not None:
            raise ValueError("timeline selection is invalid")
    else:
        if drive not in ACTIVE_DRIVES or not intent_matches_drive(drive, intent):
            raise ValueError("timeline selection is invalid")
        require_number(score, "timeline score")
    willingness = entry.get("willingness")
    if willingness is not None:
        require_number(willingness, "timeline willingness")
    reasons = entry.get("reasons")
    if not isinstance(reasons, list) or len(reasons) > 16:
        raise ValueError("timeline reasons are invalid")
    if (any(reason not in TIMELINE_REASON_LABELS for reason in reasons)
            or len(set(reasons)) != len(reasons)):
        raise ValueError("timeline reasons are invalid")
    values = entry.get("drives")
    if not isinstance(values, dict) or set(values) != set(DRIVES):
        raise ValueError("timeline drives are invalid")
    for name in DRIVES:
        require_number(values[name], "timeline " + name)
    return {
        "at": at["iso"], "nextCheckAt": next_check["iso"],
        "outcome": outcome, "outcomeLabel": TIMELINE_OUTCOME_LABELS[outcome],
        "drive": drive, "driveLabel": DRIVE_LABELS.get(drive, "无"),
        "intent": intent, "intentLabel": INTENT_LABELS.get(intent, "继续感受"),
        "scorePercent": None if score is None else percentage(score),
        "willingnessPercent": None if willingness is None else percentage(willingness),
        "reasons": [TIMELINE_REASON_LABELS[reason] for reason in reasons],
        "drives": [
            {"drive": name, "label": DRIVE_LABELS[name], "valuePercent": percentage(values[name])}
            for name in DRIVES
        ],
    }


def pulse_status(state, config, candidate_value):
    if state.get("pendingDecision") is not None:
        return "pending", "已有行动正在等待处理"
    if state["drives"]["fatigue"] >= config["fatigueGate"]:
        return "resting", "疲劳门禁正在阻止行动"
    if candidate_value >= config["triggerThreshold"]:
        return "ready", "已经达到行动门槛"
    return "growing", "仍在自然积累"


def create_solo_view(state, config, now_ms):
    solo_config = config.get("solo")
    if not isinstance(solo_config, dict) or not isinstance(solo_config.get("enabled"), bool):
        raise ValueError("solo config is invalid")
    cooldown = solo_config.get("cooldownSeconds")
    if not isinstance(cooldown, int) or cooldown < 1:
        raise ValueError("solo cooldown is invalid")
    solo = state.get("solo") or {
        "count": 0, "lastSoloAt": None,
        "refractoryUntil": None, "lastLibidoChoice": None,
    }
    if not isinstance(solo, dict) or not isinstance(solo.get("count"), int) or solo["count"] < 0:
        raise ValueError("solo state is invalid")
    for field in ("lastSoloAt", "refractoryUntil"):
        pair = solo.get(field)
        if pair is not None and (not isinstance(pair, dict) or
                                 not isinstance(pair.get("iso"), str) or
                                 not isinstance(pair.get("epochMs"), int)):
            raise ValueError("solo time is invalid")
    choice = solo.get("lastLibidoChoice")
    if choice not in (None, "seek_closeness", "solo"):
        raise ValueError("solo choice is invalid")
    until = solo.get("refractoryUntil")
    return {
        "enabled": solo_config["enabled"],
        "count": solo["count"],
        "lastSoloAt": None if solo.get("lastSoloAt") is None else solo["lastSoloAt"]["iso"],
        "refractoryUntil": None if until is None else until["iso"],
        "cooldownActive": until is not None and now_ms < until["epochMs"],
        "lastLibidoChoice": choice,
    }


def create_dashboard_snapshot(state, config, now_ms=None):
    drives, thoughts, timeline = validate_inputs(state, config)
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    strongest_drive, strongest_value = strongest(drives, DRIVES)
    candidate_drive, candidate_value = strongest(drives, ACTIVE_DRIVES)
    status_code, status_label = pulse_status(state, config, candidate_value)
    solo_view = create_solo_view(state, config, now_ms)
    next_check = state["lastTickAt"]["epochMs"] + config["heartbeatSeconds"] * 1000
    age_seconds = max(0, (now_ms - state["lastTickAt"]["epochMs"]) // 1000)
    recent_window = config["heartbeatSeconds"] * 2 + 30
    pending = state.get("pendingDecision")
    pending_view = None
    if pending is not None:
        drive = pending.get("drive")
        intent = pending.get("intent")
        score = pending.get("score")
        if drive not in ACTIVE_DRIVES or not intent_matches_drive(drive, intent):
            raise ValueError("pending decision is invalid")
        require_number(score, "pending score")
        pending_view = {
            "drive": drive,
            "driveLabel": DRIVE_LABELS[drive],
            "intent": intent,
            "intentLabel": INTENT_LABELS[intent],
            "scorePercent": percentage(score),
            "status": str(pending.get("status", "pending")),
        }
    intent = INTENT_BY_DRIVE[candidate_drive]
    candidate_intent_label = INTENT_LABELS[intent]
    if candidate_drive == "libido" and solo_view["enabled"] and not solo_view["cooldownActive"]:
        candidate_intent_label = "想靠近你或自己处理"
    return {
        "schema": "aru.desire-dashboard.snapshot.v1",
        "generatedAt": iso(now_ms),
        "stateUpdatedAt": state["updatedAt"]["iso"],
        "lastTickAt": state["lastTickAt"]["iso"],
        "nextCheckAt": iso(next_check),
        "heartbeat": {
            "intervalSeconds": config["heartbeatSeconds"],
            "recentlyObserved": age_seconds <= recent_window,
            "ageSeconds": age_seconds,
        },
        "strongest": {
            "drive": strongest_drive,
            "label": DRIVE_LABELS[strongest_drive],
            "valuePercent": percentage(strongest_value),
        },
        "expression": {
            "candidateDrive": candidate_drive,
            "candidateLabel": DRIVE_LABELS[candidate_drive],
            "intent": intent,
            "intentLabel": candidate_intent_label,
            "valuePercent": percentage(candidate_value),
            "thresholdPercent": percentage(config["triggerThreshold"]),
            "code": status_code,
            "label": status_label,
        },
        "drives": [
            {"drive": drive, "label": DRIVE_LABELS[drive], "valuePercent": percentage(drives[drive])}
            for drive in DRIVES
        ],
        "thoughts": [thought_view(thought) for thought in thoughts],
        "timeline": [timeline_view(entry) for entry in timeline[:24]],
        "timelineTotal": len(timeline),
        "pendingDecision": pending_view,
        "solo": solo_view,
        "gates": {
            "observeOnly": bool(config.get("observeOnly", True)),
            "deliveryEnabled": bool(config.get("deliveryEnabled", False)),
        },
    }


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "AruPulse"
    sys_version = ""

    def log_message(self, _format, *_args):
        return

    def send_body(self, status, content_type, body, head_only=False):
        self.send_response(status)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def route(self, head_only=False):
        pathname = urlsplit(self.path).path
        if pathname == "/healthz":
            self.send_body(200, "application/json; charset=utf-8", b'{"status":"ok"}', head_only)
            return
        if pathname == "/api/snapshot":
            state, config = load_snapshot_inputs(self.server.config_path, self.server.data_directory)
            body = json.dumps(
                create_dashboard_snapshot(state, config),
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            self.send_body(200, "application/json; charset=utf-8", body, head_only)
            return
        entry = STATIC_FILES.get(pathname)
        if entry is None:
            self.send_body(404, "application/json; charset=utf-8", b'{"error":"not_found"}', head_only)
            return
        name, content_type = entry
        body = read_regular(self.server.public_directory / name)
        self.send_body(200, content_type, body, head_only)

    def do_GET(self):
        try:
            self.route(False)
        except Exception:
            self.send_body(
                503, "application/json; charset=utf-8",
                b'{"error":"temporarily_unavailable"}',
            )

    def do_HEAD(self):
        try:
            self.route(True)
        except Exception:
            self.send_body(
                503, "application/json; charset=utf-8",
                b'{"error":"temporarily_unavailable"}', True,
            )

    def reject_write(self):
        self.send_body(
            405, "application/json; charset=utf-8",
            b'{"error":"method_not_allowed"}',
        )

    do_POST = reject_write
    do_PUT = reject_write
    do_PATCH = reject_write
    do_DELETE = reject_write
class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def create_server(host, port, config_path, data_directory, public_directory):
    if host != "127.0.0.1":
        raise ValueError("dashboard must bind to 127.0.0.1")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("dashboard port is invalid")
    server = DashboardServer((host, port), DashboardHandler)
    server.config_path = Path(config_path).resolve()
    server.data_directory = Path(data_directory).resolve()
    server.public_directory = Path(public_directory).resolve()
    return server


def main():
    host = os.environ.get("ARU_DESIRE_DASHBOARD_HOST", "127.0.0.1")
    port = int(os.environ.get("ARU_DESIRE_DASHBOARD_PORT", "18760"))
    config_path = os.environ.get("ARU_DESIRE_CONFIG", str(DEFAULT_CONFIG))
    data_directory = os.environ.get("ARU_DESIRE_DATA_DIR", str(DEFAULT_DATA))
    public_directory = os.environ.get("ARU_DESIRE_DASHBOARD_PUBLIC", str(DEFAULT_PUBLIC))
    server = create_server(host, port, config_path, data_directory, public_directory)
    print(json.dumps({"status": "listening", "host": host, "port": port}), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()