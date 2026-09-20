#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly ATTEMPT="${1:-}"
readonly SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly HEARTBEAT="$TARGET/config/default.json"
readonly DELIVERY="$TARGET/config/aru-delivery.json"
readonly ENABLE_FILE="/etc/aru-desire-heartbeat/external-trigger.enable"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-activation"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
restore_file() {
  local backup=$1 target=$2 owner=$3 group=$4 mode=$5
  install -o "$owner" -g "$group" -m "$mode" "$backup" "$target.restore"
  mv -fT -- "$target.restore" "$target"
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
for command in node install stat readlink mv rm systemctl sleep grep; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done
[[ "$ATTEMPT" == "$BACKUP_PARENT"/enable.* &&
  -d "$ATTEMPT" && ! -L "$ATTEMPT" &&
  "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 &&
  "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]] ||
  die "activation backup path is invalid"
[[ -f "$ATTEMPT/status" && ! -L "$ATTEMPT/status" ]] ||
  die "activation status is missing"
grep -qx 'phase=enabled' "$ATTEMPT/status" ||
  die "activation backup is not eligible for rollback"
for file in default.json aru-delivery.json state.json; do
  [[ -f "$ATTEMPT/$file" && ! -L "$ATTEMPT/$file" ]] ||
    die "activation backup is incomplete"
done
[[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed application is unsafe"
[[ -d "$DATA" && ! -L "$DATA" ]] || die "state directory is unsafe"

systemctl disable --now "$TIMER"
for attempt in {1..30}; do
  [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] && break
  sleep 1
done
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service did not become inactive; timer remains disabled"
restore_file "$ATTEMPT/default.json" "$HEARTBEAT" root root 0644
restore_file "$ATTEMPT/aru-delivery.json" "$DELIVERY" root root 0644
restore_file "$ATTEMPT/state.json" "$DATA/state.json" aru-desire aru-desire 0600
rm -f -- "$ENABLE_FILE"

node -e 'const fs=require("fs");const h=JSON.parse(fs.readFileSync(process.argv[1]));
 const d=JSON.parse(fs.readFileSync(process.argv[2]));
 if(h.observeOnly!==true||h.deliveryEnabled!==false||d.enabled!==false) process.exit(1);
' "$HEARTBEAT" "$DELIVERY" || die "disabled configuration was not restored"
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] ||
  die "timer is still enabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] ||
  die "timer is still active"
printf 'phase=rolled-back\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
printf 'autonomy_rollback=PASS\ntimer_enabled=disabled\n'
printf 'timer_active=inactive\ndelivery=disabled\n'
printf 'pre_activation_state_restored=yes\n'