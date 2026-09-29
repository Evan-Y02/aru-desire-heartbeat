#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

MODE=explicit
if [[ ${1:-} == --automatic ]]; then
  MODE=automatic
  shift
fi
readonly ATTEMPT=${1:-}
[[ $# -eq 1 ]] || { printf 'ACTIVE_UPGRADE_ROLLBACK=FAIL\n' >&2; exit 64; }

readonly SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
readonly SOURCE_ROOT="$(dirname -- "$SCRIPT_DIR")"
TEST_MODE=false
if [[ ${ARU_ACTIVE_UPGRADE_ISOLATED_TEST_MODE:-0} == 1 ]]; then
  TEST_MODE=true
  TEST_ROOT="$(readlink -f -- "${ARU_ACTIVE_UPGRADE_TEST_ROOT:?}")"
  [[ $TEST_ROOT == /tmp/* && $TEST_ROOT != /tmp ]] || exit 78
  ROOT_PREFIX=$TEST_ROOT
  SYSTEMCTL_BIN="${ARU_ACTIVE_UPGRADE_TEST_SYSTEMCTL:?}"
else
  [[ ${EUID} -eq 0 ]] || { printf 'ACTIVE_UPGRADE_ROLLBACK=FAIL\n' >&2; exit 77; }
  ROOT_PREFIX=
  SYSTEMCTL_BIN=/usr/bin/systemctl
fi

readonly CURRENT_LINK="$ROOT_PREFIX/opt/aru-selfhost/current"
readonly DESIRE_ROOT="$ROOT_PREFIX/opt/aru-desire-heartbeat"
readonly DATA_ROOT="$ROOT_PREFIX/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="$ROOT_PREFIX/etc/systemd/system"
readonly ENABLE_FILE="$ROOT_PREFIX/etc/aru-desire-heartbeat/external-trigger.enable"
readonly BACKUP_PARENT="$ROOT_PREFIX/var/backups/aru-desire-active-upgrades"
readonly TIMER=aru-desire-heartbeat.timer
readonly HEARTBEAT=aru-desire-heartbeat.service
readonly RECEIVER=aru-desire-turn-receiver.service
readonly DASHBOARD=aru-desire-dashboard.service
readonly ARU=aru-selfhost.service

DIAGNOSTIC_LOG="$(mktemp /tmp/aru-active-rollback-output.XXXXXXXXXXXXXXXX)"
chmod 0600 "$DIAGNOSTIC_LOG"
exec 3>&1 4>&2
exec >>"$DIAGNOSTIC_LOG" 2>&1
fail() {
  trap - ERR INT TERM
  printf 'ACTIVE_UPGRADE_ROLLBACK=FAIL\n' >&4
  rm -f -- "$DIAGNOSTIC_LOG"
  exit 1
}
trap fail ERR INT TERM
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
[[ $ATTEMPT == "$BACKUP_PARENT"/upgrade.* && -d $ATTEMPT && ! -L $ATTEMPT &&
   "$(readlink -f -- "$ATTEMPT")" == "$ATTEMPT" ]] || fail
[[ -f $ATTEMPT/status && ! -L $ATTEMPT/status ]] || fail
phase="$(sed -n 's/^phase=//p' "$ATTEMPT/status")"
if [[ $MODE == explicit ]]; then
  [[ $phase == upgraded ]] || fail
  sha256sum -c --quiet "$ATTEMPT/protected-state.sha256" || fail
else
  [[ $phase == prepared || $phase == quiesced || $phase == installing ||
     $phase == restoring || $phase == upgraded ]] || fail
fi
[[ -d $ATTEMPT/runtime && ! -L $ATTEMPT/runtime ]] || fail
[[ -d $ATTEMPT/release && ! -L $ATTEMPT/release ]] || fail
[[ -f $ATTEMPT/current-release && ! -L $ATTEMPT/current-release ]] || fail
OLD_RELEASE="$(<"$ATTEMPT/current-release")"
[[ $OLD_RELEASE == "$ROOT_PREFIX"/opt/aru-selfhost/releases/* &&
   -d $OLD_RELEASE && ! -L $OLD_RELEASE ]] || fail
diff -qr -- "$ATTEMPT/release" "$OLD_RELEASE" >/dev/null || fail

state_value() {
  local unit=$1 kind=$2
  sed -n "s/^${unit//./\\.}\.${kind}=//p" "$ATTEMPT/service-states"
}
restore_enabled() {
  local unit=$1 value
  value="$(state_value "$unit" enabled)"
  case $value in
    enabled) "$SYSTEMCTL_BIN" enable "$unit" >/dev/null ;;
    disabled) "$SYSTEMCTL_BIN" disable "$unit" >/dev/null ;;
    static) ;;
    *) return 1 ;;
  esac
}
restore_active() {
  local unit=$1 value
  value="$(state_value "$unit" active)"
  case $value in
    active) "$SYSTEMCTL_BIN" start "$unit" >/dev/null ;;
    inactive|failed) "$SYSTEMCTL_BIN" stop "$unit" >/dev/null ;;
    *) return 1 ;;
  esac
}

"$SYSTEMCTL_BIN" stop "$TIMER" "$HEARTBEAT" "$RECEIVER" "$ARU" "$DASHBOARD" >/dev/null

RESTORE_STAGE="$(mktemp -d "$(dirname -- "$DESIRE_ROOT")/.aru-active-rollback.XXXXXXXXXXXXXXXX")"
cp -a -- "$ATTEMPT/runtime/." "$RESTORE_STAGE/"
if [[ -e $DESIRE_ROOT || -L $DESIRE_ROOT ]]; then
  FAILED_RUNTIME="$ATTEMPT/replaced-runtime"
  [[ ! -e $FAILED_RUNTIME && ! -L $FAILED_RUNTIME ]] || fail
  mv -- "$DESIRE_ROOT" "$FAILED_RUNTIME"
fi
mv -- "$RESTORE_STAGE" "$DESIRE_ROOT"

ln -s -- "$OLD_RELEASE" "${CURRENT_LINK}.active-rollback"
mv -Tf -- "${CURRENT_LINK}.active-rollback" "$CURRENT_LINK"
for unit in "$HEARTBEAT" "$TIMER" "$RECEIVER" "$DASHBOARD"; do
  install_owned -o root -g root -m 0644 "$ATTEMPT/systemd/$unit" "$UNIT_DIR/$unit"
done
install_owned -D -o root -g root -m 0644 "$ATTEMPT/systemd/desire-turn-hook.conf" \
  "$UNIT_DIR/aru-selfhost.service.d/desire-turn-hook.conf"
if [[ -f $ATTEMPT/enable-marker ]]; then
  install_owned -D -o root -g aru-desire -m 0640 "$ATTEMPT/enable-marker" "$ENABLE_FILE"
else
  rm -f -- "$ENABLE_FILE"
fi
"$SYSTEMCTL_BIN" daemon-reload >/dev/null
for unit in "$RECEIVER" "$DASHBOARD" "$ARU" "$TIMER"; do restore_enabled "$unit"; done
restore_active "$RECEIVER"
restore_active "$ARU"
restore_active "$DASHBOARD"
restore_active "$HEARTBEAT"
restore_active "$TIMER"

sha256sum -c --quiet "$ATTEMPT/protected-state.sha256" || fail
printf 'phase=rolled-back\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
rm -f -- "$DIAGNOSTIC_LOG"
printf 'ACTIVE_UPGRADE_ROLLBACK=PASS\nrestored_version=%s\n' \
  "$(node -p "require('$DESIRE_ROOT/package.json').version")" >&3
printf 'timer_enabled=%s\ntimer_active=%s\nbackup=%s\n' \
  "$("$SYSTEMCTL_BIN" is-enabled "$TIMER" 2>/dev/null || true)" \
  "$("$SYSTEMCTL_BIN" is-active "$TIMER" 2>/dev/null || true)" "$ATTEMPT" >&3
