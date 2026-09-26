#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly ATTEMPT="${1:-}"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly AUTH="$DATA/dashboard-auth.json"
readonly UNIT_TARGET="/etc/systemd/system/aru-desire-dashboard.service"
readonly SERVICE="aru-desire-dashboard.service"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly BACKUP_PARENT="/var/backups/aru-desire-dashboard-login"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$ATTEMPT" == "$BACKUP_PARENT"/upgrade.* && -d "$ATTEMPT" && ! -L "$ATTEMPT" \
  && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
  && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]] || die "dashboard login backup path is invalid"
grep -qx 'phase=upgraded' "$ATTEMPT/status" || die "dashboard login backup is not eligible for rollback"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat timer must be inactive during rollback"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat service must be inactive during rollback"
[[ -d "$ATTEMPT/original-dashboard" && ! -L "$ATTEMPT/original-dashboard" ]] || die "original dashboard is missing"

CURRENT="$ATTEMPT/current-dashboard.replaced"
[[ ! -e "$CURRENT" && ! -L "$CURRENT" ]] || die "rollback backup was already used"
systemctl stop "$SERVICE"
mv -- "$TARGET/dashboard" "$CURRENT"
mv -- "$ATTEMPT/original-dashboard" "$TARGET/dashboard"
install -o root -g root -m 0644 "$ATTEMPT/original-package.json" "$TARGET/package.json"
install -o root -g root -m 0644 "$ATTEMPT/original-service" "$UNIT_TARGET"
install -o root -g root -m 0644 "$ATTEMPT/Caddyfile" "$CADDYFILE"
if [[ -f "$ATTEMPT/auth-existed" ]]; then
  install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/original-auth.json" "$AUTH"
else
  rm -f -- "$AUTH"
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
systemctl daemon-reload
systemctl start "$SERVICE"
systemctl reload caddy
printf 'phase=rolled-back\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
printf 'dashboard_login_rollback=PASS\nversion=0.9.6\ndashboard=active\n'
