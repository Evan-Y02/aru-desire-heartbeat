#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly STATE="$DATA/state.json"
readonly LOCK="$DATA/heartbeat.lock"
readonly CLAIM_DIR="$DATA/delivery-attempts"
readonly CREDENTIAL="$DATA/external-trigger.send-credential"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-recovery"
readonly ENABLE_MAGIC="aru-desire-heartbeat-external-trigger-v1"
readonly TEMP_HEARTBEAT="$DATA/.recovery-heartbeat.json"
readonly TEMP_DELIVERY="$DATA/.recovery-delivery.json"
readonly TEMP_ENABLE="$DATA/.recovery-enable"
ATTEMPT=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
cleanup() {
  local status=$?
  trap - EXIT
  rm -f -- "$TEMP_HEARTBEAT" "$TEMP_DELIVERY" "$TEMP_ENABLE"
  if (( status != 0 )); then
    printf 'ERROR: stalled delivery recovery stopped safely; timer remains disabled.\n' >&2
    [[ -z "$ATTEMPT" ]] || printf 'recovery_attempt=%s\n' "$ATTEMPT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: recover-stalled-delivery-once.sh --apply"
for command in node runuser install mktemp stat readlink rm systemctl kill sha256sum cut chown chmod; do need "$command"; done
SOURCE_VERSION="$(node -p "require('$SOURCE/package.json').version")"
TARGET_VERSION="$(node -p "require('$TARGET/package.json').version")"
[[ "$SOURCE_VERSION" == "$TARGET_VERSION" ]] ||
  die "source and installed versions differ; upgrade first"
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] ||
  die "timer must be disabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] ||
  die "timer must be inactive"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] ||
  die "heartbeat service must be inactive"
for file in "$TEMP_HEARTBEAT" "$TEMP_DELIVERY" "$TEMP_ENABLE"; do
  [[ ! -e "$file" && ! -L "$file" ]] || die "temporary recovery path already exists: $file"
done
[[ -d "$DATA" && ! -L "$DATA" && "$(stat -c '%U:%G:%a' "$DATA")" == aru-desire:aru-desire:700 ]] ||
  die "data directory is unsafe"
for file in "$STATE" "$LOCK" "$CREDENTIAL"; do
  [[ -f "$file" && ! -L "$file" && "$(stat -c '%U:%G:%a:%h' "$file")" == aru-desire:aru-desire:600:1 ]] ||
    die "required recovery file is missing or unsafe: $file"
done
[[ -d "$CLAIM_DIR" && ! -L "$CLAIM_DIR" &&
   "$(stat -c '%U:%G:%a' "$CLAIM_DIR")" == aru-desire:aru-desire:700 ]] ||
  die "delivery attempt directory is unsafe"

PENDING="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const p=s.pendingDecision;if(!p)process.exit(2);
process.stdout.write(p.id+"|"+p.createdAt.epochMs);' "$STATE")" ||
  die "state does not contain one valid pending decision"
IFS='|' read -r DECISION_ID DECISION_AT <<<"$PENDING"
[[ "$DECISION_ID" =~ ^decision-[0-9]+-[0-9]+$ && "$DECISION_AT" =~ ^[0-9]+$ ]] ||
  die "pending decision identity is unsafe"
readonly CLAIM="$CLAIM_DIR/$DECISION_ID.claimed.json"
readonly ACCEPTED="$CLAIM_DIR/$DECISION_ID.accepted.json"
readonly UNCERTAIN="$CLAIM_DIR/$DECISION_ID.uncertain.json"
[[ -f "$CLAIM" && ! -L "$CLAIM" &&
   "$(stat -c '%U:%G:%a:%h' "$CLAIM")" == aru-desire:aru-desire:600:1 ]] ||
  die "matching claimed delivery record is missing or unsafe"
[[ ! -e "$ACCEPTED" && ! -L "$ACCEPTED" && ! -e "$UNCERTAIN" && ! -L "$UNCERTAIN" ]] ||
  die "the decision already has a settled delivery record"
node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(x.decisionId!==process.argv[2])process.exit(1);' "$CLAIM" "$DECISION_ID" ||
  die "claim does not match the pending decision"
LOCK_PID="$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!Number.isSafeInteger(x.pid)||x.pid<1||!Number.isSafeInteger(x.acquiredAt))process.exit(1);
process.stdout.write(String(x.pid));' "$LOCK")" ||
  die "stale lock record is invalid"
if kill -0 "$LOCK_PID" 2>/dev/null; then
  die "lock owner process is still alive"
fi

if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" &&
     "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 &&
     "$(readlink -f "$BACKUP_PARENT")" == "$BACKUP_PARENT" ]] ||
    die "recovery backup directory is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/recovery.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
install -o root -g root -m 0600 "$STATE" "$ATTEMPT/state.before.json"
install -o root -g root -m 0600 "$LOCK" "$ATTEMPT/stale-lock.json"
install -o root -g root -m 0600 "$CLAIM" "$ATTEMPT/unsubmitted-claim.json"
STATE_BEFORE="$(sha256sum "$STATE" | cut -d ' ' -f 1)"
printf 'phase=prepared\ndecision_id=%s\ndecision_at=%s\n'   "$DECISION_ID" "$DECISION_AT" > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"

node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
x.observeOnly=false;x.deliveryEnabled=true;
fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");'   "$TARGET/config/default.json" "$ATTEMPT/heartbeat.live.json"
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
x.enabled=true;x.credentialPath=process.argv[3];x.enableFile=process.argv[4];
fs.writeFileSync(process.argv[2],JSON.stringify(x,null,2)+"\n");'   "$TARGET/config/aru-delivery.json" "$ATTEMPT/delivery.live.json" "$CREDENTIAL" "$TEMP_ENABLE"
install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/heartbeat.live.json" "$TEMP_HEARTBEAT"
install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/delivery.live.json" "$TEMP_DELIVERY"
printf '%s\n' "$ENABLE_MAGIC" > "$ATTEMPT/enable"
install -o aru-desire -g aru-desire -m 0600 "$ATTEMPT/enable" "$TEMP_ENABLE"

rm -f -- "$CLAIM"
RESULT="$(runuser -u aru-desire -- /usr/bin/node --jitless   "$TARGET/bin/desire-deliver.mjs" --config "$TEMP_HEARTBEAT"   --delivery-config "$TEMP_DELIVERY" --data-dir "$DATA")"
node -e 'const x=JSON.parse(process.argv[1]);
if(x.accepted!==true||x.decisionId!==process.argv[2])process.exit(1);'   "$RESULT" "$DECISION_ID" || die "recovered delivery did not return matching acceptance"
[[ -f "$ACCEPTED" && ! -L "$ACCEPTED" &&
   "$(stat -c '%U:%G:%a:%h' "$ACCEPTED")" == aru-desire:aru-desire:600:1 ]] ||
  die "accepted delivery receipt is missing or unsafe"
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(s.pendingDecision!==null)process.exit(1);
const t=s.timeline.find(x=>x.at?.epochMs===Number(process.argv[2]));
if(!t||t.outcome!=="submitted"||!t.reasons.includes("delivery-accepted"))process.exit(1);'   "$STATE" "$DECISION_AT" || die "state or timeline did not settle the recovered decision"
[[ "$(sha256sum "$STATE" | cut -d ' ' -f 1)" != "$STATE_BEFORE" ]] ||
  die "state did not record satisfaction"
printf 'phase=recovered\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT
rm -f -- "$TEMP_HEARTBEAT" "$TEMP_DELIVERY" "$TEMP_ENABLE"
printf 'stalled_delivery_recovery=PASS\n'
printf 'decision_id=%s\nmessage_submitted=yes\npending_decision=cleared\n' "$DECISION_ID"
printf 'desire_state=satisfied_proportionally\ntimer_active=inactive\n'
printf 'audit_backup=%s\n' "$ATTEMPT"