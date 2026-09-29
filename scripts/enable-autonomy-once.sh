#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
readonly SOURCE="$(dirname -- "$SCRIPT_DIR")"
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
readonly SOURCE_CREDENTIAL="/home/xinchao/private/ChengXiao/secrets/desire-heartbeat/external-trigger.send-credential"

ATTEMPT=""
STATE_REBASED=0
CONFIGS_CHANGED=0
ENABLE_CREATED=0
TIMER_TOUCHED=0
TIMER_WAS_ENABLED=""
TIMER_WAS_ACTIVE=""

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
  if (( TIMER_TOUCHED != 0 )); then
    systemctl disable --now "$TIMER" >/dev/null 2>&1
  fi
  if safe_attempt; then
    (( CONFIGS_CHANGED == 0 )) || {
      restore_file "$ATTEMPT/default.json" "$HEARTBEAT" root root 0644
      restore_file "$ATTEMPT/aru-delivery.json" "$DELIVERY" root root 0644
    }
    (( STATE_REBASED == 0 )) ||
      restore_file "$ATTEMPT/state.json" "$DATA/state.json" aru-desire aru-desire 0600
  fi
  (( ENABLE_CREATED == 0 )) || rm -f -- "$ENABLE_FILE"
  rm -f -- "$HEARTBEAT.new" >/dev/null 2>&1
  if (( TIMER_TOUCHED != 0 )); then
    [[ "$TIMER_WAS_ENABLED" != enabled ]] || systemctl enable "$TIMER" >/dev/null 2>&1
    [[ "$TIMER_WAS_ACTIVE" != active ]] || systemctl start "$TIMER" >/dev/null 2>&1
  fi
  printf 'ERROR: autonomy enable failed; delivery was closed and the prior timer state was restored.\n' >&2
  [[ -z "$ATTEMPT" ]] || printf 'enable_attempt=%s\n' "$ATTEMPT" >&2
  exit "$status"
}

privacy_safe_preflight() {
  local service_uid service_gid source_uid
  service_uid="$(id -u aru-desire 2>/dev/null)" || { fixed_preflight_failure; return 1; }
  service_gid="$(id -g aru-desire 2>/dev/null)" || { fixed_preflight_failure; return 1; }
  source_uid="$(id -u xinchao 2>/dev/null)" || { fixed_preflight_failure; return 1; }
  /usr/bin/node "$SOURCE/scripts/autonomy-activation-preflight.mjs" \
    --production "$service_uid" "$service_gid" "$source_uid" 2>/dev/null
}

fixed_preflight_failure() {
  printf '%s\n' \
    'AUTONOMY_ACTIVATION_PREFLIGHT=FAIL' \
    'PENDING_DECISION=INCONCLUSIVE' \
    'ACTIVATION_STRUCTURE=FAIL' \
    'ACTIVATION_VERSION=INCONCLUSIVE' \
    'ACTIVATION_UNITS=INCONCLUSIVE' \
    'ACTIVATION_CONFIG=INCONCLUSIVE' \
    'CREDENTIAL_IDENTITY=INCONCLUSIVE' \
    'SYSTEMD_STATE=INCONCLUSIVE' \
    'TIMER_QUIESCE_REQUIRED=0' \
    'PREFLIGHT_STRUCTURE_ERROR=1' \
    'PREFLIGHT_VERSION_ERROR=0' \
    'PREFLIGHT_UNIT_ERROR=0' \
    'PREFLIGHT_CONFIG_ERROR=0' \
    'PREFLIGHT_CREDENTIAL_ERROR=0' \
    'PREFLIGHT_IDENTITY_ERROR=0' \
    'PREFLIGHT_SYSTEMD_ERROR=0' \
    'PREFLIGHT_PENDING_ERROR=0'
}

if [[ "$MODE" == "--preflight" ]]; then
  privacy_safe_preflight
  exit $?
fi
[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: enable-autonomy-once.sh --preflight | --apply"
for command in node runuser curl install mktemp stat readlink mv rm systemctl id; do
  need "$command"
done
[[ -d "$SOURCE" && ! -L "$SOURCE" ]] || die "source directory is unsafe"
[[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed application is unsafe"
SOURCE_VERSION="$(node -p "require('$SOURCE/package.json').version")"
TARGET_VERSION="$(node -p "require('$TARGET/package.json').version")"
[[ "$SOURCE_VERSION" == "$TARGET_VERSION" ]] ||
  die "source and installed versions differ; upgrade first"
for file in "$HEARTBEAT" "$DELIVERY" "$DATA/state.json" "$CREDENTIAL"; do
  [[ -f "$file" && ! -L "$file" ]] || die "required file is missing or unsafe: $file"
done
[[ "$(stat -c '%U:%G:%a:%h' "$DATA/state.json")" == "aru-desire:aru-desire:600:1" ]] ||
  die "state file permissions are unsafe"
[[ "$(stat -c '%U:%G:%a:%h' "$CREDENTIAL")" == "aru-desire:aru-desire:600:1" ]] ||
  die "credential permissions are unsafe"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service is active"
[[ ! -e "$ENABLE_FILE" && ! -L "$ENABLE_FILE" ]] ||
  die "delivery enable file already exists"

node -e 'const fs=require("fs");
 const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
 const d=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
 if (h.observeOnly!==true || h.deliveryEnabled!==false || d.enabled!==true) process.exit(1);
' "$HEARTBEAT" "$DELIVERY" || die "installed delivery flags are not safely disabled"

TIMER_WAS_ENABLED="$(systemctl is-enabled "$TIMER" 2>/dev/null || true)"
TIMER_WAS_ACTIVE="$(systemctl is-active "$TIMER" 2>/dev/null || true)"
[[ "$TIMER_WAS_ENABLED" == enabled || "$TIMER_WAS_ENABLED" == disabled ]] ||
  die "timer enablement state is unsupported"
[[ "$TIMER_WAS_ACTIVE" == active || "$TIMER_WAS_ACTIVE" == inactive ]] ||
  die "timer activity state is unsupported"
TIMER_TOUCHED=1
trap rollback_failure EXIT ERR INT TERM
systemctl stop "$TIMER"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] ||
  die "timer did not quiesce"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service is active after timer quiesce"
privacy_safe_preflight >/dev/null || die "quiesced privacy-safe activation preflight failed"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
 if(s.pendingDecision!==null) process.exit(1);' "$DATA/state.json" ||
  die "a pending decision must be resolved before enabling"
runuser -u aru-desire -- /usr/bin/node --input-type=module -e '
 import {readFile} from "node:fs/promises";
 import {parseSenderBundle} from "file:///opt/aru-desire-heartbeat/delivery/aru-wake-sender.mjs";
 parseSenderBundle((await readFile(process.argv[1],"utf8")).trim());
' "$CREDENTIAL" >/dev/null || die "credential format is invalid"
curl -fsS -o /dev/null http://127.0.0.1:8788/.well-known/aru.json ||
  die "local Aru Host manifest is unavailable"
curl -fsS -o /dev/null https://aru.xinchaonian.duckdns.org/.well-known/aru.json ||
  die "public Aru Host manifest is unavailable"

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
STATE_REBASED=1
runuser -u aru-desire -- /usr/bin/node "$TARGET/bin/desire-heartbeat.mjs" rebase-clock --config "$HEARTBEAT" --data-dir "$DATA" >/dev/null
node -e 'const fs=require("fs"),a=JSON.parse(fs.readFileSync(process.argv[1])),
 b=JSON.parse(fs.readFileSync(process.argv[2]));
 const defaultSolo={count:0,lastSoloAt:null,refractoryUntil:null,lastLibidoChoice:null};
 const defaultExpression={consecutiveWithholds:0};
 for(const x of [a,b]) {
   for(const k of ["sequence","updatedAt","lastTickAt"]) delete x[k];
   if(x.solo===undefined) x.solo=structuredClone(defaultSolo);
   if(x.expression===undefined) x.expression=structuredClone(defaultExpression);
 }
 if(JSON.stringify(a)!==JSON.stringify(b)) process.exit(1);
' "$ATTEMPT/state.json" "$DATA/state.json" ||
  die "clock rebase changed protected state content"

node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1]));
 x.observeOnly=false;x.deliveryEnabled=true;
 fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");
' "$HEARTBEAT" "$ATTEMPT/default.live.json"
install -o root -g root -m 0644 "$ATTEMPT/default.live.json" "$HEARTBEAT.new"
CONFIGS_CHANGED=1
mv -fT -- "$HEARTBEAT.new" "$HEARTBEAT"

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
