#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo 'must run as root' >&2; exit 77; }

INSTALL_STAGE=initialization
ROLLBACK_READY=false

handle_error() {
  local exit_code=$1
  local line=$2
  local command=$3
  trap - ERR
  set +e
  printf 'ERROR: install failed: stage=%s line=%s exit=%s command=%q\n' \
    "$INSTALL_STAGE" "$line" "$exit_code" "$command" >&2
  if [[ $ROLLBACK_READY == true ]]; then
    printf 'ERROR: rolling back production changes\n' >&2
    if rollback; then
      printf 'ERROR: rollback completed\n' >&2
    else
      printf 'ERROR: rollback encountered errors; inspect services before retrying\n' >&2
    fi
  else
    printf 'ERROR: no production changes had been made; rollback not required\n' >&2
  fi
  exit "$exit_code"
}

trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

readonly SOURCE_ROOT=${1:-/home/xinchao/private/ChengXiao/desire-heartbeat}
readonly CURRENT_LINK=/opt/aru-selfhost/current
OLD_RELEASE=$(readlink -f "$CURRENT_LINK")
readonly OLD_RELEASE
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
readonly STAMP
readonly NEW_RELEASE="/opt/aru-selfhost/releases/v0.30.2-pairing-hotfix1-turn-hook-${STAMP}"
readonly BACKUP="/var/backups/aru-desire-turn-hook/${STAMP}"
readonly DESIRE_ROOT=/opt/aru-desire-heartbeat
readonly DESIRE_DATA=/var/lib/aru-desire-heartbeat
readonly ARU_SECRET=/var/lib/aru-selfhost/desire-turn-hook.secret
readonly DESIRE_SECRET=${DESIRE_DATA}/turn-hook.secret
readonly RECEIVER_UNIT=/etc/systemd/system/aru-desire-turn-receiver.service
readonly ARU_DROPIN=/etc/systemd/system/aru-selfhost.service.d/desire-turn-hook.conf
ARU_WAS_ACTIVE=$(systemctl is-active aru-selfhost.service || true)
readonly ARU_WAS_ACTIVE
DASHBOARD_WAS_ACTIVE=$(systemctl is-active aru-desire-dashboard.service || true)
readonly DASHBOARD_WAS_ACTIVE
RECEIVER_WAS_ACTIVE=$(systemctl is-active aru-desire-turn-receiver.service || true)
readonly RECEIVER_WAS_ACTIVE
RECEIVER_WAS_ENABLED=$(systemctl is-enabled aru-desire-turn-receiver.service 2>/dev/null || true)
readonly RECEIVER_WAS_ENABLED
INSTALL_STAGE=baseline_health
grep -q -F 'startup logs never include credentials' "$OLD_RELEASE/server.mjs"
! grep -q -F 'pairingToken: state.pairing.token' "$OLD_RELEASE/server.mjs"
! grep -q -F 'console.log(pairingURL)' "$OLD_RELEASE/server.mjs"
DEVICE_COUNT_BEFORE=$(curl --fail --silent --max-time 2 \
  http://127.0.0.1:8788/aru/v1/diagnostics | \
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(String(JSON.parse(s).deviceCount)))")
readonly DEVICE_COUNT_BEFORE
BRIDGE_CODE_BEFORE=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:18110/bridge/v1/health)
readonly BRIDGE_CODE_BEFORE
SECRET_CHANNEL_BEFORE=absent
if [[ -e $ARU_SECRET || -L $ARU_SECRET || -e $DESIRE_SECRET || -L $DESIRE_SECRET ]]; then
  [[ -f $ARU_SECRET && ! -L $ARU_SECRET && -f $DESIRE_SECRET && ! -L $DESIRE_SECRET ]] || {
    echo 'turn hook secret channel is incomplete or unsafe' >&2
    exit 73
  }
  [[ $(stat -c '%U:%G:%a:%h' "$ARU_SECRET") == 'aru-selfhost:aru-selfhost:600:1' ]]
  [[ $(stat -c '%U:%G:%a:%h' "$DESIRE_SECRET") == 'aru-desire:aru-desire:600:1' ]]
  cmp -s -- "$ARU_SECRET" "$DESIRE_SECRET"
  node - "$ARU_SECRET" <<'NODE'
const fs = require('fs');
const value = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) process.exit(1);
NODE
  SECRET_CHANNEL_BEFORE=present
fi
readonly SECRET_CHANNEL_BEFORE

receiver_closure_output=$(node "$SOURCE_ROOT/scripts/local-import-closure.mjs" \
  "$SOURCE_ROOT" bin/desire-turn-receiver.mjs bin/desire-interaction-init.mjs \
  scripts/set-interaction-flags.mjs scripts/verify-synthetic-ledger.mjs)
mapfile -t RECEIVER_CLOSURE <<< "$receiver_closure_output"
unset receiver_closure_output
[[ ${#RECEIVER_CLOSURE[@]} -gt 0 ]]
readonly DESIRE_FILES=(
  config/default.json
  "${RECEIVER_CLOSURE[@]}"
  dashboard/server.py dashboard/public/app.js dashboard/public/index.html dashboard/public/styles.css
)
readonly DATA_FILES=(state.json interaction-state.json)

INSTALL_STAGE=isolated_aru_service_identity_preflight
bash "$SOURCE_ROOT/scripts/test-aru-patched-release-as-service-user.sh" "$SOURCE_ROOT"

INSTALL_STAGE=backup
mkdir -p "$BACKUP/aru" "$BACKUP/desire" "$BACKUP/systemd"
chmod 0700 "$BACKUP"
cp -a "$OLD_RELEASE/server.mjs" "$BACKUP/aru/server.mjs"
printf '%s\n' "$OLD_RELEASE" > "$BACKUP/aru/previous-release"
for file in "${DESIRE_FILES[@]}"; do
  if [[ -f "$DESIRE_ROOT/$file" ]]; then
    mkdir -p "$BACKUP/desire/$(dirname "$file")"
    cp -a "$DESIRE_ROOT/$file" "$BACKUP/desire/$file"
  else
    printf '%s\n' "$file" >> "$BACKUP/desire-missing-files"
  fi
done
for file in "${DATA_FILES[@]}"; do
  if [[ -f "$DESIRE_DATA/$file" ]]; then
    install -m 0600 "$DESIRE_DATA/$file" "$BACKUP/$file"
  else
    printf '%s\n' "$file" >> "$BACKUP/data-missing-files"
  fi
done
[[ -f "$RECEIVER_UNIT" ]] && cp -a "$RECEIVER_UNIT" "$BACKUP/systemd/"
[[ -f "$ARU_DROPIN" ]] && cp -a "$ARU_DROPIN" "$BACKUP/systemd/"
if [[ $SECRET_CHANNEL_BEFORE == present ]]; then
  cp -a "$ARU_SECRET" "$BACKUP/aru/turn-hook.secret"
  cp -a "$DESIRE_SECRET" "$BACKUP/desire-turn-hook.secret"
fi
ROLLBACK_READY=true

rollback() {
  local rollback_failed=0
  set +e
  rollback_run() {
    local label=$1
    shift
    if ! "$@"; then
      printf 'ERROR: rollback step failed: %s\n' "$label" >&2
      rollback_failed=1
    fi
  }
  rollback_run stop_receiver systemctl stop aru-desire-turn-receiver.service
  if [[ $RECEIVER_WAS_ENABLED != enabled ]]; then
    # Disable while the staged unit still exists. Doing this after removing the
    # unit returns non-zero and leaves a broken wants/ symlink.
    rollback_run disable_staged_receiver systemctl disable aru-desire-turn-receiver.service
  fi
  rollback_run remove_temporary_current_link rm -f "${CURRENT_LINK}.rollback"
  rollback_run create_previous_current_link ln -s "$OLD_RELEASE" "${CURRENT_LINK}.rollback"
  rollback_run activate_previous_release mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"
  for file in "${DESIRE_FILES[@]}"; do
    [[ -f "$BACKUP/desire/$file" ]] || continue
    rollback_run "create_desire_parent:$file" mkdir -p "$DESIRE_ROOT/$(dirname "$file")"
    rollback_run "restore_desire_file:$file" cp -a "$BACKUP/desire/$file" "$DESIRE_ROOT/$file"
  done
  if [[ -f "$BACKUP/desire-missing-files" ]]; then
    while IFS= read -r file; do
      [[ -n $file && $file != /* && $file != *..* ]] || continue
      rollback_run "remove_new_desire_file:$file" rm -f "$DESIRE_ROOT/$file"
    done < "$BACKUP/desire-missing-files"
  fi
  for file in "${DATA_FILES[@]}"; do
    [[ -f "$BACKUP/$file" ]] || continue
    rollback_run "restore_data_file:$file" install -o aru-desire -g aru-desire -m 0600 \
      "$BACKUP/$file" "$DESIRE_DATA/$file"
  done
  if [[ -f "$BACKUP/data-missing-files" ]]; then
    while IFS= read -r file; do
      [[ $file == state.json || $file == interaction-state.json ]] || continue
      rollback_run "remove_new_data_file:$file" rm -f "$DESIRE_DATA/$file"
    done < "$BACKUP/data-missing-files"
  fi
  if [[ -f "$BACKUP/systemd/aru-desire-turn-receiver.service" ]]; then
    rollback_run restore_receiver_unit install -o root -g root -m 0644 \
      "$BACKUP/systemd/aru-desire-turn-receiver.service" "$RECEIVER_UNIT"
  else
    rollback_run remove_new_receiver_unit rm -f "$RECEIVER_UNIT"
  fi
  if [[ -f "$BACKUP/systemd/desire-turn-hook.conf" ]]; then
    rollback_run restore_aru_dropin install -D -o root -g root -m 0644 \
      "$BACKUP/systemd/desire-turn-hook.conf" "$ARU_DROPIN"
  else
    rollback_run remove_new_aru_dropin rm -f "$ARU_DROPIN"
  fi
  if [[ -f $BACKUP/aru/turn-hook.secret && -f $BACKUP/desire-turn-hook.secret ]]; then
    rollback_run restore_aru_hook_secret install -o aru-selfhost -g aru-selfhost -m 0600 \
      "$BACKUP/aru/turn-hook.secret" "$ARU_SECRET"
    rollback_run restore_desire_hook_secret install -o aru-desire -g aru-desire -m 0600 \
      "$BACKUP/desire-turn-hook.secret" "$DESIRE_SECRET"
  else
    rollback_run remove_new_hook_secrets rm -f "$ARU_SECRET" "$DESIRE_SECRET"
  fi
  rollback_run daemon_reload systemctl daemon-reload
  if [[ $RECEIVER_WAS_ENABLED == enabled ]]; then
    rollback_run restore_receiver_enabled systemctl enable aru-desire-turn-receiver.service
  fi
  if [[ $RECEIVER_WAS_ACTIVE == active ]]; then
    rollback_run restore_receiver_active systemctl restart aru-desire-turn-receiver.service
  elif [[ -f $RECEIVER_UNIT ]]; then
    rollback_run restore_receiver_inactive systemctl stop aru-desire-turn-receiver.service
  fi
  if [[ $ARU_WAS_ACTIVE == active ]]; then
    rollback_run restore_aru_active systemctl restart aru-selfhost.service
  else
    rollback_run restore_aru_inactive systemctl stop aru-selfhost.service
  fi
  if [[ $DASHBOARD_WAS_ACTIVE == active ]]; then
    rollback_run restore_dashboard_active systemctl restart aru-desire-dashboard.service
  else
    rollback_run restore_dashboard_inactive systemctl stop aru-desire-dashboard.service
  fi
  return "$rollback_failed"
}

INSTALL_STAGE=stage_aru_release
cp -a "$OLD_RELEASE" "$NEW_RELEASE"
install -o root -g root -m 0755 "$SOURCE_ROOT/aru-hook/aru-desire-turn-hook.mjs" \
  "$NEW_RELEASE/aru-desire-turn-hook.mjs"
install -o root -g root -m 0755 "$SOURCE_ROOT/aru-hook/synthetic-check.mjs" \
  "$NEW_RELEASE/synthetic-check.mjs"
node "$SOURCE_ROOT/aru-hook/apply-server-wiring.mjs" "$NEW_RELEASE/server.mjs"
chown --reference="$OLD_RELEASE/server.mjs" "$NEW_RELEASE/server.mjs"
chmod --reference="$OLD_RELEASE/server.mjs" "$NEW_RELEASE/server.mjs"
[[ $(stat -c '%u:%g:%a' "$NEW_RELEASE/server.mjs") == \
  "$(stat -c '%u:%g:%a' "$OLD_RELEASE/server.mjs")" ]]
node --check "$NEW_RELEASE/server.mjs"
node --check "$NEW_RELEASE/aru-desire-turn-hook.mjs"
node --check "$NEW_RELEASE/synthetic-check.mjs"

INSTALL_STAGE=stage_desire_runtime
for file in "${DESIRE_FILES[@]}"; do
  mode=0644
  [[ $file == bin/* || $file == scripts/* ]] && mode=0755
  install -D -o root -g root -m "$mode" "$SOURCE_ROOT/$file" "$DESIRE_ROOT/$file"
done
node "$DESIRE_ROOT/scripts/set-interaction-flags.mjs" "$DESIRE_ROOT/config/default.json" \
  chatStimulusEnabled=false arousalEnabled=false \
  arousalDriveSettlementEnabled=false soloSessionsEnabled=false

INSTALL_STAGE=initialize_interaction_state
if [[ ! -f "$DESIRE_DATA/interaction-state.json" ]]; then
  runuser -u aru-desire -- node "$DESIRE_ROOT/bin/desire-interaction-init.mjs" \
    --config "$DESIRE_ROOT/config/default.json" --data-dir "$DESIRE_DATA"
fi

INSTALL_STAGE=install_local_channel
if [[ $SECRET_CHANNEL_BEFORE == absent ]]; then
  secret=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")
  install -o aru-selfhost -g aru-selfhost -m 0600 /dev/null "$ARU_SECRET"
  install -o aru-desire -g aru-desire -m 0600 /dev/null "$DESIRE_SECRET"
  printf '%s\n' "$secret" > "$ARU_SECRET"
  printf '%s\n' "$secret" > "$DESIRE_SECRET"
  unset secret
fi

install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/aru-desire-turn-receiver.service" "$RECEIVER_UNIT"
install -D -o root -g root -m 0644 "$SOURCE_ROOT/systemd/aru-selfhost-desire-turn-hook.conf" "$ARU_DROPIN"
ln -s "$NEW_RELEASE" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
systemctl daemon-reload
INSTALL_STAGE=start_receiver
systemctl enable --now aru-desire-turn-receiver.service
INSTALL_STAGE=receiver_health
receiver_ready=false
for _ in {1..40}; do
  if curl --fail --silent --max-time 1 http://127.0.0.1:18761/healthz >/dev/null; then
    receiver_ready=true
    break
  fi
  sleep 0.1
done
[[ $receiver_ready == true ]]
INSTALL_STAGE=restart_aru
systemctl restart aru-selfhost.service
INSTALL_STAGE=restart_dashboard
systemctl restart aru-desire-dashboard.service
INSTALL_STAGE=service_health
aru_ready=false
for _ in {1..40}; do
  if curl --fail --silent --max-time 1 http://127.0.0.1:8788/aru/v1/diagnostics >/dev/null; then
    aru_ready=true
    break
  fi
  sleep 0.1
done
[[ $aru_ready == true ]]
systemctl is-active --quiet aru-selfhost.service
systemctl is-active --quiet aru-desire-turn-receiver.service
systemctl is-active --quiet aru-desire-dashboard.service
curl --fail --silent --max-time 2 http://127.0.0.1:18761/healthz >/dev/null
DEVICE_COUNT_AFTER=$(curl --fail --silent --max-time 2 \
  http://127.0.0.1:8788/aru/v1/diagnostics | \
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(String(JSON.parse(s).deviceCount)))")
readonly DEVICE_COUNT_AFTER
BRIDGE_CODE_AFTER=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:18110/bridge/v1/health)
readonly BRIDGE_CODE_AFTER
[[ $DEVICE_COUNT_AFTER == "$DEVICE_COUNT_BEFORE" ]]
[[ $BRIDGE_CODE_AFTER == "$BRIDGE_CODE_BEFORE" ]]

INSTALL_STAGE=enable_interaction_flags
node "$DESIRE_ROOT/scripts/set-interaction-flags.mjs" "$DESIRE_ROOT/config/default.json" \
  chatStimulusEnabled=true arousalEnabled=true \
  arousalDriveSettlementEnabled=true soloSessionsEnabled=false
node -e "const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(!c.chatStimulusEnabled||!c.arousalEnabled||!c.arousalDriveSettlementEnabled||c.soloSessionsEnabled)process.exit(1)" \
  "$DESIRE_ROOT/config/default.json"
systemctl restart aru-desire-turn-receiver.service
systemctl restart aru-desire-dashboard.service
systemctl is-active --quiet aru-desire-turn-receiver.service
systemctl is-active --quiet aru-desire-dashboard.service
readonly ACTIVATION_ID="activation-${STAMP}"
INSTALL_STAGE=synthetic_end_to_end
runuser -u aru-selfhost -- env \
  ARU_DESIRE_TURN_HOOK_ENABLED=true \
  ARU_DESIRE_TURN_HOOK_ENDPOINT=http://127.0.0.1:18761/v1/complete-message \
  ARU_DESIRE_TURN_HOOK_SECRET_FILE="$ARU_SECRET" \
  ARU_DESIRE_TURN_HOOK_TIMEOUT_MS=1000 \
  node "$NEW_RELEASE/synthetic-check.mjs" "$ACTIVATION_ID"
runuser -u aru-desire -- node "$DESIRE_ROOT/scripts/verify-synthetic-ledger.mjs" \
  "$DESIRE_ROOT/config/default.json" "$DESIRE_DATA" "$ACTIVATION_ID"
trap - ERR
printf 'installed complete-message hook; rollback backup: %s\n' "$BACKUP"
