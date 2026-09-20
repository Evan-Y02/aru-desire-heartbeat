#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly MODE="${1:-}"
readonly SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly TARGET="/opt/aru-desire-heartbeat"
readonly DATA="/var/lib/aru-desire-heartbeat"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE="aru-desire-heartbeat.service"
readonly TIMER="aru-desire-heartbeat.timer"
readonly ACTIVE="/var/lib/aru-desire-heartbeat-install-active"
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat-upgrades"
readonly CREDENTIAL="$DATA/external-trigger.send-credential"

STAGE=""
ATTEMPT=""
OLD_MOVED=0
NEW_INSTALLED=0
UNITS_CHANGED=0
STATE_BEFORE=""
CREDENTIAL_BEFORE=""
SOURCE_SERVICE_HASH=""
SOURCE_TIMER_HASH=""

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

safe_attempt() {
  [[ -n "$ATTEMPT" && "$ATTEMPT" == "$BACKUP_PARENT"/upgrade.* && -d "$ATTEMPT" \
    && ! -L "$ATTEMPT" && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
    && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]]
}

restore_failed_upgrade() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
  rm -f -- "$UNIT_DIR/.${SERVICE}.new" "$UNIT_DIR/.${TIMER}.new"
  if safe_attempt; then
    if (( UNITS_CHANGED == 1 )); then
      [[ ! -f "$ATTEMPT/original-service" ]] || install -o root -g root -m 0644 "$ATTEMPT/original-service" "$UNIT_DIR/$SERVICE"
      [[ ! -f "$ATTEMPT/original-timer" ]] || install -o root -g root -m 0644 "$ATTEMPT/original-timer" "$UNIT_DIR/$TIMER"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if (( OLD_MOVED == 1 )); then
      (( NEW_INSTALLED == 0 )) || rm -rf -- "$TARGET"
      [[ ! -d "$ATTEMPT/original-app" ]] || mv -- "$ATTEMPT/original-app" "$TARGET"
    fi
  fi
  printf 'ERROR: upgrade failed; the previous application was restored when possible.\n' >&2
  [[ -z "$ATTEMPT" ]] || printf 'upgrade_attempt=%s\n' "$ATTEMPT" >&2
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

copy_application() {
  install -d -o root -g root -m 0755 "$STAGE/bin" "$STAGE/config" "$STAGE/src" "$STAGE/delivery" \
    "$STAGE/dashboard" "$STAGE/dashboard/public"
  install -o root -g root -m 0755 "$SOURCE/bin/desire-heartbeat.mjs" "$STAGE/bin/desire-heartbeat.mjs"
  install -o root -g root -m 0755 "$SOURCE/bin/desire-cycle.mjs" "$STAGE/bin/desire-cycle.mjs"
  install -o root -g root -m 0755 "$SOURCE/bin/desire-deliver.mjs" "$STAGE/bin/desire-deliver.mjs"
  install -o root -g root -m 0644 "$SOURCE/package.json" "$STAGE/package.json"
  install -o root -g root -m 0644 "$SOURCE/config/default.json" "$STAGE/config/default.json"
  install -o root -g root -m 0644 "$SOURCE/config/aru-delivery.json" "$STAGE/config/aru-delivery.json"
  install -o root -g root -m 0644 "$SOURCE/delivery/aru-adapter.mjs" "$STAGE/delivery/aru-adapter.mjs"
  install -o root -g root -m 0644 "$SOURCE/delivery/aru-wake-sender.mjs" "$STAGE/delivery/aru-wake-sender.mjs"
  install -o root -g root -m 0755 "$SOURCE/dashboard/server.py" "$STAGE/dashboard/server.py"
  for file in "$SOURCE"/dashboard/public/*; do
    [[ -f "$file" && ! -L "$file" ]] || die "dashboard asset is unsafe"
    install -o root -g root -m 0644 "$file" "$STAGE/dashboard/public/${file##*/}"
  done
  for file in "$SOURCE"/src/*.mjs; do
    [[ -f "$file" && ! -L "$file" ]] || die "source module is unsafe"
    install -o root -g root -m 0644 "$file" "$STAGE/src/${file##*/}"
  done
}

[[ "$EUID" -eq 0 ]] || die "must run as root"
[[ "$MODE" == "--apply" ]] || die "usage: upgrade-once.sh --apply"
for command in node python3 runuser install mktemp stat mv rm sha256sum cut systemctl find sort xargs readlink chown chmod; do
  need "$command"
done
[[ "$(node -p "process.versions.node.split('.')[0]")" == 22 ]] || die "Node.js 22 is required"
[[ -d "$SOURCE" && ! -L "$SOURCE" ]] || die "source directory is missing or unsafe"
[[ -d "$TARGET" && ! -L "$TARGET" ]] || die "installed application is missing or unsafe"
[[ -f "$ACTIVE" && ! -L "$ACTIVE" && "$(stat -c '%U:%G:%a' "$ACTIVE")" == root:root:600 ]] \
  || die "active installation marker is missing or unsafe"
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
[[ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" == disabled ]] || die "timer must be disabled"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] || die "timer must be inactive"
SERVICE_STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
[[ "$SERVICE_STATE" == inactive || "$SERVICE_STATE" == failed ]] || die "service must be inactive"
[[ "$SERVICE_STATE" != failed ]] || systemctl reset-failed "$SERVICE"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || die "service must be inactive"
for unit in "$SERVICE" "$TIMER"; do
  [[ -f "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || die "installed systemd unit is missing or unsafe: $unit"
done
[[ -z "$(find "$SOURCE" "$TARGET" -type l -print -quit)" ]] || die "source or installed application contains a symbolic link"
for file in package.json config/default.json config/aru-delivery.json \
    bin/desire-heartbeat.mjs bin/desire-cycle.mjs bin/desire-deliver.mjs \
    delivery/aru-adapter.mjs delivery/aru-wake-sender.mjs dashboard/server.py \
    dashboard/public/index.html dashboard/public/styles.css dashboard/public/app.js \
    systemd/"$SERVICE" systemd/"$TIMER"; do
  [[ -f "$SOURCE/$file" && ! -L "$SOURCE/$file" ]] || die "required source file is missing or unsafe"
done

OLD_VERSION="$(node -p "require('$TARGET/package.json').version")"
NEW_VERSION="$(node -p "require('$SOURCE/package.json').version")"
[[ "$OLD_VERSION" != "$NEW_VERSION" ]] || die "installed and source versions are both $NEW_VERSION"
node --test "$SOURCE"/test/*.test.mjs >/dev/null
python3 -m unittest discover -s "$SOURCE/test" -p '*_test.py' >/dev/null
find "$SOURCE" -type f -name '*.mjs' -exec node --check {} \;

STATE_BEFORE="$(hash_optional_file "$DATA/state.json")"
CREDENTIAL_BEFORE="$(hash_optional_file "$CREDENTIAL")"
if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" \
    && "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 \
    && "$(readlink -f "$BACKUP_PARENT")" == "$BACKUP_PARENT" ]] \
    || die "backup parent is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/upgrade.XXXXXXXXXXXXXXXX")"
chown root:root "$ATTEMPT"
chmod 0700 "$ATTEMPT"
safe_attempt || die "upgrade backup is unsafe"
printf 'phase=prepared\nold_version=%s\nnew_version=%s\n' "$OLD_VERSION" "$NEW_VERSION" > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
install -o root -g root -m 0600 "$UNIT_DIR/$SERVICE" "$ATTEMPT/original-service"
install -o root -g root -m 0600 "$UNIT_DIR/$TIMER" "$ATTEMPT/original-timer"
SOURCE_SERVICE_HASH="$(sha256sum "$SOURCE/systemd/$SERVICE" | cut -d ' ' -f 1)"
SOURCE_TIMER_HASH="$(sha256sum "$SOURCE/systemd/$TIMER" | cut -d ' ' -f 1)"

STAGE="$(mktemp -d /opt/.aru-desire-heartbeat.upgrade.XXXXXXXXXXXXXXXX)"
chown root:root "$STAGE"
chmod 0755 "$STAGE"
trap restore_failed_upgrade EXIT ERR INT TERM
copy_application
find "$STAGE" -type f -print0 | sort -z | xargs -0 sha256sum > "$ATTEMPT/new.sha256"
chmod 0600 "$ATTEMPT/new.sha256"
mv -- "$TARGET" "$ATTEMPT/original-app"
OLD_MOVED=1
mv -- "$STAGE" "$TARGET"
STAGE=""
NEW_INSTALLED=1
install -o root -g root -m 0644 "$SOURCE/systemd/$SERVICE" "$UNIT_DIR/.${SERVICE}.new"
install -o root -g root -m 0644 "$SOURCE/systemd/$TIMER" "$UNIT_DIR/.${TIMER}.new"
UNITS_CHANGED=1
mv -fT -- "$UNIT_DIR/.${SERVICE}.new" "$UNIT_DIR/$SERVICE"
mv -fT -- "$UNIT_DIR/.${TIMER}.new" "$UNIT_DIR/$TIMER"
systemctl daemon-reload

runuser -u aru-desire -- /usr/bin/node "$TARGET/bin/desire-heartbeat.mjs" status \
  --config "$TARGET/config/default.json" --data-dir "$DATA" >/dev/null
[[ "$(hash_optional_file "$DATA/state.json")" == "$STATE_BEFORE" ]] || die "production state changed during upgrade"
[[ "$(hash_optional_file "$CREDENTIAL")" == "$CREDENTIAL_BEFORE" ]] || die "production credential changed during upgrade"
[[ "$(sha256sum "$UNIT_DIR/$SERVICE" | cut -d ' ' -f 1)" == "$SOURCE_SERVICE_HASH" ]] || die "systemd service changed during upgrade"
[[ "$(sha256sum "$UNIT_DIR/$TIMER" | cut -d ' ' -f 1)" == "$SOURCE_TIMER_HASH" ]] || die "systemd timer changed during upgrade"
[[ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" == inactive ]] || die "timer became active"
[[ "$(systemctl is-active "$SERVICE" 2>/dev/null || true)" == inactive ]] || die "service became active"

printf 'phase=upgraded\nold_version=%s\nnew_version=%s\n' "$OLD_VERSION" "$NEW_VERSION" > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM
printf 'upgrade=PASS\nold_version=%s\nnew_version=%s\nproduction_state_unchanged=yes\ncredential_unchanged=yes\nsystemd_units_updated=yes\ntimer_active=inactive\nbackup=%s\n' \
  "$OLD_VERSION" "$NEW_VERSION" "$ATTEMPT"
printf 'rollback_command=sudo %s/scripts/rollback-upgrade.sh %s\n' "$SOURCE" "$ATTEMPT"