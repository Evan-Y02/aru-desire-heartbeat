#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly ATTEMPT="${1:-}"
readonly SOURCE="/home/xinchao/private/ChengXiao/desire-heartbeat"
readonly SERVICE="aru-desire-dashboard.service"
readonly UNIT_TARGET="/etc/systemd/system/aru-desire-dashboard.service"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly AUTH="/var/lib/aru-desire-heartbeat/dashboard-auth.json"
readonly BACKUP_PARENT="/var/backups/aru-desire-dashboard"
readonly DOMAIN="pulse.xinchaonian.duckdns.org"

CURRENT_CADDY="$ATTEMPT/Caddyfile.replaced"
CADDY_RESTORED=0
UNIT_REMOVED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

restore_failed_rollback() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  if (( CADDY_RESTORED == 1 )) && [[ -f "$CURRENT_CADDY" && ! -L "$CURRENT_CADDY" ]]; then
    install -o root -g root -m 0644 "$CURRENT_CADDY" "$CADDYFILE"
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
    systemctl reload caddy >/dev/null 2>&1
  fi
  if (( UNIT_REMOVED == 1 )); then
    install -o root -g root -m 0644 "$SOURCE/systemd/$SERVICE" "$UNIT_TARGET"
    systemctl daemon-reload >/dev/null 2>&1
    systemctl enable --now "$SERVICE" >/dev/null 2>&1
  fi
  printf 'ERROR: dashboard rollback failed; installed configuration was restored when possible.\n' >&2
  exit "$status"
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
for command in caddy systemctl curl install stat readlink grep mv rm sha256sum; do need "$command"; done
[[ "$ATTEMPT" == "$BACKUP_PARENT"/install.* && -d "$ATTEMPT" && ! -L "$ATTEMPT" \
  && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
  && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]] || die "dashboard backup path is invalid"
[[ -f "$ATTEMPT/status" && ! -L "$ATTEMPT/status" ]] || die "dashboard backup status is missing"
grep -qx 'phase=installed' "$ATTEMPT/status" || die "dashboard backup is not eligible for rollback"
[[ -f "$ATTEMPT/Caddyfile" && ! -L "$ATTEMPT/Caddyfile" ]] || die "original Caddyfile is missing"
sha256sum --check "$ATTEMPT/Caddyfile.sha256" >/dev/null || die "original Caddyfile checksum failed"
[[ -f "$CADDYFILE" && ! -L "$CADDYFILE" ]] || die "current Caddyfile is unsafe"
[[ -f "$UNIT_TARGET" && ! -L "$UNIT_TARGET" ]] || die "dashboard unit is missing or unsafe"
[[ ! -e "$CURRENT_CADDY" && ! -L "$CURRENT_CADDY" ]] || die "backup was already used"
grep -Fq "$DOMAIN" "$CADDYFILE" || die "dashboard domain is absent from current Caddyfile"
caddy validate --config "$ATTEMPT/Caddyfile" --adapter caddyfile >/dev/null
trap restore_failed_rollback EXIT ERR INT TERM
systemctl disable --now "$SERVICE"
rm -f -- "$UNIT_TARGET"
UNIT_REMOVED=1
systemctl daemon-reload
mv -- "$CADDYFILE" "$CURRENT_CADDY"
install -o root -g root -m 0644 "$ATTEMPT/Caddyfile" "$CADDYFILE"
CADDY_RESTORED=1
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
systemctl reload caddy
rm -f -- "$AUTH"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] \
  || die "dashboard service is still active"
[[ "$(systemctl is-active aru-desire-heartbeat.timer 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat timer unexpectedly changed"
[[ "$(systemctl is-active aru-desire-heartbeat.service 2>/dev/null || true)" == inactive ]] \
  || die "heartbeat service unexpectedly changed"
printf 'phase=rolled-back\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM

printf 'dashboard_rollback=PASS\ndashboard_service=inactive\n'
printf 'heartbeat_timer=inactive\nheartbeat_service=inactive\n'
printf 'desire_application_unchanged=yes\n'
