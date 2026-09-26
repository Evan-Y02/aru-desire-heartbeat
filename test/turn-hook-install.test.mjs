import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = [];
test.after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('receiver did not stop safely')), 2_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

async function unusedLoopbackPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(url, child, output = []) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `receiver exited early with ${child.exitCode}: ${Buffer.concat(output).toString('utf8')}`,
      );
    }
    const healthy = await fetch(url).then((response) => response.ok).catch(() => false);
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('receiver did not become healthy');
}

async function postEvent(url, secret, event) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(event),
  });
}

test('isolated install rehearsal preserves service-readable config and restores Aru source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-hook-install-rehearsal-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const config = path.join(directory, 'default.json');
  const server = path.join(directory, 'server.mjs');
  const baseline = path.join(directory, 'server.baseline.mjs');
  await copyFile(path.join(ROOT, 'config/default.json'), config);
  await copyFile('/opt/aru-selfhost/current/server.mjs', server);
  await copyFile(server, baseline);
  await chmod(server, 0o755);
  const serverBefore = await stat(server);

  const flags = spawnSync('/bin/bash', [
    '-c', 'umask 077; exec "$@"', 'rehearsal', process.execPath,
    path.join(ROOT, 'scripts/set-interaction-flags.mjs'), config,
    'chatStimulusEnabled=true', 'arousalEnabled=true',
    'arousalDriveSettlementEnabled=true', 'soloSessionsEnabled=false',
  ], {
    env: process.env,
    stdio: 'pipe',
  });
  assert.equal(flags.status, 0, flags.stderr.toString());
  assert.equal((await stat(config)).mode & 0o777, 0o644);
  const parsed = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(parsed.chatStimulusEnabled, true);
  assert.equal(parsed.soloSessionsEnabled, false);

  const patch = spawnSync('/bin/bash', [
    '-c', 'umask 077; exec "$@"', 'patch-rehearsal', process.execPath,
    path.join(ROOT, 'aru-hook/apply-server-wiring.mjs'), server,
  ], { stdio: 'pipe' });
  assert.equal(patch.status, 0, patch.stderr.toString());
  const serverAfter = await stat(server);
  assert.equal(serverAfter.uid, serverBefore.uid);
  assert.equal(serverAfter.gid, serverBefore.gid);
  assert.equal(serverAfter.mode & 0o7777, serverBefore.mode & 0o7777);
  const syntax = spawnSync(process.execPath, ['--check', server], { stdio: 'pipe' });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
  const patchedSource = await readFile(server, 'utf8');
  assert.doesNotMatch(patchedSource, /pairingToken: state\.pairing\.token/u);
  assert.doesNotMatch(patchedSource, /console\.log\(pairingURL\)/u);
  assert.match(patchedSource, /startup logs never include credentials/u);

  const repeatPatch = spawnSync(process.execPath, [
    path.join(ROOT, 'aru-hook/apply-server-wiring.mjs'), server,
  ], { stdio: 'pipe' });
  assert.equal(repeatPatch.status, 0, repeatPatch.stderr.toString());
  assert.deepEqual(await readFile(server), Buffer.from(patchedSource));

  await copyFile(baseline, server);
  assert.deepEqual(await readFile(server), await readFile('/opt/aru-selfhost/current/server.mjs'));
});

test('installer retains fail-closed rollback and never broadens permissions', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  assert.match(source, /trap 'handle_error "\$\?" "\$LINENO" "\$BASH_COMMAND"' ERR/u);
  assert.match(source, /mv -Tf .*CURRENT_LINK/u);
  assert.match(source, /install -o aru-selfhost -g aru-selfhost -m 0600/u);
  assert.match(source, /install -o aru-desire -g aru-desire -m 0600/u);
  assert.match(source, /local-import-closure\.mjs/u);
  assert.match(source, /systemctl stop aru-desire-turn-receiver\.service/u);
  assert.match(source, /receiver_ready=false/u);
  assert.match(source, /ERROR: install failed: stage=%s line=%s exit=%s command=%q/u);
  assert.match(source, /ERROR: rollback completed/u);
  assert.match(source, /chown --reference="\$OLD_RELEASE\/server\.mjs"/u);
  assert.match(source, /chmod --reference="\$OLD_RELEASE\/server\.mjs"/u);
  assert.match(source, /aru_ready=false/u);
  assert.match(source, /enable_interaction_flags/u);
  assert.match(source, /isolated_aru_service_identity_preflight/u);
  assert.match(source, /test-aru-patched-release-as-service-user\.sh/u);
  assert.match(source, /ARU_DESIRE_TURN_HOOK_TIMEOUT_MS=1000/u);
  assert.match(source, /SECRET_CHANNEL_BEFORE=present/u);
  assert.match(source, /cmp -s -- "\$ARU_SECRET" "\$DESIRE_SECRET"/u);
  assert.match(source, /restore_aru_hook_secret/u);
  assert.match(source, /restore_desire_hook_secret/u);
  assert.match(source, /if \[\[ \$SECRET_CHANNEL_BEFORE == absent \]\]; then/u);
  assert.match(source, /startup logs never include credentials/u);
  assert.ok(source.indexOf('disable_staged_receiver') < source.indexOf('remove_new_receiver_unit'));
  assert.doesNotMatch(source, /disable --now aru-desire-turn-receiver/u);
  const orderedStages = [
    'INSTALL_STAGE=start_receiver',
    'INSTALL_STAGE=restart_aru',
    'INSTALL_STAGE=service_health',
    'INSTALL_STAGE=enable_interaction_flags',
    'INSTALL_STAGE=synthetic_end_to_end',
  ].map((marker) => source.indexOf(marker));
  assert.ok(orderedStages.every((position) => position >= 0));
  assert.deepEqual([...orderedStages].sort((left, right) => left - right), orderedStages);
  assert.match(source, /DATA_FILES=\(state\.json interaction-state\.json\)/u);
  assert.match(source, /restore_data_file:\$file[\s\S]*?install -o aru-desire -g aru-desire -m 0600/u);
  assert.doesNotMatch(source, /chmod\s+(?:-R\s+)?777|chmod\s+(?:-R\s+)?0?777/iu);
});

test('installer reports the exact failing stage, command, and exit before rollback', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  const handler = source.match(/handle_error\(\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(handler, 'installer error handler was not found');
  const rehearsal = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    ${handler}
    INSTALL_STAGE=isolated_expected_failure
    ROLLBACK_READY=false
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    /bin/false
  `], { encoding: 'utf8' });
  assert.equal(rehearsal.status, 1);
  assert.match(rehearsal.stderr, /stage=isolated_expected_failure/u);
  assert.match(rehearsal.stderr, /exit=1/u);
  assert.match(rehearsal.stderr, /command=\/bin\/false/u);
  assert.match(rehearsal.stderr, /rollback not required/u);

  const rollbackRehearsal = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    ${handler}
    INSTALL_STAGE=isolated_rollback_failure
    ROLLBACK_READY=true
    rollback() { printf 'synthetic rollback invoked\\n' >&2; return 0; }
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    /bin/false
  `], { encoding: 'utf8' });
  assert.equal(rollbackRehearsal.status, 1);
  assert.match(rollbackRehearsal.stderr, /stage=isolated_rollback_failure/u);
  assert.match(rollbackRehearsal.stderr, /synthetic rollback invoked/u);
  assert.match(rollbackRehearsal.stderr, /rollback completed/u);
  assert.ok(
    rollbackRehearsal.stderr.indexOf('stage=isolated_rollback_failure') <
      rollbackRehearsal.stderr.indexOf('synthetic rollback invoked'),
  );

  const rollbackFailure = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    ${handler}
    INSTALL_STAGE=isolated_rollback_failure
    ROLLBACK_READY=true
    rollback() {
      printf 'ERROR: rollback step failed: remove_new_receiver_unit\\n' >&2
      return 1
    }
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    /bin/false
  `], { encoding: 'utf8' });
  assert.equal(rollbackFailure.status, 1);
  assert.match(rollbackFailure.stderr, /rollback step failed: remove_new_receiver_unit/u);
  assert.match(rollbackFailure.stderr, /rollback encountered errors/u);
});

test('diagnostic redactor removes tokens, secrets, URLs, and authorization values', () => {
  const credential = 'liveCredentialValueThatMustNeverEscape123';
  const sample = [
    `{"pairingToken":"${credential}"}`,
    `aru://pair?pairingToken=${credential}&manifestUrl=https://example.invalid`,
    `{"secret":"${credential}","token":"${credential}"}`,
    `Authorization: Bearer ${credential}`,
  ].join('\n');
  const result = spawnSync(
    path.join(ROOT, 'scripts/redact-sensitive-output.sh'),
    { input: sample, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(credential, 'u'));
  assert.match(result.stdout, /\[REDACTED\]/u);
});

test('standalone Aru startup hardening is atomic and removes real pairing credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aru-startup-redaction-'));
  directories.push(directory);
  const server = path.join(directory, 'server.mjs');
  await copyFile('/opt/aru-selfhost/current/server.mjs', server);
  await chmod(server, 0o755);
  const before = await stat(server);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'aru-hook/redact-startup-secrets.mjs'), server,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const after = await stat(server);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  const source = await readFile(server, 'utf8');
  assert.doesNotMatch(source, /pairingToken: state\.pairing\.token/u);
  assert.doesNotMatch(source, /console\.log\(pairingURL\)/u);
  assert.match(source, /startup logs never include credentials/u);
  const repeat = spawnSync(process.execPath, [
    path.join(ROOT, 'aru-hook/redact-startup-secrets.mjs'), server,
  ], { encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(await readFile(server, 'utf8'), source);
  const syntax = spawnSync(process.execPath, ['--check', server], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('fresh production artifact starts from unit ExecStart and processes a replay once', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-hook-artifact-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const release = path.join(directory, 'release');
  const dataDirectory = path.join(directory, 'state');
  await mkdir(release, { mode: 0o700 });
  await mkdir(dataDirectory, { mode: 0o700 });

  const closureResult = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/local-import-closure.mjs'), ROOT,
    'bin/desire-turn-receiver.mjs', 'bin/desire-interaction-init.mjs',
    'scripts/set-interaction-flags.mjs', 'scripts/verify-synthetic-ledger.mjs',
  ], { encoding: 'utf8' });
  assert.equal(closureResult.status, 0, closureResult.stderr);
  const closure = closureResult.stdout.trim().split('\n');
  for (const required of [
    'bin/desire-turn-receiver.mjs', 'src/turn-receiver.mjs', 'src/engine.mjs',
    'src/security.mjs', 'src/storage.mjs', 'src/interaction-runtime.mjs',
  ]) assert.ok(closure.includes(required), `${required} absent from production closure`);
  for (const relative of ['config/default.json', ...closure]) {
    const destination = path.join(release, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
    await chmod(destination, relative.startsWith('bin/') || relative.startsWith('scripts/')
      ? 0o755 : 0o644);
  }

  const unit = await readFile(path.join(ROOT, 'systemd/aru-desire-turn-receiver.service'), 'utf8');
  assert.match(unit, /^WorkingDirectory=\/opt\/aru-desire-heartbeat$/mu);
  const execStart = unit.match(/^ExecStart=(.+)$/mu)?.[1];
  assert.equal(execStart,
    '/usr/bin/node /opt/aru-desire-heartbeat/bin/desire-turn-receiver.mjs');
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=true$/mu);
  const [executable, ...argumentsFromUnit] = execStart.split(' ');
  const stagedArguments = argumentsFromUnit.map((argument) =>
    argument.replace('/opt/aru-desire-heartbeat', release));

  const configPath = path.join(release, 'config/default.json');
  const flags = spawnSync('/bin/bash', [
    '-c', 'umask 077; exec "$@"', 'artifact-rehearsal', process.execPath,
    path.join(release, 'scripts/set-interaction-flags.mjs'), configPath,
    'chatStimulusEnabled=true', 'arousalEnabled=true',
    'arousalDriveSettlementEnabled=true', 'soloSessionsEnabled=false',
  ], { encoding: 'utf8' });
  assert.equal(flags.status, 0, flags.stderr);
  assert.equal((await stat(configPath)).mode & 0o777, 0o644);
  const enabledConfig = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(enabledConfig.chatStimulusEnabled, true);
  assert.equal(enabledConfig.arousalEnabled, true);
  assert.equal(enabledConfig.arousalDriveSettlementEnabled, true);
  assert.equal(enabledConfig.soloSessionsEnabled, false);

  const storage = await import(pathToFileURL(path.join(release, 'src/storage.mjs')));
  const engine = await import(pathToFileURL(path.join(release, 'src/engine.mjs')));
  const interactionRuntime = await import(
    pathToFileURL(path.join(release, 'src/interaction-runtime.mjs'))
  );
  const interactionStorage = await import(
    pathToFileURL(path.join(release, 'src/interaction-storage.mjs'))
  );
  const canonical = await import(
    pathToFileURL(path.join(release, 'src/canonical-turn-event.mjs'))
  );
  const config = await storage.loadConfig(configPath);
  const startedAt = Date.parse('2026-09-26T06:00:00.000Z');
  await storage.atomicSaveState(
    dataDirectory, engine.createInitialState(config, startedAt), config, { mustCreate: true },
  );
  await interactionStorage.initializeInteractionState(
    dataDirectory, interactionRuntime.createInteractionState(startedAt), config,
  );

  const secret = 'z'.repeat(48);
  const secretPath = path.join(dataDirectory, 'turn-hook.secret');
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 });
  const port = await unusedLoopbackPort();
  const receiverEnvironment = { ...process.env };
  delete receiverEnvironment.NODE_TEST_CONTEXT;
  const child = spawn(executable, stagedArguments, {
    cwd: release,
    env: {
      ...receiverEnvironment,
      ARU_DESIRE_RECEIVER_HOST: '127.0.0.1',
      ARU_DESIRE_RECEIVER_PORT: String(port),
      ARU_DESIRE_CONFIG: configPath,
      ARU_DESIRE_DATA_DIR: dataDirectory,
      ARU_DESIRE_TURN_HOOK_SECRET_FILE: secretPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  let stopped = false;
  t.after(async () => {
    if (!stopped) await stopChild(child).catch(() => {});
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`, child, output);

  const identity = {
    conversationId: 'hostconv_artifact_synthetic',
    messageId: 'hostmsg_artifact_synthetic',
    role: 'user',
  };
  const sourceText = 'I am sad and need support from you.';
  const event = {
    schema_version: canonical.CANONICAL_TURN_SCHEMA,
    event_id: canonical.canonicalEventId(identity),
    conversation_id: identity.conversationId,
    message_id: identity.messageId,
    parent_message_id: null,
    role: identity.role,
    completed_at: startedAt + 1,
    complete: true,
    text: sourceText,
    source: 'aru_on_turn_settled',
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await postEvent(`${baseUrl}/v1/complete-message`, secret, event);
    assert.equal(response.status, 200, await response.text());
  }
  const aruRelease = path.join(directory, 'aru-release');
  await mkdir(aruRelease, { mode: 0o700 });
  for (const relative of ['aru-desire-turn-hook.mjs', 'synthetic-check.mjs']) {
    await copyFile(path.join(ROOT, 'aru-hook', relative), path.join(aruRelease, relative));
  }
  const activationId = 'activation-20260926T060000Z';
  const synthetic = spawnSync(process.execPath, [
    path.join(aruRelease, 'synthetic-check.mjs'), activationId,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARU_DESIRE_TURN_HOOK_ENABLED: 'true',
      ARU_DESIRE_TURN_HOOK_ENDPOINT: `${baseUrl}/v1/complete-message`,
      ARU_DESIRE_TURN_HOOK_SECRET_FILE: secretPath,
      ARU_DESIRE_TURN_HOOK_TIMEOUT_MS: '1000',
    },
  });
  assert.equal(synthetic.status, 0, synthetic.stderr);
  const ledger = spawnSync(process.execPath, [
    path.join(release, 'scripts/verify-synthetic-ledger.mjs'),
    configPath, dataDirectory, activationId,
  ], { encoding: 'utf8' });
  assert.equal(ledger.status, 0, ledger.stderr);
  const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
  assert.equal(health.duplicate_count, 3);
  const desire = await storage.loadState(dataDirectory, config);
  const interaction = await interactionStorage.loadInteractionState(dataDirectory, config);
  assert.ok(desire.drives.attachment > 0);
  assert.equal(interaction.chat.processedEvents.length, 3);
  assert.equal(interaction.chat.processedEvents[0].eventId, event.event_id);
  const persisted = `${await readFile(path.join(dataDirectory, 'state.json'), 'utf8')}` +
    `${await readFile(path.join(dataDirectory, 'interaction-state.json'), 'utf8')}`;
  assert.doesNotMatch(persisted, new RegExp(sourceText, 'u'));

  const exitCode = await stopChild(child);
  stopped = true;
  assert.equal(exitCode, null);
  assert.doesNotMatch(Buffer.concat(output).toString('utf8'), /sad and need support/iu);
});
