#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat"
readonly ACTIVE="/var/lib/aru-desire-heartbeat-install-active"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: uninstall.sh --apply"
for command in systemctl stat readlink mv rm install; do command -v "$command" >/dev/null || die "missing command: $command"; done
[[ -f "$ACTIVE" && ! -L "$ACTIVE" && "$(stat -c '%U:%G:%a' "$ACTIVE")" == root:root:600 ]] \
  || die "active marker is missing or unsafe"
IFS='=' read -r key ATTEMPT < "$ACTIVE"
[[ "$key" == attempt && "$ATTEMPT" == "$BACKUP_PARENT"/attempt.* && -d "$ATTEMPT" && ! -L "$ATTEMPT" \
  && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 ]] || die "active marker target is invalid"
[[ "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]] || die "attempt path traverses a link"

systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
systemctl stop "$SERVICE" >/dev/null 2>&1 || true
[[ ! -e "$TARGET" ]] || { [[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed target is unsafe"; rm -rf -- "$TARGET"; }
[[ ! -d "$ATTEMPT/original-app" ]] || mv -- "$ATTEMPT/original-app" "$TARGET"
rm -f -- "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER"
[[ ! -f "$ATTEMPT/$SERVICE" ]] || install -o root -g root -m 0644 "$ATTEMPT/$SERVICE" "$UNIT_DIR/$SERVICE"
[[ ! -f "$ATTEMPT/$TIMER" ]] || install -o root -g root -m 0644 "$ATTEMPT/$TIMER" "$UNIT_DIR/$TIMER"
systemctl daemon-reload
rm -f -- "$ACTIVE"
printf 'phase=uninstalled-data-retained\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
printf 'UNINSTALLED; persistent data retained at %s\n' "$DATA"