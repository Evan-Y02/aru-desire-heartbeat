#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly HEARTBEAT="$TARGET/config/default.json"
readonly DELIVERY="$TARGET/config/aru-delivery.json"
readonly ENABLE_FILE="/etc/aru-desire-heartbeat/external-trigger.enable"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-activation"
ATTEMPT=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
hash_state() { sha256sum "$DATA/state.json" | cut -d ' ' -f 1; }

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: disable-autonomy-once.sh --apply"
for command in node install mktemp stat readlink mv rm systemctl sleep sha256sum cut; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done
for file in "$HEARTBEAT" "$DELIVERY" "$DATA/state.json"; do
  [[ -f "$file" && ! -L "$file" ]] || die "required file is missing or unsafe: $file"
done
if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" &&
    "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 ]] ||
    die "activation backup directory is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/stop.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
install -o root -g root -m 0600 "$HEARTBEAT" "$ATTEMPT/default.json"
install -o root -g root -m 0600 "$DELIVERY" "$ATTEMPT/aru-delivery.json"

systemctl disable --now "$TIMER"
if [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == failed ]]; then
  systemctl reset-failed "$SERVICE"
fi
for attempt in {1..30}; do
  [[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] && break
  sleep 1
done
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service did not become inactive; timer remains disabled"
STATE_BEFORE="$(hash_state)"
install -o root -g root -m 0600 "$DATA/state.json" "$ATTEMPT/state.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
 x.observeOnly=true;x.deliveryEnabled=false;
 fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");
' "$HEARTBEAT" "$ATTEMPT/default.disabled.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
 x.enabled=false;fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");
' "$DELIVERY" "$ATTEMPT/aru-delivery.disabled.json"
install -o root -g root -m 0644 "$ATTEMPT/default.disabled.json" "$HEARTBEAT.new"
install -o root -g root -m 0644 "$ATTEMPT/aru-delivery.disabled.json" "$DELIVERY.new"
mv -fT -- "$HEARTBEAT.new" "$HEARTBEAT"
mv -fT -- "$DELIVERY.new" "$DELIVERY"
rm -f -- "$ENABLE_FILE"

[[ "$(hash_state)" == "$STATE_BEFORE" ]] || die "state changed while stopping"
node -e 'const fs=require("fs");const h=JSON.parse(fs.readFileSync(process.argv[1]));
 const d=JSON.parse(fs.readFileSync(process.argv[2]));
 if(h.observeOnly!==true||h.deliveryEnabled!==false||d.enabled!==false) process.exit(1);
' "$HEARTBEAT" "$DELIVERY" || die "disabled flags were not applied"
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] ||
  die "timer is still enabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] ||
  die "timer is still active"
printf 'phase=stopped\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
printf 'autonomy_stop=PASS\ntimer_enabled=disabled\ntimer_active=inactive\n'
printf 'delivery=disabled\nstate_retained=yes\nbackup=%s\n' "$ATTEMPT"