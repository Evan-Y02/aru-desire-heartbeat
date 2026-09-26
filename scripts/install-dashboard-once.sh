#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly SOURCE="/home/xinchao/private/ChengXiao/desire-heartbeat"
readonly APP="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly AUTH="$DATA/dashboard-auth.json"
readonly UNIT_SOURCE="$SOURCE/systemd/aru-desire-dashboard.service"
readonly UNIT_TARGET="/etc/systemd/system/aru-desire-dashboard.service"
readonly SERVICE="aru-desire-dashboard.service"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly DOMAIN="pulse.xinchaonian.duckdns.org"
readonly LOGIN_USERNAME="xinchao"
readonly BACKUP_PARENT="/var/backups/aru-desire-dashboard"

ATTEMPT=""
CADDY_CHANGED=0
UNIT_INSTALLED=0
SERVICE_STARTED=0
AUTH_CREATED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

safe_attempt() {
  [[ -n "$ATTEMPT" && "$ATTEMPT" == "$BACKUP_PARENT"/install.* && -d "$ATTEMPT" \
    && ! -L "$ATTEMPT" && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
    && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]]
}
restore_failed_install() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  (( SERVICE_STARTED == 0 )) || systemctl disable --now "$SERVICE" >/dev/null 2>&1
  (( AUTH_CREATED == 0 )) || rm -f -- "$AUTH"
  (( UNIT_INSTALLED == 0 )) || rm -f -- "$UNIT_TARGET"
  systemctl daemon-reload >/dev/null 2>&1
  if (( CADDY_CHANGED == 1 )) && safe_attempt && [[ -f "$ATTEMPT/Caddyfile" ]]; then
    install -o root -g root -m 0644 "$ATTEMPT/Caddyfile" "$CADDYFILE"
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
    systemctl reload caddy >/dev/null 2>&1
  fi
  printf 'ERROR: dashboard installation failed; rollback was attempted.\n' >&2
  [[ -z "$ATTEMPT" ]] || printf 'install_attempt=%s\n' "$ATTEMPT" >&2
  exit "$status"
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: install-dashboard-once.sh --apply"
for command in caddy systemctl curl install mktemp stat readlink grep cp rm sha256sum python3 sleep; do
  need "$command"
done
[[ -d "$APP/dashboard/public" && ! -L "$APP/dashboard/public" ]] \
  || die "dashboard application is not installed; upgrade to 0.7.0 first"
[[ -f "$APP/dashboard/server.py" && ! -L "$APP/dashboard/server.py" ]] \
  || die "dashboard server is missing or unsafe"
[[ -f "$UNIT_SOURCE" && ! -L "$UNIT_SOURCE" ]] || die "dashboard unit source is missing or unsafe"
[[ -d "$DATA" && ! -L "$DATA" && "$(stat -c '%U:%G:%a' "$DATA")" == aru-desire:aru-desire:700 ]] \
  || die "production data directory is unsafe"
[[ -f "$DATA/state.json" && ! -L "$DATA/state.json" \
  && "$(stat -c '%U:%G:%a:%h' "$DATA/state.json")" == aru-desire:aru-desire:600:1 ]] \
  || die "production state is missing or unsafe"
[[ -f "$CADDYFILE" && ! -L "$CADDYFILE" ]] || die "Caddyfile is missing or unsafe"
[[ ! -e "$AUTH" && ! -L "$AUTH" ]] || die "dashboard auth file already exists"
[[ ! -e "$UNIT_TARGET" && ! -L "$UNIT_TARGET" ]] || die "dashboard unit already exists"
if systemctl cat "$SERVICE" >/dev/null 2>&1; then die "dashboard service already exists"; fi
grep -Fq "$DOMAIN" "$CADDYFILE" && die "dashboard domain already exists in Caddyfile"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat timer must remain inactive during dashboard installation"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat service must remain inactive during dashboard installation"
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null

if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" \
    && "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 \
    && "$(readlink -f "$BACKUP_PARENT")" == "$BACKUP_PARENT" ]] \
    || die "backup parent is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/install.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
safe_attempt || die "dashboard backup is unsafe"
install -o root -g root -m 0600 "$CADDYFILE" "$ATTEMPT/Caddyfile"
sha256sum "$ATTEMPT/Caddyfile" > "$ATTEMPT/Caddyfile.sha256"
printf 'phase=prepared\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status" "$ATTEMPT/Caddyfile.sha256"

read -r -s -p "New dashboard password (12-128 characters): " PASSWORD
printf '\n'
[[ ${#PASSWORD} -ge 12 && ${#PASSWORD} -le 128 ]] || die "password length must be 12-128 characters"
read -r -s -p "Repeat dashboard password: " PASSWORD_CONFIRM
printf '\n'
[[ "$PASSWORD" == "$PASSWORD_CONFIRM" ]] || die "passwords do not match"
PASSWORD="$PASSWORD" DASHBOARD_LOGIN_USER="$LOGIN_USERNAME" python3 - "$ATTEMPT/auth.candidate" <<'PY'
import base64
import hashlib
import json
import os
import pathlib
import sys

password = os.environ.pop("PASSWORD")
salt = os.urandom(16)
record = {
    "schema": "aru.desire-dashboard.auth.v1",
    "version": 1,
    "username": os.environ["DASHBOARD_LOGIN_USER"],
    "salt": base64.b64encode(salt).decode("ascii"),
    "digest": hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32).hex(),
}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, separators=(",", ":")) + "\n", encoding="utf-8")
PY
unset PASSWORD PASSWORD_CONFIRM
chmod 0600 "$ATTEMPT/auth.candidate"

CANDIDATE="$ATTEMPT/Caddyfile.candidate"
cp -- "$CADDYFILE" "$CANDIDATE"
printf '\n%s {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:18760\n}\n' "$DOMAIN" >> "$CANDIDATE"
chmod 0600 "$CANDIDATE"
caddy validate --config "$CANDIDATE" --adapter caddyfile >/dev/null
trap restore_failed_install EXIT ERR INT TERM
install -o root -g root -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
UNIT_INSTALLED=1
systemctl daemon-reload
install -o root -g root -m 0644 "$CANDIDATE" "$CADDYFILE"
CADDY_CHANGED=1
install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/auth.candidate" "$AUTH"
AUTH_CREATED=1
systemctl enable --now "$SERVICE"
SERVICE_STARTED=1
LOCAL_READY=0
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:18760/healthz >/dev/null 2>&1; then
    LOCAL_READY=1
    break
  fi
  if [[ "$(systemctl is-failed "$SERVICE" 2>/dev/null || true)" == failed ]]; then
    systemctl status "$SERVICE" --no-pager >&2 || true
    die "dashboard service failed during startup"
  fi
  sleep 1
done
if (( LOCAL_READY == 0 )); then
  systemctl status "$SERVICE" --no-pager >&2 || true
  die "dashboard did not become ready within 15 seconds"
fi
systemctl reload caddy
PUBLIC_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --retry 5 --retry-all-errors --retry-delay 2 --max-time 10 "https://$DOMAIN/")"
[[ "$PUBLIC_STATUS" == 200 ]] || die "public dashboard returned HTTP $PUBLIC_STATUS"
SESSION_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/api/session")"
SNAPSHOT_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$DOMAIN/api/snapshot")"
[[ "$SESSION_STATUS" == 200 ]] || die "public session endpoint returned HTTP $SESSION_STATUS"
[[ "$SNAPSHOT_STATUS" == 401 ]] || die "protected snapshot endpoint returned HTTP $SNAPSHOT_STATUS"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat timer unexpectedly changed"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat service unexpectedly changed"
printf 'phase=installed\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM

printf 'dashboard_install=PASS\nurl=https://%s\nusername=%s\nauthentication=web_session\n' \
  "$DOMAIN" "$LOGIN_USERNAME"
printf 'heartbeat_timer=inactive\nheartbeat_service=inactive\nbackup=%s\n' "$ATTEMPT"
printf 'rollback_command=sudo %s/scripts/rollback-dashboard.sh %s\n' "$SOURCE" "$ATTEMPT"
