#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SOURCE_ROOT=${1:?source root is required}
readonly RUNTIME_ROOT=${2:?installed runtime root is required}
readonly ARU_RELEASE=${3:?staged Aru release is required}
readonly TEST_MODE=${ARU_DESIRE_ISOLATED_TEST_MODE:-false}
readonly TEST_PARENT=${ARU_DESIRE_ISOLATED_TMP_PARENT:-/tmp}

if [[ $TEST_MODE == true ]]; then
  readonly DESIRE_USER=$(id -un)
  readonly DESIRE_GROUP=$(id -gn)
  readonly ARU_USER=$DESIRE_USER
  readonly ARU_GROUP=$DESIRE_GROUP
else
  [[ ${EUID} -eq 0 ]] || { echo 'isolated acceptance requires root' >&2; exit 77; }
  readonly DESIRE_USER=aru-desire
  readonly DESIRE_GROUP=aru-desire
  readonly ARU_USER=aru-selfhost
  readonly ARU_GROUP=aru-selfhost
  [[ -z ${ARU_DESIRE_ISOLATED_FORCE_FAILURE:-} && \
    -z ${ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS:-} ]] || {
    echo 'test controls are allowed only in explicit test mode' >&2
    exit 77
  }
fi

for directory in "$SOURCE_ROOT" "$RUNTIME_ROOT" "$ARU_RELEASE" "$TEST_PARENT"; do
  [[ -d $directory && ! -L $directory ]]
done
for file in \
  "$SOURCE_ROOT/config/default.json" \
  "$RUNTIME_ROOT/bin/desire-heartbeat.mjs" \
  "$RUNTIME_ROOT/bin/desire-interaction-init.mjs" \
  "$RUNTIME_ROOT/bin/desire-turn-receiver.mjs" \
  "$RUNTIME_ROOT/scripts/set-interaction-flags.mjs" \
  "$RUNTIME_ROOT/scripts/verify-synthetic-ledger.mjs" \
  "$ARU_RELEASE/synthetic-check.mjs" \
  "$ARU_RELEASE/aru-desire-turn-hook.mjs"; do
  [[ -f $file && ! -L $file ]]
done

TEST_ROOT=$(mktemp -d "$TEST_PARENT/aru-v0910-isolated.XXXXXXXX")
readonly TEST_ROOT
chmod 0755 "$TEST_ROOT"
readonly TEST_CONFIG=$TEST_ROOT/config/default.json
readonly TEST_DATA=$TEST_ROOT/data
readonly DESIRE_SECRET=$TEST_ROOT/receiver.secret
readonly ARU_SECRET=$TEST_ROOT/hook.secret
readonly RECEIVER_LOG=$TEST_ROOT/receiver.log
child_pid=''

cleanup() {
  local exit_code=${1:-$?}
  trap - EXIT INT TERM
  set +e
  if [[ -n $child_pid ]]; then
    kill -TERM -- "-$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  case "$TEST_ROOT" in
    "$TEST_PARENT"/aru-v0910-isolated.*) rm -rf -- "$TEST_ROOT" ;;
    *) echo 'refusing unsafe isolated cleanup path' >&2; exit 70 ;;
  esac
  exit "$exit_code"
}
trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

install -d -m 0755 "$TEST_ROOT/config"
install -m 0644 "$SOURCE_ROOT/config/default.json" "$TEST_CONFIG"
install -d -o "$DESIRE_USER" -g "$DESIRE_GROUP" -m 0700 "$TEST_DATA"

node "$RUNTIME_ROOT/scripts/set-interaction-flags.mjs" "$TEST_CONFIG" \
  chatStimulusEnabled=true arousalEnabled=true \
  arousalDriveSettlementEnabled=true soloSessionsEnabled=false
node - "$TEST_CONFIG" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (config.observeOnly !== true || config.deliveryEnabled !== false) process.exit(1);
NODE

secret=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")
install -o "$DESIRE_USER" -g "$DESIRE_GROUP" -m 0600 /dev/null "$DESIRE_SECRET"
install -o "$ARU_USER" -g "$ARU_GROUP" -m 0600 /dev/null "$ARU_SECRET"
printf '%s\n' "$secret" > "$DESIRE_SECRET"
printf '%s\n' "$secret" > "$ARU_SECRET"
unset secret

run_desire() {
  if [[ $TEST_MODE == true ]]; then "$@"; else runuser -u "$DESIRE_USER" -g "$DESIRE_GROUP" -- "$@"; fi
}
run_aru() {
  if [[ $TEST_MODE == true ]]; then "$@"; else runuser -u "$ARU_USER" -g "$ARU_GROUP" -- "$@"; fi
}

run_desire node "$RUNTIME_ROOT/bin/desire-heartbeat.mjs" init \
  --config "$TEST_CONFIG" --data-dir "$TEST_DATA" >/dev/null
run_desire node "$RUNTIME_ROOT/bin/desire-interaction-init.mjs" \
  --config "$TEST_CONFIG" --data-dir "$TEST_DATA"

PORT=$(node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => process.stdout.write(String(port)));
  });
')
readonly PORT

if [[ $TEST_MODE == true ]]; then
  setsid env \
    ARU_DESIRE_RECEIVER_HOST=127.0.0.1 \
    ARU_DESIRE_RECEIVER_PORT="$PORT" \
    ARU_DESIRE_CONFIG="$TEST_CONFIG" \
    ARU_DESIRE_DATA_DIR="$TEST_DATA" \
    ARU_DESIRE_TURN_HOOK_SECRET_FILE="$DESIRE_SECRET" \
    node "$RUNTIME_ROOT/bin/desire-turn-receiver.mjs" >"$RECEIVER_LOG" 2>&1 &
else
  setsid runuser -u "$DESIRE_USER" -g "$DESIRE_GROUP" -- env \
    ARU_DESIRE_RECEIVER_HOST=127.0.0.1 \
    ARU_DESIRE_RECEIVER_PORT="$PORT" \
    ARU_DESIRE_CONFIG="$TEST_CONFIG" \
    ARU_DESIRE_DATA_DIR="$TEST_DATA" \
    ARU_DESIRE_TURN_HOOK_SECRET_FILE="$DESIRE_SECRET" \
    node "$RUNTIME_ROOT/bin/desire-turn-receiver.mjs" >"$RECEIVER_LOG" 2>&1 &
fi
child_pid=$!

ready=false
for _ in {1..80}; do
  if curl --fail --silent --max-time 1 \
    "http://127.0.0.1:$PORT/healthz" >/dev/null; then
    ready=true
    break
  fi
  kill -0 "$child_pid" 2>/dev/null || break
  sleep 0.05
done
[[ $ready == true ]]

if [[ $TEST_MODE == true && -n ${ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS:-} ]]; then
  [[ ${ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS} =~ ^[1-5]$ ]]
  : > "$TEST_ROOT/test-health-ready"
  sleep "$ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS"
fi

if [[ $TEST_MODE == true && ${ARU_DESIRE_ISOLATED_FORCE_FAILURE:-} == after_health ]]; then
  exit 91
fi

ACTIVATION_NONCE=$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")
readonly ACTIVATION_ID="activation-$(date -u +%Y%m%dT%H%M%SZ)-${ACTIVATION_NONCE}"
unset ACTIVATION_NONCE
run_desire node "$RUNTIME_ROOT/scripts/verify-synthetic-ledger.mjs" \
  absent "$TEST_CONFIG" "$TEST_DATA" "$ACTIVATION_ID"
run_aru env \
  ARU_DESIRE_TURN_HOOK_ENABLED=true \
  ARU_DESIRE_TURN_HOOK_ENDPOINT="http://127.0.0.1:$PORT/v1/complete-message" \
  ARU_DESIRE_TURN_HOOK_SECRET_FILE="$ARU_SECRET" \
  ARU_DESIRE_TURN_HOOK_TIMEOUT_MS=2000 \
  node "$ARU_RELEASE/synthetic-check.mjs" "$ACTIVATION_ID"
run_desire node "$RUNTIME_ROOT/scripts/verify-synthetic-ledger.mjs" \
  applied-once "$TEST_CONFIG" "$TEST_DATA" "$ACTIVATION_ID"

kill -TERM -- "-$child_pid"
wait "$child_pid" || [[ $? -eq 143 ]]
child_pid=''
echo 'isolated_turn_hook_acceptance=PASS'
