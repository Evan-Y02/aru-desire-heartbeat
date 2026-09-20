#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly ATTEMPT="${1:-}"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-upgrades"
readonly CREDENTIAL="$DATA/external-trigger.send-credential"

CURRENT_MOVED=0
OLD_RESTORED=0
UNITS_RESTORED=0
STATE_BEFORE=""
CREDENTIAL_BEFORE=""
ORIGINAL_SERVICE_HASH=""
ORIGINAL_TIMER_HASH=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

restore_failed_rollback() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  if (( UNITS_RESTORED == 1 )); then
    [[ ! -f "$ATTEMPT/replaced-service" ]] || install -o root -g root -m 0644 "$ATTEMPT/replaced-service" "$UNIT_DIR/$SERVICE"
    [[ ! -f "$ATTEMPT/replaced-timer" ]] || install -o root -g root -m 0644 "$ATTEMPT/replaced-timer" "$UNIT_DIR/$TIMER"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  if (( CURRENT_MOVED == 1 )); then
    (( OLD_RESTORED == 0 )) || mv -- "$TARGET" "$ATTEMPT/original-app"
    [[ ! -d "$ATTEMPT/replaced-app" ]] || mv -- "$ATTEMPT/replaced-app" "$TARGET"
  fi
  printf 'ERROR: rollback failed; the upgraded application was restored when possible.\n' >&2
  exit "$status"
}

hash_optional_file() {
  local path=$1
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || die "protected path is unsafe: $path"
    sha256sum "$path" | cut -d ' ' -f 1
  else
    printf 'absent\n'
  fi
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
for command in node runuser stat readlink grep systemctl sha256sum cut mv chmod; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done
[[ -d "$DATA" && ! -L "$DATA" && "$(stat -c '%U:%G:%a' "$DATA")" == aru-desire:aru-desire:700 ]] \
  || die "production data directory is unsafe"
[[ -f "$DATA/state.json" && ! -L "$DATA/state.json" \
  && "$(stat -c '%U:%G:%a:%h' "$DATA/state.json")" == aru-desire:aru-desire:600:1 ]] \
  || die "production state is missing or unsafe"
if [[ -e "$CREDENTIAL" || -L "$CREDENTIAL" ]]; then
  [[ -f "$CREDENTIAL" && ! -L "$CREDENTIAL" \
    && "$(stat -c '%U:%G:%a:%h' "$CREDENTIAL")" == aru-desire:aru-desire:600:1 ]] \
    || die "production credential is unsafe"
fi
[[ "$ATTEMPT" == "$BACKUP_PARENT"/upgrade.* && -d "$ATTEMPT" && ! -L "$ATTEMPT" \
  && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
  && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]] || die "upgrade backup path is invalid"
[[ -f "$ATTEMPT/status" && ! -L "$ATTEMPT/status" ]] || die "upgrade status is missing or unsafe"
grep -qx 'phase=upgraded' "$ATTEMPT/status" || die "backup is not eligible for rollback"
[[ -d "$ATTEMPT/original-app" && ! -L "$ATTEMPT/original-app" ]] || die "original application backup is missing or unsafe"
[[ -f "$ATTEMPT/original-service" && ! -L "$ATTEMPT/original-service" ]] || die "original-service backup is missing or unsafe"
[[ -f "$ATTEMPT/original-timer" && ! -L "$ATTEMPT/original-timer" ]] || die "original-timer backup is missing or unsafe"
[[ ! -e "$ATTEMPT/replaced-app" && ! -L "$ATTEMPT/replaced-app" ]] || die "backup was already used"
[[ ! -e "$ATTEMPT/replaced-service" && ! -L "$ATTEMPT/replaced-service" ]] || die "service backup was already used"
[[ ! -e "$ATTEMPT/replaced-timer" && ! -L "$ATTEMPT/replaced-timer" ]] || die "timer backup was already used"
for unit in "$SERVICE" "$TIMER"; do
  [[ -f "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || die "installed systemd unit is missing or unsafe: $unit"
done
[[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed application is missing or unsafe"
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] || die "timer must be disabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] || die "timer must be inactive"
SERVICE_STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
[[ "$SERVICE_STATE" == inactive || "$SERVICE_STATE" == failed ]] || die "service must be inactive"
[[ "$SERVICE_STATE" != failed ]] || systemctl reset-failed "$SERVICE"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || die "service must be inactive"

STATE_BEFORE="$(hash_optional_file "$DATA/state.json")"
CREDENTIAL_BEFORE="$(hash_optional_file "$CREDENTIAL")"
ORIGINAL_SERVICE_HASH="$(sha256sum "$ATTEMPT/original-service" | cut -d ' ' -f 1)"
ORIGINAL_TIMER_HASH="$(sha256sum "$ATTEMPT/original-timer" | cut -d ' ' -f 1)"
install -o root -g root -m 0600 "$UNIT_DIR/$SERVICE" "$ATTEMPT/replaced-service"
install -o root -g root -m 0600 "$UNIT_DIR/$TIMER" "$ATTEMPT/replaced-timer"
trap restore_failed_rollback EXIT ERR INT TERM
mv -- "$TARGET" "$ATTEMPT/replaced-app"
CURRENT_MOVED=1
mv -- "$ATTEMPT/original-app" "$TARGET"
OLD_RESTORED=1
UNITS_RESTORED=1
install -o root -g root -m 0644 "$ATTEMPT/original-service" "$UNIT_DIR/$SERVICE"
install -o root -g root -m 0644 "$ATTEMPT/original-timer" "$UNIT_DIR/$TIMER"
systemctl daemon-reload
runuser -u aru-desire -- /usr/bin/node "$TARGET/bin/desire-heartbeat.mjs" status \
  --config "$TARGET/config/default.json" --data-dir "$DATA" >/dev/null
[[ "$(hash_optional_file "$DATA/state.json")" == "$STATE_BEFORE" ]] || die "production state changed during rollback"
[[ "$(hash_optional_file "$CREDENTIAL")" == "$CREDENTIAL_BEFORE" ]] || die "production credential changed during rollback"
[[ "$(sha256sum "$UNIT_DIR/$SERVICE" | cut -d ' ' -f 1)" == "$ORIGINAL_SERVICE_HASH" ]] || die "original-service was not restored"
[[ "$(sha256sum "$UNIT_DIR/$TIMER" | cut -d ' ' -f 1)" == "$ORIGINAL_TIMER_HASH" ]] || die "original-timer was not restored"
printf 'phase=rolled-back\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM
printf 'rollback=PASS\nproduction_state_unchanged=yes\ncredential_unchanged=yes\nsystemd_units_restored=yes\ntimer_active=inactive\n'