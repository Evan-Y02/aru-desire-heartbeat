#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo 'must run as root' >&2; exit 77; }
[[ $# -eq 1 ]] || {
  echo 'usage: install-complete-message-hook-once.sh /absolute/path/to/v0.9.11/source' >&2
  exit 64
}

SCRIPT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly SCRIPT_ROOT
SOURCE_ROOT=$(readlink -f -- "$1")
readonly SOURCE_ROOT
[[ $SOURCE_ROOT == "$SCRIPT_ROOT" ]] || {
  echo 'source root must be the checkout containing this installer' >&2
  exit 64
}
SOURCE_VERSION=$(node - "$SOURCE_ROOT/package.json" <<'NODE'
const fs = require('fs');
process.stdout.write(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).version);
NODE
)
readonly SOURCE_VERSION
[[ $SOURCE_VERSION == 0.9.11 ]] || {
  echo 'installer requires source version 0.9.11' >&2
  exit 64
}

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

readonly CURRENT_LINK=/opt/aru-selfhost/current
OLD_RELEASE=$(readlink -f "$CURRENT_LINK")
readonly OLD_RELEASE
INSTALL_EPOCH=$(date -u +%s)
readonly INSTALL_EPOCH
STAMP=$(date -u -d "@$INSTALL_EPOCH" +%Y%m%dT%H%M%SZ)
readonly STAMP
INSTALLED_AT=$(date -u -d "@$INSTALL_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
readonly INSTALLED_AT
readonly NEW_RELEASE="/opt/aru-selfhost/releases/v0.30.2-pairing-hotfix1-turn-hook-${STAMP}"
readonly BACKUP="/var/backups/aru-desire-turn-hook/${STAMP}"
readonly DESIRE_ROOT=/opt/aru-desire-heartbeat
readonly DESIRE_DATA=/var/lib/aru-desire-heartbeat
readonly ARU_SECRET=/var/lib/aru-selfhost/desire-turn-hook.secret
readonly DESIRE_SECRET=${DESIRE_DATA}/turn-hook.secret
readonly RECEIVER_UNIT=/etc/systemd/system/aru-desire-turn-receiver.service
readonly ARU_DROPIN=/etc/systemd/system/aru-selfhost.service.d/desire-turn-hook.conf
readonly HEARTBEAT_SERVICE=aru-desire-heartbeat.service
readonly HEARTBEAT_TIMER=aru-desire-heartbeat.timer
readonly RUNTIME_MANIFEST=release-manifest.json
readonly DEPLOYMENT_METADATA=deployment-metadata.json
HEARTBEAT_TIMER_TOUCHED=false
ARU_WAS_ACTIVE=$(systemctl is-active aru-selfhost.service || true)
readonly ARU_WAS_ACTIVE
DASHBOARD_WAS_ACTIVE=$(systemctl is-active aru-desire-dashboard.service || true)
readonly DASHBOARD_WAS_ACTIVE
RECEIVER_WAS_ACTIVE=$(systemctl is-active aru-desire-turn-receiver.service || true)
readonly RECEIVER_WAS_ACTIVE
RECEIVER_WAS_ENABLED=$(systemctl is-enabled aru-desire-turn-receiver.service 2>/dev/null || true)
readonly RECEIVER_WAS_ENABLED
HEARTBEAT_TIMER_WAS_ACTIVE=$(systemctl is-active "$HEARTBEAT_TIMER" || true)
readonly HEARTBEAT_TIMER_WAS_ACTIVE
HEARTBEAT_TIMER_WAS_ENABLED=$(systemctl is-enabled "$HEARTBEAT_TIMER" 2>/dev/null || true)
readonly HEARTBEAT_TIMER_WAS_ENABLED
INSTALL_STAGE=baseline_health
[[ -d $SOURCE_ROOT && ! -L $SOURCE_ROOT ]]
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
[[ -f $ARU_SECRET && ! -L $ARU_SECRET && -f $DESIRE_SECRET && ! -L $DESIRE_SECRET ]] || {
  echo 'v0.9.11 safety upgrade requires the existing owner-only hook secret channel' >&2
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
readonly SECRET_CHANNEL_BEFORE=present

runtime_release_output=$(node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" \
  list "$SOURCE_ROOT")
mapfile -t RUNTIME_RELEASE_FILES <<< "$runtime_release_output"
unset runtime_release_output
[[ ${#RUNTIME_RELEASE_FILES[@]} -gt 0 ]]
for required in src/engine.mjs src/runtime.mjs src/timeline.mjs src/pending-decision.mjs; do
  [[ " ${RUNTIME_RELEASE_FILES[*]} " == *" $required "* ]]
done
readonly RUNTIME_COPY_FILES=(
  config/default.json
  "${RUNTIME_RELEASE_FILES[@]}"
)
readonly DESIRE_FILES=(
  "${RUNTIME_COPY_FILES[@]}"
  "$RUNTIME_MANIFEST"
  "$DEPLOYMENT_METADATA"
)
[[ -f $DESIRE_ROOT/config/aru-delivery.json && ! -L $DESIRE_ROOT/config/aru-delivery.json ]]

INSTALL_STAGE=isolated_aru_service_identity_preflight
bash "$SOURCE_ROOT/scripts/test-aru-patched-release-as-service-user.sh" "$SOURCE_ROOT"

INSTALL_STAGE=backup
mkdir -p "$BACKUP/aru" "$BACKUP/desire" "$BACKUP/systemd"
chmod 0700 "$BACKUP"
node "$SOURCE_ROOT/scripts/preserve-feature-flags.mjs" capture \
  "$DESIRE_ROOT/config/default.json" "$BACKUP/feature-flags.json"
node "$SOURCE_ROOT/scripts/preserve-feature-flags.mjs" require-safe \
  "$DESIRE_ROOT/config/default.json"
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
  rollback_run remove_staged_current_link rm -f "${CURRENT_LINK}.next"
  rollback_run remove_temporary_current_link rm -f "${CURRENT_LINK}.rollback"
  rollback_run remove_temporary_deployment_metadata rm -f \
    "$DESIRE_ROOT/${DEPLOYMENT_METADATA}.next"
  rollback_run remove_temporary_runtime_manifest rm -f \
    "$DESIRE_ROOT/${RUNTIME_MANIFEST}.next"
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
  if [[ $RECEIVER_WAS_ACTIVE == active && -f $BACKUP/desire/config/default.json ]]; then
    rollback_run disable_interaction_for_receiver_restore node \
      "$SOURCE_ROOT/scripts/set-interaction-flags.mjs" "$DESIRE_ROOT/config/default.json" \
      chatStimulusEnabled=false arousalEnabled=false \
      arousalDriveSettlementEnabled=false soloSessionsEnabled=false
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
  if [[ $RECEIVER_WAS_ACTIVE == active && -f $BACKUP/desire/config/default.json ]]; then
    rollback_run restore_exact_config_after_receiver_start cp -a -- \
      "$BACKUP/desire/config/default.json" "$DESIRE_ROOT/config/default.json"
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
  if [[ $HEARTBEAT_TIMER_TOUCHED == true ]]; then
    if [[ $HEARTBEAT_TIMER_WAS_ACTIVE == active ]]; then
      rollback_run restore_heartbeat_timer_active systemctl start "$HEARTBEAT_TIMER"
    else
      rollback_run restore_heartbeat_timer_inactive systemctl stop "$HEARTBEAT_TIMER"
    fi
    restored_timer_enabled=$(systemctl is-enabled "$HEARTBEAT_TIMER" 2>/dev/null || true)
    [[ $restored_timer_enabled == "$HEARTBEAT_TIMER_WAS_ENABLED" ]] || {
      printf 'ERROR: rollback step failed: restore_heartbeat_timer_enabled_state\n' >&2
      rollback_failed=1
    }
  fi
  return "$rollback_failed"
}

INSTALL_STAGE=quiesce_heartbeat
HEARTBEAT_TIMER_TOUCHED=true
systemctl stop "$HEARTBEAT_TIMER"
for _ in {1..50}; do
  [[ $(systemctl is-active "$HEARTBEAT_SERVICE" || true) != active ]] && break
  sleep 0.1
done
[[ $(systemctl is-active "$HEARTBEAT_SERVICE" || true) != active ]]

INSTALL_STAGE=quiesce_message_state_writers
systemctl stop aru-selfhost.service aru-desire-turn-receiver.service
[[ $(systemctl is-active aru-selfhost.service || true) != active ]]
[[ $(systemctl is-active aru-desire-turn-receiver.service || true) != active ]]

INSTALL_STAGE=stage_aru_release
cp -a "$OLD_RELEASE" "$NEW_RELEASE"
install -o root -g root -m 0755 "$SOURCE_ROOT/aru-hook/aru-desire-turn-hook.mjs" \
  "$NEW_RELEASE/aru-desire-turn-hook.mjs"
install -o root -g root -m 0755 "$SOURCE_ROOT/aru-hook/synthetic-check.mjs" \
  "$NEW_RELEASE/synthetic-check.mjs"
install -o root -g root -m 0644 "$SOURCE_ROOT/aru-hook/aru-desire-relay-turn.mjs" \
  "$NEW_RELEASE/aru-desire-relay-turn.mjs"
node "$SOURCE_ROOT/aru-hook/apply-server-wiring.mjs" \
  "$NEW_RELEASE/server.mjs" "$NEW_RELEASE/conversation-turn-relay.mjs"
chown --reference="$OLD_RELEASE/server.mjs" "$NEW_RELEASE/server.mjs"
chmod --reference="$OLD_RELEASE/server.mjs" "$NEW_RELEASE/server.mjs"
chown --reference="$OLD_RELEASE/conversation-turn-relay.mjs" \
  "$NEW_RELEASE/conversation-turn-relay.mjs"
chmod --reference="$OLD_RELEASE/conversation-turn-relay.mjs" \
  "$NEW_RELEASE/conversation-turn-relay.mjs"
[[ $(stat -c '%u:%g:%a' "$NEW_RELEASE/server.mjs") == \
  "$(stat -c '%u:%g:%a' "$OLD_RELEASE/server.mjs")" ]]
node --check "$NEW_RELEASE/server.mjs"
node --check "$NEW_RELEASE/aru-desire-turn-hook.mjs"
node --check "$NEW_RELEASE/aru-desire-relay-turn.mjs"
node --check "$NEW_RELEASE/conversation-turn-relay.mjs"
node --check "$NEW_RELEASE/synthetic-check.mjs"

INSTALL_STAGE=stage_desire_runtime
for file in "${RUNTIME_COPY_FILES[@]}"; do
  mode=0644
  [[ $file == bin/* || $file == scripts/* ]] && mode=0755
  install -D -o root -g root -m "$mode" "$SOURCE_ROOT/$file" "$DESIRE_ROOT/$file"
done
INSTALL_STAGE=verify_desire_runtime_release
node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" verify \
  "$SOURCE_ROOT" "$DESIRE_ROOT" >/dev/null
INSTALL_STAGE=create_runtime_release_manifest
node "$SOURCE_ROOT/scripts/runtime-release-manifest.mjs" create \
  "$SOURCE_ROOT" > "$BACKUP/runtime-release-manifest.new.json"
chmod 0600 "$BACKUP/runtime-release-manifest.new.json"
node "$SOURCE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$SOURCE_ROOT" "$BACKUP/runtime-release-manifest.new.json" >/dev/null
install -o root -g root -m 0644 "$BACKUP/runtime-release-manifest.new.json" \
  "$DESIRE_ROOT/${RUNTIME_MANIFEST}.next"
node "$SOURCE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$DESIRE_ROOT/${RUNTIME_MANIFEST}.next" >/dev/null
mv -Tf "$DESIRE_ROOT/${RUNTIME_MANIFEST}.next" "$DESIRE_ROOT/$RUNTIME_MANIFEST"
install -o root -g root -m 0644 "$BACKUP/runtime-release-manifest.new.json" \
  "$NEW_RELEASE/$RUNTIME_MANIFEST"
node "$SOURCE_ROOT/scripts/formal-release-layout.mjs" create \
  "$NEW_RELEASE" "$OLD_RELEASE" "$BACKUP" "$INSTALLED_AT" \
  > "$BACKUP/deployment-metadata.new.json"
chmod 0600 "$BACKUP/deployment-metadata.new.json"
node "$SOURCE_ROOT/scripts/formal-release-layout.mjs" metadata \
  "$BACKUP/deployment-metadata.new.json" >/dev/null
INSTALL_STAGE=verify_runtime_manifest_before_current_activation
node "$DESIRE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$DESIRE_ROOT/$RUNTIME_MANIFEST" >/dev/null
node "$DESIRE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$NEW_RELEASE/$RUNTIME_MANIFEST" >/dev/null
cmp -s -- "$DESIRE_ROOT/$RUNTIME_MANIFEST" "$NEW_RELEASE/$RUNTIME_MANIFEST"
[[ $(stat -c '%U:%G:%a:%h' "$DESIRE_ROOT/$RUNTIME_MANIFEST") == 'root:root:644:1' ]]
[[ $(stat -c '%U:%G:%a:%h' "$NEW_RELEASE/$RUNTIME_MANIFEST") == 'root:root:644:1' ]]

INSTALL_STAGE=isolated_synthetic_acceptance
env -u ARU_DESIRE_ISOLATED_TEST_MODE \
  -u ARU_DESIRE_ISOLATED_TMP_PARENT \
  -u ARU_DESIRE_ISOLATED_FORCE_FAILURE \
  -u ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS \
  bash "$SOURCE_ROOT/scripts/test-installed-hook-isolated-state.sh" \
  "$SOURCE_ROOT" "$DESIRE_ROOT" "$NEW_RELEASE"

INSTALL_STAGE=verify_local_channel_preserved
cmp -s -- "$ARU_SECRET" "$DESIRE_SECRET"
[[ $(stat -c '%U:%G:%a:%h' "$ARU_SECRET") == 'aru-selfhost:aru-selfhost:600:1' ]]
[[ $(stat -c '%U:%G:%a:%h' "$DESIRE_SECRET") == 'aru-desire:aru-desire:600:1' ]]

install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/aru-desire-turn-receiver.service" "$RECEIVER_UNIT"
install -D -o root -g root -m 0644 "$SOURCE_ROOT/systemd/aru-selfhost-desire-turn-hook.conf" "$ARU_DROPIN"
cmp -s -- "$SOURCE_ROOT/systemd/aru-desire-turn-receiver.service" "$RECEIVER_UNIT"
cmp -s -- "$SOURCE_ROOT/systemd/aru-selfhost-desire-turn-hook.conf" "$ARU_DROPIN"
node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" verify \
  "$SOURCE_ROOT" "$DESIRE_ROOT" >/dev/null
node "$DESIRE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$DESIRE_ROOT/$RUNTIME_MANIFEST" >/dev/null
INSTALL_STAGE=prepare_current_release
[[ ! -e ${CURRENT_LINK}.next && ! -L ${CURRENT_LINK}.next ]]
ln -s "$NEW_RELEASE" "${CURRENT_LINK}.next"
[[ $(readlink -f "${CURRENT_LINK}.next") == "$NEW_RELEASE" ]]
INSTALL_STAGE=activate_current_release
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
INSTALL_STAGE=activate_deployment_metadata
install -o root -g root -m 0644 "$BACKUP/deployment-metadata.new.json" \
  "$DESIRE_ROOT/${DEPLOYMENT_METADATA}.next"
mv -Tf "$DESIRE_ROOT/${DEPLOYMENT_METADATA}.next" \
  "$DESIRE_ROOT/$DEPLOYMENT_METADATA"
INSTALL_STAGE=verify_runtime_manifest_after_current_activation
node "$SOURCE_ROOT/scripts/formal-release-layout.mjs" verify \
  "$CURRENT_LINK" "$DESIRE_ROOT" "$DESIRE_ROOT/$DEPLOYMENT_METADATA" >/dev/null
[[ $(stat -c '%U:%G:%a:%h' "$DESIRE_ROOT/$DEPLOYMENT_METADATA") == 'root:root:644:1' ]]

INSTALL_STAGE=temporarily_disable_interaction_flags
node "$DESIRE_ROOT/scripts/set-interaction-flags.mjs" "$DESIRE_ROOT/config/default.json" \
  chatStimulusEnabled=false arousalEnabled=false \
  arousalDriveSettlementEnabled=false soloSessionsEnabled=false

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
systemctl is-active --quiet aru-desire-turn-receiver.service
curl --fail --silent --max-time 2 http://127.0.0.1:18761/healthz >/dev/null

INSTALL_STAGE=enable_interaction_flags
node "$DESIRE_ROOT/scripts/preserve-feature-flags.mjs" restore \
  "$DESIRE_ROOT/config/default.json" "$BACKUP/feature-flags.json"
node "$DESIRE_ROOT/scripts/preserve-feature-flags.mjs" verify \
  "$DESIRE_ROOT/config/default.json" "$BACKUP/feature-flags.json"
node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" verify \
  "$SOURCE_ROOT" "$DESIRE_ROOT" >/dev/null
node "$DESIRE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$DESIRE_ROOT/$RUNTIME_MANIFEST" >/dev/null
node "$SOURCE_ROOT/scripts/formal-release-layout.mjs" verify \
  "$CURRENT_LINK" "$DESIRE_ROOT" "$DESIRE_ROOT/$DEPLOYMENT_METADATA" >/dev/null
systemctl is-active --quiet aru-desire-turn-receiver.service
systemctl is-active --quiet aru-desire-dashboard.service

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
DEVICE_COUNT_AFTER=$(curl --fail --silent --max-time 2 \
  http://127.0.0.1:8788/aru/v1/diagnostics | \
  node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(String(JSON.parse(s).deviceCount)))")
readonly DEVICE_COUNT_AFTER
BRIDGE_CODE_AFTER=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' \
  http://127.0.0.1:18110/bridge/v1/health)
readonly BRIDGE_CODE_AFTER
[[ $DEVICE_COUNT_AFTER == "$DEVICE_COUNT_BEFORE" ]]
[[ $BRIDGE_CODE_AFTER == "$BRIDGE_CODE_BEFORE" ]]
INSTALL_STAGE=restore_service_states
if [[ $RECEIVER_WAS_ENABLED == enabled ]]; then
  systemctl enable aru-desire-turn-receiver.service >/dev/null
else
  systemctl disable aru-desire-turn-receiver.service >/dev/null
fi
[[ $RECEIVER_WAS_ACTIVE == active ]] || systemctl stop aru-desire-turn-receiver.service
[[ $DASHBOARD_WAS_ACTIVE == active ]] || systemctl stop aru-desire-dashboard.service
[[ $ARU_WAS_ACTIVE == active ]] || systemctl stop aru-selfhost.service
[[ $(systemctl is-active aru-selfhost.service || true) == "$ARU_WAS_ACTIVE" ]]
[[ $(systemctl is-active aru-desire-turn-receiver.service || true) == "$RECEIVER_WAS_ACTIVE" ]]
[[ $(systemctl is-active aru-desire-dashboard.service || true) == "$DASHBOARD_WAS_ACTIVE" ]]
[[ $(systemctl is-enabled aru-desire-turn-receiver.service 2>/dev/null || true) == \
  "$RECEIVER_WAS_ENABLED" ]]
INSTALL_STAGE=restore_heartbeat_timer
if [[ $HEARTBEAT_TIMER_WAS_ACTIVE == active ]]; then
  systemctl start "$HEARTBEAT_TIMER"
else
  systemctl stop "$HEARTBEAT_TIMER"
fi
[[ $(systemctl is-active "$HEARTBEAT_TIMER" || true) == "$HEARTBEAT_TIMER_WAS_ACTIVE" ]]
[[ $(systemctl is-enabled "$HEARTBEAT_TIMER" 2>/dev/null || true) == \
  "$HEARTBEAT_TIMER_WAS_ENABLED" ]]
trap - ERR
printf 'installed complete-message hook; rollback backup: %s\n' "$BACKUP"
