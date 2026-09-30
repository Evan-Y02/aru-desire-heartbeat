#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE=${1:-}
readonly SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
readonly SOURCE_ROOT="$(dirname -- "$SCRIPT_DIR")"
readonly TARGET_VERSION=0.9.17
readonly ROLLBACK_SCRIPT="$SCRIPT_DIR/rollback-active-production-upgrade.sh"

TEST_MODE=false
if [[ ${ARU_ACTIVE_UPGRADE_ISOLATED_TEST_MODE:-0} == 1 ]]; then
  TEST_MODE=true
  TEST_ROOT="$(readlink -f -- "${ARU_ACTIVE_UPGRADE_TEST_ROOT:?}")"
  [[ $TEST_ROOT == /tmp/* && $TEST_ROOT != /tmp ]] || exit 78
  ROOT_PREFIX=$TEST_ROOT
  SYSTEMCTL_BIN="${ARU_ACTIVE_UPGRADE_TEST_SYSTEMCTL:?}"
  INSTALLER="${ARU_ACTIVE_UPGRADE_TEST_INSTALLER:?}"
  DASHBOARD_HEALTH_URL="${ARU_ACTIVE_UPGRADE_TEST_DASHBOARD_HEALTH_URL:?}"
else
  [[ ${EUID} -eq 0 ]] || { printf 'ACTIVE_UPGRADE=FAIL\nstage=initialization\n' >&2; exit 77; }
  ROOT_PREFIX=
  SYSTEMCTL_BIN=/usr/bin/systemctl
  INSTALLER="$SCRIPT_DIR/install-complete-message-hook-once.sh"
  DASHBOARD_HEALTH_URL=http://127.0.0.1:18760/healthz
fi

readonly CURRENT_LINK="$ROOT_PREFIX/opt/aru-selfhost/current"
readonly DESIRE_ROOT="$ROOT_PREFIX/opt/aru-desire-heartbeat"
readonly DATA_ROOT="$ROOT_PREFIX/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="$ROOT_PREFIX/etc/systemd/system"
readonly ENABLE_FILE="$ROOT_PREFIX/etc/aru-desire-heartbeat/external-trigger.enable"
readonly CREDENTIAL="$DATA_ROOT/external-trigger.send-credential"
readonly BACKUP_PARENT="$ROOT_PREFIX/var/backups/aru-desire-active-upgrades"
readonly RELEASE_PREFIX="$ROOT_PREFIX/opt/aru-selfhost/releases/"
readonly INSTALL_BACKUP_PREFIX="$ROOT_PREFIX/var/backups/aru-desire-turn-hook/"
readonly TIMER=aru-desire-heartbeat.timer
readonly HEARTBEAT=aru-desire-heartbeat.service
readonly RECEIVER=aru-desire-turn-receiver.service
readonly DASHBOARD=aru-desire-dashboard.service
readonly ARU=aru-selfhost.service

DIAGNOSTIC_LOG="$(mktemp /tmp/aru-active-upgrade-output.XXXXXXXXXXXXXXXX)"
chmod 0600 "$DIAGNOSTIC_LOG"
exec 3>&1 4>&2
exec >>"$DIAGNOSTIC_LOG" 2>&1

STAGE=initialization
ATTEMPT=
ROLLBACK_READY=false
TEMP_ROOT=
FAILURE_CLASS=

print_failure() {
  printf 'ACTIVE_UPGRADE=FAIL\nstage=%s\n' "$STAGE" >&4
  [[ -z $FAILURE_CLASS ]] || printf 'failure_class=%s\n' "$FAILURE_CLASS" >&4
}

fail() {
  trap - ERR EXIT INT TERM
  FAILURE_CLASS=${1:-$FAILURE_CLASS}
  print_failure
  rm -f -- "$DIAGNOSTIC_LOG"
  exit 1
}
install_owned() {
  if [[ $TEST_MODE == true ]]; then
    local arguments=()
    while [[ $# -gt 0 ]]; do
      case $1 in -o|-g) shift 2 ;; *) arguments+=("$1"); shift ;; esac
    done
    install "${arguments[@]}"
  else
    install "$@"
  fi
}
checkpoint() {
  if [[ $TEST_MODE == true && ${ARU_ACTIVE_UPGRADE_FAIL_STAGE:-} == "$1" ]]; then return 97; fi
}
systemd_unit_equivalent() {
  node "$SCRIPT_DIR/active-production-upgrade-preflight.mjs" \
    --compare-systemd-unit "$1" "$2"
}
handle_error() {
  local status=$?
  trap - ERR EXIT INT TERM
  set +e
  print_failure
  if [[ $ROLLBACK_READY == true ]]; then
    if "$ROLLBACK_SCRIPT" --automatic "$ATTEMPT" \
        >"$ATTEMPT/automatic-rollback.log" 2>&1; then
      chmod 0600 "$ATTEMPT/automatic-rollback.log"
      printf 'automatic_rollback=PASS\nbackup=%s\n' "$ATTEMPT" >&4
    else
      printf 'automatic_rollback=FAIL\nbackup=%s\n' "$ATTEMPT" >&4
    fi
  fi
  [[ -z $TEMP_ROOT ]] || rm -rf -- "$TEMP_ROOT"
  rm -f -- "$DIAGNOSTIC_LOG"
  exit "$status"
}
trap handle_error ERR INT TERM

[[ $MODE == --apply && $# -eq 1 ]] || fail
for command in node bash cp cmp diff curl id install mktemp mv rm sha256sum stat readlink sed chmod; do
  command -v "$command" >/dev/null 2>&1 || fail
done
[[ -x $ROLLBACK_SCRIPT && -x $INSTALLER ]] || fail
[[ -d $SOURCE_ROOT && ! -L $SOURCE_ROOT ]] || fail

TEMP_ROOT="$(mktemp -d /tmp/aru-active-upgrade-preflight.XXXXXXXXXXXXXXXX)"
PREFLIGHT_OPTIONS="$TEMP_ROOT/options.json"
node -e '
 const fs=require("fs"); const a=process.argv.slice(1);
 const keys=["sourceRoot","heartbeatRoot","dataRoot","currentLink","releasePrefix",
 "installBackupPrefix","credentialPath","enableFile","targetVersion","sourceUid",
 "serviceUid","serviceGid"];
 const o=Object.fromEntries(keys.map((k,i)=>[k,a[i]]));
 for(const key of ["sourceUid","serviceUid","serviceGid"]) o[key]=Number(o[key]);
 o.enforceOwnership=a[12]==="true"; fs.writeFileSync(a[13],JSON.stringify(o));
' "$SOURCE_ROOT" "$DESIRE_ROOT" "$DATA_ROOT" "$CURRENT_LINK" "$RELEASE_PREFIX" \
  "$INSTALL_BACKUP_PREFIX" "$CREDENTIAL" "$ENABLE_FILE" "$TARGET_VERSION" \
  "$(id -u xinchao 2>/dev/null || id -u)" "$(id -u aru-desire 2>/dev/null || id -u)" \
  "$(id -g aru-desire 2>/dev/null || id -g)" \
  "$([[ $TEST_MODE == false ]] && printf true || printf false)" "$PREFLIGHT_OPTIONS"
STAGE=preflight
if ! PREFLIGHT_OUTPUT="$(node "$SCRIPT_DIR/active-production-upgrade-preflight.mjs" "$PREFLIGHT_OPTIONS")"; then
  FAILURE_CLASS="$(sed -n 's/^failure_class=//p' <<< "$PREFLIGHT_OUTPUT")"
  case $FAILURE_CLASS in
    source_package_file|installed_package_file|target_version|installed_version|already_installed|\
    source_manifest|formal_layout|heartbeat_config_file|delivery_config_file|\
    runtime_primary_file|runtime_interaction_file|heartbeat_config_schema|\
    delivery_config_schema|runtime_primary_schema|runtime_interaction_schema|\
    runtime_not_idle|production_gates|delivery_binding|delivery_auth_file|\
    delivery_marker_file|delivery_marker_content|release_identity) ;;
    *) FAILURE_CLASS=internal_preflight_failed ;;
  esac
  fail
fi
grep -qx 'ACTIVE_UPGRADE_PREFLIGHT=PASS' <<< "$PREFLIGHT_OUTPUT" || fail internal_preflight_output
OLD_VERSION="$(sed -n 's/^old_version=//p' <<< "$PREFLIGHT_OUTPUT")"
[[ $OLD_VERSION == 0.9.14 || $OLD_VERSION == 0.9.15 || $OLD_VERSION == 0.9.16 ]] || \
  fail installed_version
[[ "$("$SYSTEMCTL_BIN" is-enabled "$TIMER" 2>/dev/null || true)" == enabled ]] || \
  fail timer_not_enabled
[[ "$("$SYSTEMCTL_BIN" is-active "$TIMER" 2>/dev/null || true)" == active ]] || \
  fail timer_not_active
[[ "$("$SYSTEMCTL_BIN" is-active "$HEARTBEAT" 2>/dev/null || true)" == inactive ]] || \
  fail heartbeat_not_inactive
for unit in "$HEARTBEAT" "$TIMER" "$RECEIVER" "$DASHBOARD"; do
  case $unit in
    "$HEARTBEAT") unit_class=heartbeat ;;
    "$TIMER") unit_class=timer ;;
    "$RECEIVER") unit_class=receiver ;;
    "$DASHBOARD") unit_class=dashboard ;;
  esac
  [[ -f $UNIT_DIR/$unit && ! -L $UNIT_DIR/$unit ]] || fail "${unit_class}_unit_file_unsafe"
  systemd_unit_equivalent "$SOURCE_ROOT/systemd/$unit" "$UNIT_DIR/$unit" || \
    fail "${unit_class}_unit_content_mismatch"
done
cmp -s -- "$SOURCE_ROOT/systemd/aru-selfhost-desire-turn-hook.conf" \
  "$UNIT_DIR/aru-selfhost.service.d/desire-turn-hook.conf" || fail selfhost_dropin_mismatch

FAILURE_CLASS=
STAGE=backup
if [[ -e $BACKUP_PARENT || -L $BACKUP_PARENT ]]; then
  [[ -d $BACKUP_PARENT && ! -L $BACKUP_PARENT ]] || fail
  if [[ $TEST_MODE == false ]]; then
    [[ "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 ]] || fail
  fi
else
  install_owned -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/upgrade.XXXXXXXXXXXXXXXX")"
chmod 0700 "$ATTEMPT"
printf 'phase=preparing\n' > "$ATTEMPT/status"
cp -a -- "$DESIRE_ROOT" "$ATTEMPT/runtime"
OLD_RELEASE="$(readlink -f -- "$CURRENT_LINK")"
cp -a -- "$OLD_RELEASE" "$ATTEMPT/release"
printf '%s\n' "$OLD_RELEASE" > "$ATTEMPT/current-release"
install -d -m 0700 "$ATTEMPT/systemd" "$ATTEMPT/manifests"
for unit in "$HEARTBEAT" "$TIMER" "$RECEIVER" "$DASHBOARD"; do
  cp -a -- "$UNIT_DIR/$unit" "$ATTEMPT/systemd/$unit"
done
cp -a -- "$UNIT_DIR/aru-selfhost.service.d/desire-turn-hook.conf" \
  "$ATTEMPT/systemd/desire-turn-hook.conf"
cp -a -- "$DESIRE_ROOT/release-manifest.json" "$ATTEMPT/manifests/runtime.json"
cp -a -- "$OLD_RELEASE/release-manifest.json" "$ATTEMPT/manifests/release.json"
cp -a -- "$DESIRE_ROOT/config/default.json" "$ATTEMPT/default.json"
cp -a -- "$DESIRE_ROOT/config/aru-delivery.json" "$ATTEMPT/aru-delivery.json"
cp -a -- "$DESIRE_ROOT/deployment-metadata.json" "$ATTEMPT/deployment-metadata.json"
cp -a -- "$ENABLE_FILE" "$ATTEMPT/enable-marker"
node "$SCRIPT_DIR/active-production-upgrade-gates.mjs" capture \
  "$DESIRE_ROOT/config/default.json" "$DESIRE_ROOT/config/aru-delivery.json" \
  "$ATTEMPT/gates.json"
for unit in "$HEARTBEAT" "$TIMER" "$RECEIVER" "$DASHBOARD" "$ARU"; do
  printf '%s.enabled=%s\n' "$unit" \
    "$("$SYSTEMCTL_BIN" is-enabled "$unit" 2>/dev/null || true)" >> "$ATTEMPT/service-states"
  printf '%s.active=%s\n' "$unit" \
    "$("$SYSTEMCTL_BIN" is-active "$unit" 2>/dev/null || true)" >> "$ATTEMPT/service-states"
done
sha256sum "$DATA_ROOT/state.json" "$DATA_ROOT/interaction-state.json" \
  > "$ATTEMPT/protected-state.sha256"
sha256sum -c --quiet "$ATTEMPT/protected-state.sha256"
printf 'phase=prepared\nold_version=%s\ntarget_version=%s\n' \
  "$OLD_VERSION" "$TARGET_VERSION" > "$ATTEMPT/status"
chmod 0700 "$ATTEMPT/manifests" "$ATTEMPT/systemd"
chmod 0600 "$ATTEMPT/status" "$ATTEMPT/current-release" "$ATTEMPT/default.json" \
  "$ATTEMPT/aru-delivery.json" "$ATTEMPT/deployment-metadata.json" \
  "$ATTEMPT/enable-marker" "$ATTEMPT/gates.json" "$ATTEMPT/service-states" \
  "$ATTEMPT/protected-state.sha256" "$ATTEMPT/manifests/"* "$ATTEMPT/systemd/"*
ROLLBACK_READY=true
trap handle_error ERR EXIT INT TERM
checkpoint after_backup

STAGE=quiesce
"$SYSTEMCTL_BIN" stop "$TIMER" >/dev/null
"$SYSTEMCTL_BIN" stop "$HEARTBEAT" "$RECEIVER" "$ARU" >/dev/null
[[ "$("$SYSTEMCTL_BIN" is-active "$TIMER" 2>/dev/null || true)" == inactive ]]
for unit in "$HEARTBEAT" "$RECEIVER" "$ARU"; do
  [[ "$("$SYSTEMCTL_BIN" is-active "$unit" 2>/dev/null || true)" == inactive ]]
done
sha256sum -c --quiet "$ATTEMPT/protected-state.sha256"
STAGE=quiesced_preflight
if ! QUIESCED_PREFLIGHT="$(node "$SCRIPT_DIR/active-production-upgrade-preflight.mjs" \
  "$PREFLIGHT_OPTIONS")"; then
  FAILURE_CLASS="$(sed -n 's/^failure_class=//p' <<< "$QUIESCED_PREFLIGHT")"
  [[ $FAILURE_CLASS =~ ^[a-z0-9_]+$ ]] || FAILURE_CLASS=internal_preflight_failed
  false
fi
grep -qx 'ACTIVE_UPGRADE_PREFLIGHT=PASS' <<< "$QUIESCED_PREFLIGHT" || {
  FAILURE_CLASS=internal_preflight_output
  false
}
FAILURE_CLASS=
printf 'phase=quiesced\n' > "$ATTEMPT/status"
checkpoint after_quiesce

STAGE=safe_gates
node "$SCRIPT_DIR/active-production-upgrade-gates.mjs" safe \
  "$DESIRE_ROOT/config/default.json" "$DESIRE_ROOT/config/aru-delivery.json" \
  "$ATTEMPT/gates.json"
sha256sum -c --quiet "$ATTEMPT/protected-state.sha256"
checkpoint after_safe_gates

STAGE=install
printf 'phase=installing\n' > "$ATTEMPT/status"
if [[ $TEST_MODE == true ]]; then
  "$INSTALLER" "$SOURCE_ROOT" "$ROOT_PREFIX" >"$ATTEMPT/installer.log" 2>&1
else
  "$INSTALLER" "$SOURCE_ROOT" >"$ATTEMPT/installer.log" 2>&1
fi
checkpoint after_install

STAGE=verify_install
[[ "$(node -p "require('$DESIRE_ROOT/package.json').version")" == "$TARGET_VERSION" ]]
node "$DESIRE_ROOT/scripts/runtime-release-manifest.mjs" verify \
  "$DESIRE_ROOT" "$DESIRE_ROOT/release-manifest.json" >/dev/null
if [[ $TEST_MODE == true ]]; then
  node --input-type=module -e '
    const {verifyFormalReleaseLayout}=await import(process.argv[1]);
    await verifyFormalReleaseLayout({currentLink:process.argv[2],heartbeatRoot:process.argv[3],
      metadataPath:process.argv[4],releasePrefix:process.argv[5],backupPrefix:process.argv[6]});
  ' "file://$SOURCE_ROOT/scripts/formal-release-layout.mjs" "$CURRENT_LINK" "$DESIRE_ROOT" \
    "$DESIRE_ROOT/deployment-metadata.json" "$RELEASE_PREFIX" "$INSTALL_BACKUP_PREFIX"
else
  node "$SOURCE_ROOT/scripts/formal-release-layout.mjs" verify \
    "$CURRENT_LINK" "$DESIRE_ROOT" "$DESIRE_ROOT/deployment-metadata.json" >/dev/null
fi
node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" verify \
  "$SOURCE_ROOT" "$DESIRE_ROOT" >/dev/null
sha256sum -c --quiet "$ATTEMPT/protected-state.sha256"

STAGE=restore_runtime_state
printf 'phase=restoring\n' > "$ATTEMPT/status"
node "$SCRIPT_DIR/active-production-upgrade-gates.mjs" restore \
  "$DESIRE_ROOT/config/default.json" "$DESIRE_ROOT/config/aru-delivery.json" \
  "$ATTEMPT/gates.json"
install_owned -D -o root -g aru-desire -m 0640 "$ATTEMPT/enable-marker" "$ENABLE_FILE"
node "$SCRIPT_DIR/active-production-upgrade-gates.mjs" verify \
  "$DESIRE_ROOT/config/default.json" "$DESIRE_ROOT/config/aru-delivery.json" \
  "$ATTEMPT/gates.json"
cmp -s -- "$ATTEMPT/enable-marker" "$ENABLE_FILE"
checkpoint after_restore_gates

restore_enabled() {
  local unit=$1 value
  value="$(sed -n "s/^${unit//./\\.}\.enabled=//p" "$ATTEMPT/service-states")"
  case $value in
    enabled) "$SYSTEMCTL_BIN" enable "$unit" >/dev/null ;;
    disabled) "$SYSTEMCTL_BIN" disable "$unit" >/dev/null ;;
    static) ;;
    *) return 1 ;;
  esac
}
restore_active() {
  local unit=$1 value
  value="$(sed -n "s/^${unit//./\\.}\.active=//p" "$ATTEMPT/service-states")"
  case $value in
    active) "$SYSTEMCTL_BIN" start "$unit" >/dev/null ;;
    inactive|failed) "$SYSTEMCTL_BIN" stop "$unit" >/dev/null ;;
    *) return 1 ;;
  esac
}
"$SYSTEMCTL_BIN" daemon-reload >/dev/null
for unit in "$RECEIVER" "$DASHBOARD" "$ARU" "$TIMER"; do restore_enabled "$unit"; done
restore_active "$RECEIVER"
restore_active "$ARU"
restore_active "$DASHBOARD"
restore_active "$HEARTBEAT"
restore_active "$TIMER"
checkpoint after_restore_services

STAGE=final_verify
sha256sum -c --quiet "$ATTEMPT/protected-state.sha256"
[[ "$("$SYSTEMCTL_BIN" is-enabled "$TIMER" 2>/dev/null || true)" == enabled ]]
[[ "$("$SYSTEMCTL_BIN" is-active "$TIMER" 2>/dev/null || true)" == active ]]
[[ "$("$SYSTEMCTL_BIN" is-active "$RECEIVER" 2>/dev/null || true)" == \
   "$(sed -n "s/^${RECEIVER//./\\.}\.active=//p" "$ATTEMPT/service-states")" ]]
curl --fail --silent --max-time 2 "$DASHBOARD_HEALTH_URL" >/dev/null
grep -q -F '射精与满足结算' "$DESIRE_ROOT/dashboard/public/index.html"
printf 'phase=upgraded\nold_version=%s\ntarget_version=%s\n' \
  "$OLD_VERSION" "$TARGET_VERSION" > "$ATTEMPT/status"
trap - ERR EXIT INT TERM
rm -rf -- "$TEMP_ROOT"
rm -f -- "$DIAGNOSTIC_LOG"
printf 'ACTIVE_UPGRADE=PASS\nold_version=%s\nnew_version=%s\n' \
  "$OLD_VERSION" "$TARGET_VERSION" >&3
printf 'autonomy=enabled\ndelivery=enabled\nadapter_gate=enabled\n' >&3
printf 'timer_enabled=enabled\ntimer_active=active\nstate_unchanged=yes\nbackup=%s\n' \
  "$ATTEMPT" >&3
printf 'rollback_command=sudo %s %s\n' "$ROLLBACK_SCRIPT" "$ATTEMPT" >&3
