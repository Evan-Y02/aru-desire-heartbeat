#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly SOURCE="/home/xinchao/private/ChengXiao/desire-heartbeat"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly AUTH="$DATA/dashboard-auth.json"
readonly UNIT_SOURCE="$SOURCE/systemd/aru-desire-dashboard.service"
readonly UNIT_TARGET="/etc/systemd/system/aru-desire-dashboard.service"
readonly SERVICE="aru-desire-dashboard.service"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly DOMAIN="pulse.xinchaonian.duckdns.org"
readonly LOGIN_USERNAME="xinchao"
readonly BACKUP_PARENT="/var/backups/aru-desire-dashboard-login"

ATTEMPT=""
STAGE=""
OLD_MOVED=0
NEW_INSTALLED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

safe_attempt() {
  [[ -n "$ATTEMPT" && "$ATTEMPT" == "$BACKUP_PARENT"/upgrade.* && -d "$ATTEMPT" \
    && ! -L "$ATTEMPT" && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
    && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]]
}

restore_failed_upgrade() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  if safe_attempt; then
    if (( OLD_MOVED == 1 )); then
      (( NEW_INSTALLED == 0 )) || rm -rf -- "$TARGET/dashboard"
      [[ ! -d "$ATTEMPT/original-dashboard" ]] || mv -- "$ATTEMPT/original-dashboard" "$TARGET/dashboard"
      install -o root -g root -m 0644 "$ATTEMPT/original-package.json" "$TARGET/package.json"
    fi
    [[ ! -f "$ATTEMPT/original-service" ]] || install -o root -g root -m 0644 "$ATTEMPT/original-service" "$UNIT_TARGET"
    [[ ! -f "$ATTEMPT/Caddyfile" ]] || install -o root -g root -m 0644 "$ATTEMPT/Caddyfile" "$CADDYFILE"
    if [[ -f "$ATTEMPT/auth-existed" ]]; then
      install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/original-auth.json" "$AUTH"
    else
      rm -f -- "$AUTH"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || true
    systemctl reload caddy >/dev/null 2>&1 || true
    systemctl start "$SERVICE" >/dev/null 2>&1 || true
  fi
  printf 'ERROR: dashboard login upgrade failed; the previous dashboard was restored when possible.\n' >&2
  [[ -z "$ATTEMPT" ]] || printf 'upgrade_attempt=%s\n' "$ATTEMPT" >&2
  exit "$status"
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: upgrade-dashboard-login-once.sh --apply"
for command in node python3 caddy systemctl curl install mktemp stat readlink grep cp mv rm sha256sum chown chmod sleep; do
  need "$command"
done
[[ -d "$SOURCE/dashboard/public" && ! -L "$SOURCE/dashboard/public" ]] || die "source dashboard is missing or unsafe"
[[ -d "$TARGET/dashboard/public" && ! -L "$TARGET/dashboard/public" ]] || die "installed dashboard is missing or unsafe"
[[ -f "$SOURCE/dashboard/server.py" && ! -L "$SOURCE/dashboard/server.py" ]] || die "source dashboard server is unsafe"
[[ -f "$UNIT_SOURCE" && ! -L "$UNIT_SOURCE" ]] || die "source dashboard unit is unsafe"
[[ -f "$UNIT_TARGET" && ! -L "$UNIT_TARGET" ]] || die "installed dashboard unit is unsafe"
[[ -f "$CADDYFILE" && ! -L "$CADDYFILE" ]] || die "Caddyfile is missing or unsafe"
[[ -d "$DATA" && ! -L "$DATA" && "$(stat -c '%U:%G:%a' "$DATA")" == aru-desire:aru-desire:700 ]] \
  || die "production data directory is unsafe"
[[ -f "$DATA/state.json" && ! -L "$DATA/state.json" \
  && "$(stat -c '%U:%G:%a:%h' "$DATA/state.json")" == aru-desire:aru-desire:600:1 ]] \
  || die "production state is missing or unsafe"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat timer must be inactive during dashboard login upgrade"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat service must be inactive during dashboard login upgrade"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == active ]] || die "dashboard service must be active"
grep -Fq "$DOMAIN" "$CADDYFILE" || die "dashboard domain is absent from Caddyfile"

OLD_VERSION="$(node -p "require('$TARGET/package.json').version")"
NEW_VERSION="$(node -p "require('$SOURCE/package.json').version")"
[[ "$OLD_VERSION" == 0.9.6 ]] || die "installed version must be 0.9.6, found $OLD_VERSION"
[[ "$NEW_VERSION" == 0.9.7 ]] || die "source version must be 0.9.7, found $NEW_VERSION"

read -r -s -p "Dashboard password (12-128 characters): " PASSWORD
printf '\n'
[[ ${#PASSWORD} -ge 12 && ${#PASSWORD} -le 128 ]] || die "password length must be 12-128 characters"
read -r -s -p "Repeat dashboard password: " PASSWORD_CONFIRM
printf '\n'
[[ "$PASSWORD" == "$PASSWORD_CONFIRM" ]] || die "passwords do not match"

python3 -m unittest discover -s "$SOURCE/test" -p '*_test.py' >/dev/null
node --test "$SOURCE/test/dashboard-deploy.test.mjs" >/dev/null
node --check "$SOURCE/dashboard/public/app.js"
python3 - "$SOURCE/dashboard/server.py" <<'PY'
import pathlib
import sys
compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")
PY

if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" \
    && "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 \
    && "$(readlink -f "$BACKUP_PARENT")" == "$BACKUP_PARENT" ]] || die "backup parent is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/upgrade.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
safe_attempt || die "dashboard login backup is unsafe"
cp -a -- "$TARGET/dashboard" "$ATTEMPT/original-dashboard"
install -o root -g root -m 0600 "$TARGET/package.json" "$ATTEMPT/original-package.json"
install -o root -g root -m 0600 "$UNIT_TARGET" "$ATTEMPT/original-service"
install -o root -g root -m 0600 "$CADDYFILE" "$ATTEMPT/Caddyfile"
sha256sum "$DATA/state.json" > "$ATTEMPT/state.sha256"
if [[ -e "$AUTH" || -L "$AUTH" ]]; then
  [[ -f "$AUTH" && ! -L "$AUTH" && "$(stat -c '%U:%G:%a:%h' "$AUTH")" == aru-desire:aru-desire:600:1 ]] \
    || die "existing dashboard auth file is unsafe"
  install -o root -g root -m 0600 "$AUTH" "$ATTEMPT/original-auth.json"
  : > "$ATTEMPT/auth-existed"
fi
printf 'phase=prepared\nold_version=%s\nnew_version=%s\n' "$OLD_VERSION" "$NEW_VERSION" > "$ATTEMPT/status"
chmod 0700 "$ATTEMPT/original-dashboard"
chmod 0600 "$ATTEMPT/status" "$ATTEMPT/state.sha256" "$ATTEMPT/original-package.json" \
  "$ATTEMPT/original-service" "$ATTEMPT/Caddyfile"
[[ ! -f "$ATTEMPT/auth-existed" ]] || chmod 0600 "$ATTEMPT/auth-existed" "$ATTEMPT/original-auth.json"

PASSWORD="$PASSWORD" DASHBOARD_LOGIN_USER="$LOGIN_USERNAME" python3 - "$ATTEMPT/auth.candidate" <<'PY'
import base64
import hashlib
import json
import os
import pathlib

password = os.environ.pop("PASSWORD")
username = os.environ["DASHBOARD_LOGIN_USER"]
salt = os.urandom(16)
record = {
    "schema": "aru.desire-dashboard.auth.v1",
    "version": 1,
    "username": username,
    "salt": base64.b64encode(salt).decode("ascii"),
    "digest": hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=2 ** 14, r=8, p=1, dklen=32,
    ).hex(),
}
pathlib.Path(os.sys.argv[1]).write_text(json.dumps(record, separators=(",", ":")) + "\n", encoding="utf-8")
PY
unset PASSWORD PASSWORD_CONFIRM
chmod 0600 "$ATTEMPT/auth.candidate"

python3 - "$CADDYFILE" "$ATTEMPT/Caddyfile.candidate" "$DOMAIN" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
domain = sys.argv[3]
marker = domain + " {"
if source.count(marker) != 1:
    raise SystemExit("dashboard domain block is ambiguous")
start = source.index(marker)
opening = source.index("{", start)
depth = 0
closing = None
for index in range(opening, len(source)):
    if source[index] == "{":
        depth += 1
    elif source[index] == "}":
        depth -= 1
        if depth == 0:
            closing = index
            break
if closing is None:
    raise SystemExit("dashboard domain block is incomplete")
block = source[start:closing + 1]
match = re.search(r"(?m)^[ \t]*(?:basic_auth|basicauth)[ \t]*\{", block)
if match is None:
    raise SystemExit("basic authentication block was not found")
brace = block.index("{", match.start())
depth = 0
auth_end = None
for index in range(brace, len(block)):
    if block[index] == "{":
        depth += 1
    elif block[index] == "}":
        depth -= 1
        if depth == 0:
            auth_end = index + 1
            break
if auth_end is None:
    raise SystemExit("basic authentication block is incomplete")
line_start = block.rfind("\n", 0, match.start()) + 1
line_end = auth_end
while line_end < len(block) and block[line_end] in " \t":
    line_end += 1
if line_end < len(block) and block[line_end] == "\n":
    line_end += 1
block = block[:line_start] + block[line_end:]
if "reverse_proxy 127.0.0.1:18760" not in block or re.search(r"\b(?:basic_auth|basicauth)\b", block):
    raise SystemExit("dashboard domain block validation failed")
candidate = source[:start] + block + source[closing + 1:]
pathlib.Path(sys.argv[2]).write_text(candidate, encoding="utf-8")
PY
chmod 0600 "$ATTEMPT/Caddyfile.candidate"
caddy validate --config "$ATTEMPT/Caddyfile.candidate" --adapter caddyfile >/dev/null

STAGE="$(mktemp -d /opt/.aru-desire-dashboard.XXXXXXXXXXXXXXXX)"
chown root:root "$STAGE"
chmod 0755 "$STAGE"
install -d -o root -g root -m 0755 "$STAGE/public"
install -o root -g root -m 0755 "$SOURCE/dashboard/server.py" "$STAGE/server.py"
for file in "$SOURCE"/dashboard/public/*; do
  [[ -f "$file" && ! -L "$file" ]] || die "dashboard asset is unsafe"
  install -o root -g root -m 0644 "$file" "$STAGE/public/${file##*/}"
done

trap restore_failed_upgrade EXIT ERR INT TERM
systemctl stop "$SERVICE"
mv -- "$TARGET/dashboard" "$ATTEMPT/installed-dashboard.replaced"
OLD_MOVED=1
mv -- "$STAGE" "$TARGET/dashboard"
STAGE=""
NEW_INSTALLED=1
install -o root -g root -m 0644 "$SOURCE/package.json" "$TARGET/package.json"
install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/auth.candidate" "$AUTH"
install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
install -o root -g root -m 0644 "$ATTEMPT/Caddyfile.candidate" "$CADDYFILE"
systemctl daemon-reload
systemctl start "$SERVICE"

LOCAL_READY=0
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:18760/healthz >/dev/null 2>&1; then
    LOCAL_READY=1
    break
  fi
  sleep 1
done
(( LOCAL_READY == 1 )) || die "dashboard did not become ready within 15 seconds"
systemctl reload caddy
PUBLIC_ROOT="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/")"
PUBLIC_SESSION="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/api/session")"
PUBLIC_SNAPSHOT="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/api/snapshot")"
[[ "$PUBLIC_ROOT" == 200 ]] || die "public dashboard returned HTTP $PUBLIC_ROOT"
[[ "$PUBLIC_SESSION" == 200 ]] || die "public session endpoint returned HTTP $PUBLIC_SESSION"
[[ "$PUBLIC_SNAPSHOT" == 401 ]] || die "protected snapshot returned HTTP $PUBLIC_SNAPSHOT"
sha256sum --check "$ATTEMPT/state.sha256" >/dev/null || die "production state changed during dashboard login upgrade"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] || die "heartbeat timer unexpectedly changed"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] || die "heartbeat service unexpectedly changed"

printf 'phase=upgraded\nold_version=%s\nnew_version=%s\n' "$OLD_VERSION" "$NEW_VERSION" > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM
printf 'dashboard_login_upgrade=PASS\nold_version=%s\nnew_version=%s\n' "$OLD_VERSION" "$NEW_VERSION"
printf 'url=https://%s\nusername=%s\nauthentication=web_session\n' "$DOMAIN" "$LOGIN_USERNAME"
printf 'production_state_unchanged=yes\nheartbeat_timer=inactive\ndashboard=active\nbackup=%s\n' "$ATTEMPT"
printf 'rollback_command=sudo %s/scripts/rollback-dashboard-login.sh %s\n' "$SOURCE" "$ATTEMPT"
