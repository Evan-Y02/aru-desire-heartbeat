#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
import secrets
import stat
import threading
import time
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "default.json"
DEFAULT_DATA = ROOT / "data"
DEFAULT_PUBLIC = ROOT / "dashboard" / "public"
DEFAULT_AUTH = DEFAULT_DATA / "dashboard-auth.json"

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
    "idle": "继续积累", "withheld": "暂时没开口",
    "held_disabled": "意图被门禁留住", "submitting": "正在提交",
    "submitted": "来找你了", "held_claimed": "已避免重复发送",
    "delivery_failed": "发送未确认", "solo_completed": "自己处理了",
    "solo_selected": "已选择 Solo，等待完整过程",
    "pending_expired": "等待意图已过期",
}
TIMELINE_REASON_LABELS = {
    "clock-anomaly": "时钟异常", "pending-decision": "已有待处理意图",
    "fatigue-gate": "疲劳门禁", "below-trigger-threshold": "尚未达到门槛",
    "observe-only": "仅观察", "delivery-disabled": "发送尚未开启",
    "delivery-adapter-disabled": "Aru 传输尚未开启",
    "expression-withheld": "这次自主选择不说",
    "expression-chosen": "这次自主选择表达",
    "withheld-first": "连续第 1 次没开口",
    "withheld-second": "连续第 2 次没开口",
    "withheld-third": "连续第 3 次没开口；下次达到门槛必须联系",
    "forced-after-three-withholds": "已到沉默上限，必须联系",
    "forced-at-full": "欲望已满，必须联系",
    "delivery-accepted": "Aru 已接收",
    "delivery-already-claimed": "已阻止重复发送", "delivery-failed": "发送结果未确认",
    "solo-completed": "Solo 已完成",
    "solo-session-selected": "Solo Session 已建立，尚未视为完成",
    "pending-expired": "等待超过安全时限，未作结算",
    "pending-cooldown": "等待冷却后重新评估",
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
SESSION_TTL_SECONDS = 12 * 60 * 60
LOGIN_ATTEMPT_LIMIT = 5
LOGIN_ATTEMPT_WINDOW_SECONDS = 10 * 60


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


def load_auth_record(path):
    record = read_json(path, private=True)
    required = {"schema", "version", "username", "salt", "digest"}
    if set(record) != required or record.get("schema") != "aru.desire-dashboard.auth.v1":
        raise ValueError("auth record is invalid")
    if record.get("version") != 1 or not isinstance(record.get("username"), str):
        raise ValueError("auth record is invalid")
    if not 1 <= len(record["username"]) <= 128:
        raise ValueError("auth record is invalid")
    try:
        salt = base64.b64decode(record["salt"], validate=True)
        digest = bytes.fromhex(record["digest"])
    except (ValueError, TypeError):
        raise ValueError("auth record is invalid") from None
    if len(salt) != 16 or len(digest) != 32:
        raise ValueError("auth record is invalid")
    return record


def password_digest(password, salt):
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=2 ** 14, r=8, p=1, dklen=32,
    )


def verify_credentials(record, username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        return False
    if not 1 <= len(username) <= 128 or not 1 <= len(password) <= 256:
        return False
    expected = bytes.fromhex(record["digest"])
    actual = password_digest(password, base64.b64decode(record["salt"]))
    return hmac.compare_digest(username, record["username"]) and hmac.compare_digest(actual, expected)


def load_snapshot_inputs(config_path, data_directory):
    directory = Path(data_directory)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError("unsafe data directory")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("unsafe data directory mode")
    config = read_json(config_path)
    state = read_json(directory / "state.json", private=True)
    interaction = None
    if config.get("soloSessionsEnabled") is True:
        interaction = read_json(directory / "interaction-state.json", private=True)
    return state, config, interaction
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
    if source not in ("automatic", "manual", "event"):
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
        "sourceLabel": (
            "自然形成" if source == "automatic" else
            "互动事件" if source == "event" else "手动记录"
        ),
        "intensityPercent": percentage(intensity),
        "text": content,
        "updatedAt": updated["iso"],
    }


def timeline_view(entry):
    expected_fields = {
        "at", "nextCheckAt", "outcome", "drive", "intent",
        "score", "willingness", "reasons", "drives",
    }
    allowed_fields = expected_fields | {"decisionFingerprint"}
    if (not isinstance(entry, dict) or not expected_fields.issubset(entry)
            or not set(entry).issubset(allowed_fields)):
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
        "reasonCodes": list(reasons),
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


def solo_session_view(interaction):
    if interaction is None:
        return None
    if interaction.get("schema") != "aru.desire-heartbeat.interaction-state.v1":
        raise ValueError("interaction state is invalid")
    store = interaction.get("soloSessions")
    sessions = None if not isinstance(store, dict) else store.get("sessions")
    if not isinstance(sessions, list) or len(sessions) > 24:
        raise ValueError("solo sessions are invalid")
    if not sessions:
        return None
    session = sessions[-1]
    if not isinstance(session, dict):
        raise ValueError("solo session is invalid")
    text_fields = (
        "triggerReason", "thought", "processSummary", "afterThought",
    )
    for field in text_fields:
        value = session.get(field)
        if value is not None and (not isinstance(value, str) or not 0 < len(value) <= 800):
            raise ValueError("solo session text is invalid")
        if isinstance(value, str) and any(marker in value.lower() for marker in (
                "bearer", "password", "api key", "auth.json", "private key", "digest", "账本")):
            raise ValueError("solo session text is unsafe")
    quality = session.get("climaxQuality")
    output = session.get("output")
    if quality is not None:
        require_number(quality, "solo climax quality")
    if output is not None:
        require_number(output, "solo output")
    selected = session.get("selectedAt")
    ended = session.get("endedAt")
    if not isinstance(selected, dict) or not isinstance(selected.get("iso"), str):
        raise ValueError("solo selected time is invalid")
    if ended is not None and (not isinstance(ended, dict) or not isinstance(ended.get("iso"), str)):
        raise ValueError("solo ended time is invalid")
    return {
        "time": selected["iso"] if ended is None else ended["iso"],
        "triggerReason": session.get("triggerReason"),
        "thought": session.get("thought"),
        "processSummary": session.get("processSummary"),
        "released": session.get("released") is True,
        "outcome": session.get("outcome"),
        "climaxQualityLabel": None if quality is None else (
            "高" if quality >= 0.8 else "中" if quality >= 0.5 else "低"
        ),
        "outputLabel": None if output is None else (
            "多" if output >= 0.67 else "中" if output >= 0.34 else "少"
        ),
        "afterThought": session.get("afterThought"),
    }


def create_dashboard_snapshot(state, config, now_ms=None, interaction=None):
    drives, thoughts, timeline = validate_inputs(state, config)
    expression_state = state.get("expression") or {"consecutiveWithholds": 0}
    if (not isinstance(expression_state, dict) or
            not isinstance(expression_state.get("consecutiveWithholds"), int) or
            expression_state["consecutiveWithholds"] < 0):
        raise ValueError("expression state is invalid")
    expression_config = config.get("expression")
    if (not isinstance(expression_config, dict) or
            not isinstance(expression_config.get("maxConsecutiveWithholds"), int) or
            expression_config["maxConsecutiveWithholds"] < 1):
        raise ValueError("expression config is invalid")
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
    snapshot = {
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
            "consecutiveWithholds": expression_state["consecutiveWithholds"],
            "maxConsecutiveWithholds": expression_config["maxConsecutiveWithholds"],
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
    if config.get("soloSessionsEnabled") is True:
        snapshot["soloSession"] = solo_session_view(interaction)
    return snapshot


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "AruPulse"
    sys_version = ""

    def log_message(self, _format, *_args):
        return

    def send_body(self, status, content_type, body, head_only=False, extra_headers=None):
        self.send_response(status)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def send_json(self, status, value, head_only=False, extra_headers=None):
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_body(status, "application/json; charset=utf-8", body, head_only, extra_headers)

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        item = cookie.get("aru_desire_session")
        return "" if item is None else item.value

    def authenticated(self):
        token = self.session_token()
        if not token or len(token) > 256:
            return False
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.time()
        with self.server.auth_lock:
            expires_at = self.server.sessions.get(key)
            if expires_at is None or expires_at <= now:
                self.server.sessions.pop(key, None)
                return False
        return True

    def client_key(self):
        return str(self.client_address[0])[:80]

    def rate_limited(self):
        now = time.time()
        key = self.client_key()
        with self.server.auth_lock:
            recent = [stamp for stamp in self.server.login_attempts.get(key, [])
                      if now - stamp < LOGIN_ATTEMPT_WINDOW_SECONDS]
            self.server.login_attempts[key] = recent
            return len(recent) >= LOGIN_ATTEMPT_LIMIT

    def record_login_failure(self):
        key = self.client_key()
        with self.server.auth_lock:
            recent = self.server.login_attempts.get(key, [])
            recent.append(time.time())
            self.server.login_attempts[key] = recent[-LOGIN_ATTEMPT_LIMIT:]

    def session_cookie(self, token, max_age):
        return (
            "aru_desire_session=" + token + "; Path=/; Max-Age=" + str(max_age) +
            "; HttpOnly; Secure; SameSite=Strict"
        )

    def read_json_request(self):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise ValueError("invalid content length")
        length = int(raw_length)
        if length < 1 or length > 4096:
            raise ValueError("invalid content length")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("invalid JSON")
        return value

    def route(self, head_only=False):
        pathname = urlsplit(self.path).path
        if pathname == "/healthz":
            self.send_body(200, "application/json; charset=utf-8", b'{"status":"ok"}', head_only)
            return
        if pathname == "/api/session":
            self.send_json(200, {
                "authenticated": self.authenticated(),
                "username": self.server.auth_record["username"],
            }, head_only)
            return
        if pathname == "/api/snapshot":
            if not self.authenticated():
                self.send_json(401, {"error": "unauthorized"}, head_only)
                return
            state, config, interaction = load_snapshot_inputs(
                self.server.config_path, self.server.data_directory,
            )
            body = json.dumps(
                create_dashboard_snapshot(state, config, interaction=interaction),
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

    def do_POST(self):
        try:
            pathname = urlsplit(self.path).path
            if pathname == "/api/login":
                if self.rate_limited():
                    self.send_json(429, {"error": "尝试次数过多，请稍后再试。"},
                                   extra_headers={"Retry-After": str(LOGIN_ATTEMPT_WINDOW_SECONDS)})
                    return
                try:
                    payload = self.read_json_request()
                except Exception:
                    self.send_json(400, {"error": "请求格式不正确。"})
                    return
                if not verify_credentials(
                    self.server.auth_record,
                    payload.get("username"),
                    payload.get("password"),
                ):
                    self.record_login_failure()
                    self.send_json(401, {"error": "用户名或密码不正确。"})
                    return
                with self.server.auth_lock:
                    self.server.login_attempts.pop(self.client_key(), None)
                    token = secrets.token_urlsafe(32)
                    key = hashlib.sha256(token.encode("utf-8")).hexdigest()
                    self.server.sessions[key] = time.time() + SESSION_TTL_SECONDS
                self.send_json(200, {"ok": True}, extra_headers={
                    "Set-Cookie": self.session_cookie(token, SESSION_TTL_SECONDS),
                })
                return
            if pathname == "/api/logout":
                token = self.session_token()
                if token:
                    key = hashlib.sha256(token.encode("utf-8")).hexdigest()
                    with self.server.auth_lock:
                        self.server.sessions.pop(key, None)
                self.send_json(200, {"ok": True}, extra_headers={
                    "Set-Cookie": self.session_cookie("", 0),
                })
                return
            self.reject_write()
        except Exception:
            self.send_json(503, {"error": "temporarily_unavailable"})

    def reject_write(self):
        self.send_body(
            405, "application/json; charset=utf-8",
            b'{"error":"method_not_allowed"}',
        )

    do_PUT = reject_write
    do_PATCH = reject_write
    do_DELETE = reject_write
class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def create_server(host, port, config_path, data_directory, public_directory, auth_path):
    if host != "127.0.0.1":
        raise ValueError("dashboard must bind to 127.0.0.1")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("dashboard port is invalid")
    auth_record = load_auth_record(Path(auth_path).resolve())
    server = DashboardServer((host, port), DashboardHandler)
    server.config_path = Path(config_path).resolve()
    server.data_directory = Path(data_directory).resolve()
    server.public_directory = Path(public_directory).resolve()
    server.auth_record = auth_record
    server.sessions = {}
    server.login_attempts = {}
    server.auth_lock = threading.Lock()
    return server


def main():
    host = os.environ.get("ARU_DESIRE_DASHBOARD_HOST", "127.0.0.1")
    port = int(os.environ.get("ARU_DESIRE_DASHBOARD_PORT", "18760"))
    config_path = os.environ.get("ARU_DESIRE_CONFIG", str(DEFAULT_CONFIG))
    data_directory = os.environ.get("ARU_DESIRE_DATA_DIR", str(DEFAULT_DATA))
    public_directory = os.environ.get("ARU_DESIRE_DASHBOARD_PUBLIC", str(DEFAULT_PUBLIC))
    auth_path = os.environ.get("ARU_DESIRE_DASHBOARD_AUTH", str(DEFAULT_AUTH))
    server = create_server(host, port, config_path, data_directory, public_directory, auth_path)
    print(json.dumps({"status": "listening", "host": host, "port": port}), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
