#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ ${EUID} -eq 0 ]] || { echo 'test requires root' >&2; exit 77; }

readonly SOURCE_ROOT=${1:-/home/xinchao/private/ChengXiao/desire-heartbeat}
readonly CURRENT_RELEASE=$(readlink -f /opt/aru-selfhost/current)
readonly SERVICE_USER=$(systemctl show aru-selfhost.service --property=User --value)
readonly SERVICE_GROUP=$(systemctl show aru-selfhost.service --property=Group --value)
[[ $SERVICE_USER == aru-selfhost && $SERVICE_GROUP == aru-selfhost ]]

readonly TEST_ROOT=$(mktemp -d /tmp/aru-turn-hook-permission.XXXXXXXX)
readonly TEST_RELEASE=$TEST_ROOT/release
readonly TEST_DATA=$TEST_ROOT/data
readonly TEST_HOME=$TEST_ROOT/home
readonly TEST_LOG=$TEST_ROOT/server.log
child_pid=''

cleanup() {
  set +e
  if [[ -n $child_pid ]]; then
    kill -TERM -- "-$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

chmod 0755 "$TEST_ROOT"
cp -a "$CURRENT_RELEASE" "$TEST_RELEASE"
install -o root -g root -m 0755 "$SOURCE_ROOT/aru-hook/aru-desire-turn-hook.mjs" \
  "$TEST_RELEASE/aru-desire-turn-hook.mjs"
install -o root -g root -m 0644 "$SOURCE_ROOT/aru-hook/aru-desire-relay-turn.mjs" \
  "$TEST_RELEASE/aru-desire-relay-turn.mjs"
readonly ORIGINAL_METADATA=$(stat -c '%u:%g:%a' "$TEST_RELEASE/server.mjs")
readonly ORIGINAL_RELAY_METADATA=$(stat -c '%u:%g:%a' \
  "$TEST_RELEASE/conversation-turn-relay.mjs")

node "$SOURCE_ROOT/aru-hook/apply-server-wiring.mjs" \
  "$TEST_RELEASE/server.mjs" "$TEST_RELEASE/conversation-turn-relay.mjs"
chown --reference="$CURRENT_RELEASE/server.mjs" "$TEST_RELEASE/server.mjs"
chmod --reference="$CURRENT_RELEASE/server.mjs" "$TEST_RELEASE/server.mjs"
chown --reference="$CURRENT_RELEASE/conversation-turn-relay.mjs" \
  "$TEST_RELEASE/conversation-turn-relay.mjs"
chmod --reference="$CURRENT_RELEASE/conversation-turn-relay.mjs" \
  "$TEST_RELEASE/conversation-turn-relay.mjs"
[[ $(stat -c '%u:%g:%a' "$TEST_RELEASE/server.mjs") == "$ORIGINAL_METADATA" ]]
[[ $(stat -c '%u:%g:%a' "$TEST_RELEASE/conversation-turn-relay.mjs") == \
  "$ORIGINAL_RELAY_METADATA" ]]
runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- \
  node --check "$TEST_RELEASE/server.mjs" >/dev/null
runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- \
  node --check "$TEST_RELEASE/conversation-turn-relay.mjs" >/dev/null

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$TEST_DATA" "$TEST_HOME"
readonly PORT=$(node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => process.stdout.write(String(port)));
  });
')

setsid runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- env \
  HOME="$TEST_HOME" XDG_RUNTIME_DIR="$TEST_HOME" TMPDIR="$TEST_HOME" \
  ARU_DESIRE_TURN_HOOK_ENABLED=false \
  node "$TEST_RELEASE/server.mjs" \
    --listen-host 127.0.0.1 \
    --port "$PORT" \
    --data-dir "$TEST_DATA" \
    --base-url "http://127.0.0.1:$PORT" \
    --transport-kind lan \
    --display-name 'Synthetic isolated permission test' \
    --node-kind local-device >"$TEST_LOG" 2>&1 &
child_pid=$!

ready=false
for _ in {1..80}; do
  if curl --fail --silent --max-time 1 \
    "http://127.0.0.1:$PORT/aru/v1/diagnostics" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$child_pid" 2>/dev/null; then
    echo 'isolated Aru process exited before diagnostics became ready' >&2
    exit 1
  fi
  sleep 0.05
done
[[ $ready == true ]]
[[ $(runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- id -un) == "$SERVICE_USER" ]]
[[ $(runuser -u "$SERVICE_USER" -g "$SERVICE_GROUP" -- id -gn) == "$SERVICE_GROUP" ]]

kill -TERM -- "-$child_pid"
wait "$child_pid" || [[ $? -eq 143 ]]
child_pid=''
echo 'aru_service_identity_release_test=PASS'
