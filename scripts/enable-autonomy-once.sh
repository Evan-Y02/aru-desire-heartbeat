#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="/etc/systemd/system"
readonly HEARTBEAT="$TARGET/config/default.json"
readonly DELIVERY="$TARGET/config/aru-delivery.json"
readonly CREDENTIAL="$DATA/external-trigger.send-credential"
readonly ENABLE_DIR="/etc/aru-desire-heartbeat"
readonly ENABLE_FILE="$ENABLE_DIR/external-trigger.enable"
readonly ENABLE_MAGIC="aru-desire-heartbeat-external-trigger-v1"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-activation"
readonly ARU_LOCAL_MANIFEST_URL="${ARU_LOCAL_MANIFEST_URL:-http://127.0.0.1:8788/.well-known/aru.json}"
readonly ARU_PUBLIC_MANIFEST_URL="${ARU_PUBLIC_MANIFEST_URL:-}"

ATTEMPT=""
STATE_REBASED=0
CONFIGS_CHANGED=0
ENABLE_CREATED=0
TIMER_TOUCHED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
safe_attempt() {
  [[ -n "$ATTEMPT" && "$ATTEMPT" == "$BACKUP_PARENT"/enable.* &&
    -d "$ATTEMPT" && ! -L "$ATTEMPT" &&
    "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 &&
    "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]]
}

restore_file() {
  local backup=$1 target=$2 owner=$3 group=$4 mode=$5
  install -o "$owner" -g "$group" -m "$mode" "$backup" "$target.restore"
  mv -fT -- "$target.restore" "$target"
}

rollback_failure() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  (( TIMER_TOUCHED == 0 )) || systemctl disable --now "$TIMER" >/dev/null 2>&1
  if safe_attempt; then
    (( CONFIGS_CHANGED == 0 )) || {
      restore_file "$ATTEMPT/default.json" "$HEARTBEAT" root root 0644
      restore_file "$ATTEMPT/aru-delivery.json" "$DELIVERY" root root 0644
    }
    (( STATE_REBASED == 0 )) ||
      restore_file "$ATTEMPT/state.json" "$DATA/state.json" aru-desire aru-desire 0600
  fi
  (( ENABLE_CREATED == 0 )) || rm -f -- "$ENABLE_FILE"
  printf 'ERROR: autonomy enable failed; timer and delivery were returned to the disabled state.\n' >&2
  [[ -z "$ATTEMPT" ]] || printf 'enable_attempt=%s\n' "$ATTEMPT" >&2
  exit "$status"
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: enable-autonomy-once.sh --apply"
for command in node runuser curl install mktemp stat readlink mv rm systemctl sha256sum cut; do
  need "$command"
done
[[ -d "$SOURCE" && ! -L "$SOURCE" ]] || die "source directory is unsafe"
[[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed application is unsafe"
SOURCE_VERSION="$(node -p "require('$SOURCE/package.json').version")"
TARGET_VERSION="$(node -p "require('$TARGET/package.json').version")"
[[ "$SOURCE_VERSION" == "$TARGET_VERSION" ]] ||
  die "source and installed versions differ; upgrade first"
for unit in "$SERVICE" "$TIMER"; do
  [[ -f "$SOURCE/systemd/$unit" && ! -L "$SOURCE/systemd/$unit" ]] || die "source systemd unit is missing or unsafe: $unit"
  [[ -f "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || die "installed systemd unit is missing or unsafe: $unit"
  [[ "$(sha256sum "$SOURCE/systemd/$unit" | cut -d ' ' -f 1)" == "$(sha256sum "$UNIT_DIR/$unit" | cut -d ' ' -f 1)" ]] ||
    die "installed systemd unit differs from source; upgrade first: $unit"
done
for file in "$HEARTBEAT" "$DELIVERY" "$DATA/state.json" "$CREDENTIAL"; do
  [[ -f "$file" && ! -L "$file" ]] || die "required file is missing or unsafe: $file"
done
[[ "$(stat -c '%U:%G:%a:%h' "$DATA/state.json")" == "aru-desire:aru-desire:600:1" ]] ||
  die "state file permissions are unsafe"
[[ "$(stat -c '%U:%G:%a:%h' "$CREDENTIAL")" == "aru-desire:aru-desire:600:1" ]] ||
  die "credential permissions are unsafe"
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] ||
  die "timer must start disabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] ||
  die "timer must start inactive"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service is active"
[[ ! -e "$ENABLE_FILE" && ! -L "$ENABLE_FILE" ]] ||
  die "delivery enable file already exists"

node -e 'const fs=require("fs"); for (const file of process.argv.slice(1)) {
 const x=JSON.parse(fs.readFileSync(file,"utf8"));
 if ((x.observeOnly??true)!==true || (x.deliveryEnabled??false)!==false ||
     (x.enabled??false)!==false) process.exit(1);
}' "$HEARTBEAT" "$DELIVERY" || die "installed delivery flags are not safely disabled"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
 if(s.pendingDecision!==null) process.exit(1);' "$DATA/state.json" ||
  die "a pending decision must be resolved before enabling"
runuser -u aru-desire -- /usr/bin/node --input-type=module -e '
 import {readFile} from "node:fs/promises";
 import {parseSenderBundle} from "file:///opt/aru-desire-heartbeat/delivery/aru-wake-sender.mjs";
 parseSenderBundle((await readFile(process.argv[1],"utf8")).trim());
' "$CREDENTIAL" >/dev/null || die "credential format is invalid"
curl -fsS -o /dev/null "$ARU_LOCAL_MANIFEST_URL" ||
  die "local Aru Host manifest is unavailable"
if [[ -n "$ARU_PUBLIC_MANIFEST_URL" ]]; then
  curl -fsS -o /dev/null "$ARU_PUBLIC_MANIFEST_URL" ||
    die "public Aru Host manifest is unavailable"
fi

if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" &&
    "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 ]] ||
    die "activation backup directory is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/enable.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
safe_attempt || die "activation backup is unsafe"
install -o root -g root -m 0600 "$HEARTBEAT" "$ATTEMPT/default.json"
install -o root -g root -m 0600 "$DELIVERY" "$ATTEMPT/aru-delivery.json"
install -o root -g root -m 0600 "$DATA/state.json" "$ATTEMPT/state.json"
printf 'phase=prepared\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap rollback_failure EXIT ERR INT TERM

STATE_REBASED=1
runuser -u aru-desire -- /usr/bin/node "$TARGET/bin/desire-heartbeat.mjs" rebase-clock --config "$HEARTBEAT" --data-dir "$DATA" >/dev/null
node -e 'const fs=require("fs"),a=JSON.parse(fs.readFileSync(process.argv[1])),
 b=JSON.parse(fs.readFileSync(process.argv[2]));
 const defaultSolo={count:0,lastSoloAt:null,refractoryUntil:null,lastLibidoChoice:null};
 for(const x of [a,b]) {
   for(const k of ["sequence","updatedAt","lastTickAt"]) delete x[k];
   if(x.solo===undefined) x.solo=structuredClone(defaultSolo);
 }
 if(JSON.stringify(a)!==JSON.stringify(b)) process.exit(1);
' "$ATTEMPT/state.json" "$DATA/state.json" ||
  die "clock rebase changed protected state content"

node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
 x.observeOnly=false;x.deliveryEnabled=true;
 fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");
' "$HEARTBEAT" "$ATTEMPT/default.live.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
 x.enabled=true;fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");
' "$DELIVERY" "$ATTEMPT/aru-delivery.live.json"
install -o root -g root -m 0644 "$ATTEMPT/default.live.json" "$HEARTBEAT.new"
install -o root -g root -m 0644 "$ATTEMPT/aru-delivery.live.json" "$DELIVERY.new"
CONFIGS_CHANGED=1
mv -fT -- "$HEARTBEAT.new" "$HEARTBEAT"
mv -fT -- "$DELIVERY.new" "$DELIVERY"

install -d -o root -g aru-desire -m 0750 "$ENABLE_DIR"
printf '%s\n' "$ENABLE_MAGIC" > "$ATTEMPT/external-trigger.enable"
ENABLE_CREATED=1
install -o root -g aru-desire -m 0640 "$ATTEMPT/external-trigger.enable" "$ENABLE_FILE"
TIMER_TOUCHED=1
systemctl enable --now "$TIMER"
[[ "$(systemctl is-enabled "$TIMER")" == enabled ]] || die "timer did not enable"
[[ "$(systemctl is-active "$TIMER")" == active ]] || die "timer did not start"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service ran unexpectedly during activation"
node -e 'const fs=require("fs");const h=JSON.parse(fs.readFileSync(process.argv[1]));
 const d=JSON.parse(fs.readFileSync(process.argv[2]));
 if(h.observeOnly!==false||h.deliveryEnabled!==true||d.enabled!==true) process.exit(1);
' "$HEARTBEAT" "$DELIVERY" || die "live delivery flags were not applied"
printf 'phase=enabled\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM
printf 'autonomy_enable=PASS\nclock_rebased_without_growth=yes\n'
printf 'timer_enabled=enabled\ntimer_active=active\ndelivery=enabled\n'
printf 'state_content_preserved=yes\nbackup=%s\n' "$ATTEMPT"
printf 'rollback_command=sudo %s/scripts/rollback-autonomy.sh %s\n' "$SOURCE" "$ATTEMPT"
printf 'stop_command=sudo %s/scripts/disable-autonomy-once.sh --apply\n' "$SOURCE"