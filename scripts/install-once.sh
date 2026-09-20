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
readonly BACKUP_PARENT="/var/backups/aru-desire-heartbeat"
readonly ACTIVE="/var/lib/aru-desire-heartbeat-install-active"
readonly SOURCE_CREDENTIAL="${ARU_SEND_CREDENTIAL_FILE:-}"
readonly TARGET_CREDENTIAL="$DATA/external-trigger.send-credential"

STAGE=""
ATTEMPT=""
TARGET_INSTALLED=0
SERVICE_INSTALLED=0
TIMER_INSTALLED=0
ACTIVE_CREATED=0
CREDENTIAL_INSTALLED=0

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

safe_attempt() {
  [[ -n "$ATTEMPT" && "$ATTEMPT" == "$BACKUP_PARENT"/attempt.* && -d "$ATTEMPT" \
    && ! -L "$ATTEMPT" && "$(stat -c '%U:%G:%a' "$ATTEMPT")" == root:root:700 \
    && "$(readlink -f "$ATTEMPT")" == "$ATTEMPT" ]]
}

restore_failed_install() {
  local status=$?
  trap - EXIT ERR INT TERM
  (( status != 0 )) || return 0
  set +e
  (( ACTIVE_CREATED == 0 )) || rm -f -- "$ACTIVE"
  (( CREDENTIAL_INSTALLED == 0 )) || rm -f -- "$TARGET_CREDENTIAL"
  [[ -z "$STAGE" ]] || rm -rf -- "$STAGE"
  if safe_attempt; then
    (( TARGET_INSTALLED == 0 )) || rm -rf -- "$TARGET"
    [[ ! -d "$ATTEMPT/original-app" ]] || mv -- "$ATTEMPT/original-app" "$TARGET"
    (( SERVICE_INSTALLED == 0 )) || rm -f -- "$UNIT_DIR/$SERVICE"
    [[ ! -f "$ATTEMPT/$SERVICE" ]] || install -o root -g root -m 0644 "$ATTEMPT/$SERVICE" "$UNIT_DIR/$SERVICE"
    (( TIMER_INSTALLED == 0 )) || rm -f -- "$UNIT_DIR/$TIMER"
    [[ ! -f "$ATTEMPT/$TIMER" ]] || install -o root -g root -m 0644 "$ATTEMPT/$TIMER" "$UNIT_DIR/$TIMER"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  printf 'ERROR: installation failed; rollback was attempted and the attempt backup was retained.\n' >&2
  exit "$status"
}

preflight() {
  [[ "$EUID" -eq 0 ]] || die "must run as root"
  [[ "$MODE" == "--apply" ]] || die "usage: install-once.sh --apply"
  for command in node python3 id install mktemp stat mv rm mkdir chown chmod sha256sum systemctl find sort xargs readlink; do need "$command"; done
  [[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 22 ]] || die "Node.js 22 is required"
  id aru-desire >/dev/null 2>&1 || die "the low-privilege aru-desire account must be created explicitly first"
  [[ -d "$SOURCE" && ! -L "$SOURCE" ]] || die "source directory is missing or unsafe"
  for file in package.json config/default.json config/aru-delivery.json \
      bin/desire-heartbeat.mjs bin/desire-cycle.mjs bin/desire-deliver.mjs \
      delivery/aru-adapter.mjs delivery/aru-wake-sender.mjs dashboard/server.py \
      dashboard/public/index.html dashboard/public/styles.css dashboard/public/app.js \
      systemd/"$SERVICE" systemd/"$TIMER"; do
    [[ -f "$SOURCE/$file" && ! -L "$SOURCE/$file" ]] || die "required source file is missing or unsafe"
  done
  [[ ! -e "$ACTIVE" && ! -L "$ACTIVE" ]] || die "an active installation marker already exists"
  if [[ -e "$TARGET" || -L "$TARGET" ]]; then [[ -d "$TARGET" && ! -L "$TARGET" ]] || die "target is not a real directory"; fi
  for unit in "$SERVICE" "$TIMER"; do
    if [[ -e "$UNIT_DIR/$unit" || -L "$UNIT_DIR/$unit" ]]; then
      [[ -f "$UNIT_DIR/$unit" && ! -L "$UNIT_DIR/$unit" ]] || die "existing unit is unsafe"
    fi
  done
  if [[ -n "$SOURCE_CREDENTIAL" ]]; then
    [[ "$SOURCE_CREDENTIAL" == /* && -f "$SOURCE_CREDENTIAL" && ! -L "$SOURCE_CREDENTIAL" \
      && "$(stat -c '%a:%h' "$SOURCE_CREDENTIAL")" == "600:1" ]] \
      || die "ARU_SEND_CREDENTIAL_FILE must name an absolute, regular 0600 file"
  fi
}

preflight
if [[ -e "$BACKUP_PARENT" || -L "$BACKUP_PARENT" ]]; then
  [[ -d "$BACKUP_PARENT" && ! -L "$BACKUP_PARENT" \
    && "$(stat -c '%U:%G:%a' "$BACKUP_PARENT")" == root:root:700 \
    && "$(readlink -f "$BACKUP_PARENT")" == "$BACKUP_PARENT" ]] \
    || die "backup parent is unsafe"
else
  install -d -o root -g root -m 0700 "$BACKUP_PARENT"
fi
ATTEMPT="$(mktemp -d "$BACKUP_PARENT/attempt.XXXXXXXXXXXXXXXX")"
chmod 0700 "$ATTEMPT"
chown root:root "$ATTEMPT"
safe_attempt || die "attempt directory is unsafe"
trap restore_failed_install EXIT ERR INT TERM
printf 'phase=created\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
[[ ! -d "$TARGET" ]] || mv -- "$TARGET" "$ATTEMPT/original-app"
[[ ! -f "$UNIT_DIR/$SERVICE" ]] || install -o root -g root -m 0600 "$UNIT_DIR/$SERVICE" "$ATTEMPT/$SERVICE"
[[ ! -f "$UNIT_DIR/$TIMER" ]] || install -o root -g root -m 0600 "$UNIT_DIR/$TIMER" "$ATTEMPT/$TIMER"

STAGE="$(mktemp -d /opt/.aru-desire-heartbeat.stage.XXXXXXXXXXXXXXXX)"
chown root:root "$STAGE"
chmod 0755 "$STAGE"
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
find "$STAGE" -type f -print0 | sort -z | xargs -0 sha256sum > "$ATTEMPT/installed.sha256"
chmod 0600 "$ATTEMPT/installed.sha256"
mv -- "$STAGE" "$TARGET"
STAGE=""
TARGET_INSTALLED=1
install -d -o aru-desire -g aru-desire -m 0700 "$DATA"
if [[ -n "$SOURCE_CREDENTIAL" && -f "$SOURCE_CREDENTIAL" ]]; then
  if [[ -e "$TARGET_CREDENTIAL" || -L "$TARGET_CREDENTIAL" ]]; then
    [[ -f "$TARGET_CREDENTIAL" && ! -L "$TARGET_CREDENTIAL" \
      && "$(stat -c '%U:%G:%a:%h' "$TARGET_CREDENTIAL")" == "aru-desire:aru-desire:600:1" ]] \
      || die "existing installed external-trigger credential is unsafe"
  else
    install -o aru-desire -g aru-desire -m 0600 "$SOURCE_CREDENTIAL" "$TARGET_CREDENTIAL"
    CREDENTIAL_INSTALLED=1
  fi
fi
install -o root -g root -m 0644 "$SOURCE/systemd/$SERVICE" "$UNIT_DIR/.${SERVICE}.new"
mv -fT -- "$UNIT_DIR/.${SERVICE}.new" "$UNIT_DIR/$SERVICE"
SERVICE_INSTALLED=1
install -o root -g root -m 0644 "$SOURCE/systemd/$TIMER" "$UNIT_DIR/.${TIMER}.new"
mv -fT -- "$UNIT_DIR/.${TIMER}.new" "$UNIT_DIR/$TIMER"
TIMER_INSTALLED=1
systemctl daemon-reload
printf 'attempt=%s\n' "$ATTEMPT" > "$ATTEMPT/active"
chmod 0600 "$ATTEMPT/active"
ln -- "$ATTEMPT/active" "$ACTIVE"
ACTIVE_CREATED=1
printf 'phase=installed-not-enabled-not-initialized\n' > "$ATTEMPT/status"
chmod 0600 "$ATTEMPT/status"
trap - EXIT ERR INT TERM
printf 'INSTALLED_NOT_ENABLED; initialize explicitly before enabling the timer.\n'