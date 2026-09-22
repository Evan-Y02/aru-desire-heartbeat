import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const enablePath = new URL('../scripts/enable-autonomy-once.sh', import.meta.url);
const disablePath = new URL('../scripts/disable-autonomy-once.sh', import.meta.url);
const rollbackPath = new URL('../scripts/rollback-autonomy.sh', import.meta.url);
const recoveryPath = new URL('../scripts/recover-stalled-delivery-once.sh', import.meta.url);
const servicePath = new URL('../systemd/aru-desire-heartbeat.service', import.meta.url);
const timerPath = new URL('../systemd/aru-desire-heartbeat.timer', import.meta.url);

test('heartbeat units avoid startup catch-up and run Node without JIT', async () => {
  const service = await readFile(servicePath, 'utf8');
  const timer = await readFile(timerPath, 'utf8');
  assert.match(service, /^ExecStart=\/usr\/bin\/node --jitless /mu);
  assert.match(service, /^MemoryDenyWriteExecute=yes$/mu);
  assert.match(timer, /^OnActiveSec=5min$/mu);
  assert.match(timer, /^OnUnitActiveSec=10min$/mu);
  assert.match(timer, /^Persistent=false$/mu);
  assert.doesNotMatch(timer, /^OnBootSec=/mu);
});

test('autonomy enable rebases safely before opening every gate', async () => {
  const source = await readFile(enablePath, 'utf8');
  assert.match(source, /trap rollback_failure EXIT ERR INT TERM/);
  assert.match(source, /credential permissions are unsafe/);
  assert.match(source, /parseSenderBundle/);
  assert.match(source, /ARU_LOCAL_MANIFEST_URL/);
  assert.match(source, /ARU_PUBLIC_MANIFEST_URL/);
  assert.match(source, /installed systemd unit differs from source; upgrade first/);
  assert.match(source, /rebase-clock/);
  assert.match(source, /clock rebase changed protected state content/);
  assert.match(source, /defaultExpression=\{consecutiveWithholds:0\}/);
  assert.match(source, /x\.observeOnly=false;x\.deliveryEnabled=true/);
  assert.match(source, /x\.enabled=true/);
  assert.match(source, /aru-desire-heartbeat-external-trigger-v1/);
  assert.match(source, /systemctl enable --now "\$TIMER"/);
  assert.ok(source.indexOf('rebase-clock') < source.indexOf('systemctl enable --now'));
  assert.doesNotMatch(source, /set -x/);
});

test('stalled delivery recovery is narrow, backed up, and timer-off', async () => {
  const source = await readFile(recoveryPath, 'utf8');
  assert.match(source, /source and installed versions differ; upgrade first/);
  assert.match(source, /timer must be disabled/);
  assert.match(source, /lock owner process is still alive/);
  assert.match(source, /matching claimed delivery record is missing or unsafe/);
  assert.match(source, /unsubmitted-claim\.json/);
  assert.match(source, /message_submitted=yes/);
  assert.match(source, /pending_decision=cleared/);
  assert.match(source, /timer_active=inactive/);
  assert.doesNotMatch(source, /systemctl\s+(?:enable|start|restart)\b/u);
  assert.doesNotMatch(source, /set -x/);
});

test('normal stop fails closed and retains the evolved state', async () => {
  const source = await readFile(disablePath, 'utf8');
  assert.match(source, /systemctl disable --now "\$TIMER"/);
  assert.match(source, /STATE_BEFORE="\$\(hash_state\)"/);
  assert.match(source, /state changed while stopping/);
  assert.match(source, /x\.observeOnly=true;x\.deliveryEnabled=false/);
  assert.match(source, /x\.enabled=false/);
  assert.match(source, /state_retained=yes/);
  assert.doesNotMatch(source, /rm -f -- "\$DATA\/state\.json"/);
  assert.doesNotMatch(source, /set -x/);
});

test('activation rollback restores the exact pre-activation state', async () => {
  const source = await readFile(rollbackPath, 'utf8');
  assert.match(source, /activation backup path is invalid/);
  assert.match(source, /phase=enabled/);
  assert.match(source, /restore_file "\$ATTEMPT\/state\.json"/);
  assert.match(source, /systemctl disable --now "\$TIMER"/);
  assert.match(source, /pre_activation_state_restored=yes/);
  assert.doesNotMatch(source, /set -x/);
});
