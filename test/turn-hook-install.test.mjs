import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { spawn, spawnSync as rawSpawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function spawnSync(command, args, options = {}) {
  const environment = { ...process.env, ...options.env };
  delete environment.NODE_TEST_CONTEXT;
  return rawSpawnSync(command, args, { ...options, env: environment });
}
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
  const relay = path.join(directory, 'conversation-turn-relay.mjs');
  const baseline = path.join(directory, 'server.baseline.mjs');
  const relayBaseline = path.join(directory, 'relay.baseline.mjs');
  await copyFile(path.join(ROOT, 'config/default.json'), config);
  await copyFile('/opt/aru-selfhost/current/server.mjs', server);
  await copyFile('/opt/aru-selfhost/current/conversation-turn-relay.mjs', relay);
  await copyFile(server, baseline);
  await copyFile(relay, relayBaseline);
  await chmod(server, 0o755);
  const serverBefore = await stat(server);
  const relayBefore = await stat(relay);

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
    path.join(ROOT, 'aru-hook/apply-server-wiring.mjs'), server, relay,
  ], { stdio: 'pipe' });
  assert.equal(patch.status, 0, patch.stderr.toString());
  const serverAfter = await stat(server);
  assert.equal(serverAfter.uid, serverBefore.uid);
  assert.equal(serverAfter.gid, serverBefore.gid);
  assert.equal(serverAfter.mode & 0o7777, serverBefore.mode & 0o7777);
  const relayAfter = await stat(relay);
  assert.equal(relayAfter.uid, relayBefore.uid);
  assert.equal(relayAfter.gid, relayBefore.gid);
  assert.equal(relayAfter.mode & 0o7777, relayBefore.mode & 0o7777);
  const syntax = spawnSync(process.execPath, ['--check', server], { stdio: 'pipe' });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
  const relaySyntax = spawnSync(process.execPath, ['--check', relay], { stdio: 'pipe' });
  assert.equal(relaySyntax.status, 0, relaySyntax.stderr.toString());
  const patchedSource = await readFile(server, 'utf8');
  const patchedRelay = await readFile(relay, 'utf8');
  assert.doesNotMatch(patchedSource, /pairingToken: state\.pairing\.token/u);
  assert.doesNotMatch(patchedSource, /console\.log\(pairingURL\)/u);
  assert.match(patchedSource, /startup logs never include credentials/u);
  assert.match(patchedSource, /candidate\?\.outcome === "completed"/u);
  assert.match(patchedRelay, /buildAruDesireRelayTurn/u);

  const repeatPatch = spawnSync(process.execPath, [
    path.join(ROOT, 'aru-hook/apply-server-wiring.mjs'), server, relay,
  ], { stdio: 'pipe' });
  assert.equal(repeatPatch.status, 0, repeatPatch.stderr.toString());
  assert.deepEqual(await readFile(server), Buffer.from(patchedSource));
  assert.deepEqual(await readFile(relay), Buffer.from(patchedRelay));

  await copyFile(baseline, server);
  await copyFile(relayBaseline, relay);
  assert.deepEqual(await readFile(server), await readFile('/opt/aru-selfhost/current/server.mjs'));
  assert.deepEqual(
    await readFile(relay),
    await readFile('/opt/aru-selfhost/current/conversation-turn-relay.mjs'),
  );
});

test('installer retains fail-closed rollback and never broadens permissions', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  assert.match(source, /trap 'handle_error "\$\?" "\$LINENO" "\$BASH_COMMAND"' ERR/u);
  assert.match(source, /mv -Tf .*CURRENT_LINK/u);
  assert.match(source, /install -o aru-selfhost -g aru-selfhost -m 0600/u);
  assert.match(source, /install -o aru-desire -g aru-desire -m 0600/u);
  const verifierSource = await readFile(
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'utf8',
  );
  assert.match(verifierSource, /local-import-closure\.mjs/u);
  assert.match(verifierSource, /bin\/desire-cycle\.mjs/u);
  assert.match(source, /verify-runtime-release\.mjs/u);
  assert.match(source, /runtime-release-manifest\.mjs" create/u);
  assert.match(source, /formal-release-layout\.mjs" create/u);
  assert.match(source, /formal-release-layout\.mjs" verify/u);
  assert.match(source, /"\$NEW_RELEASE\/\$RUNTIME_MANIFEST"/u);
  assert.match(source, /DEPLOYMENT_METADATA=deployment-metadata\.json/u);
  assert.match(source, /verify_runtime_manifest_before_current_activation/u);
  assert.match(source, /verify_runtime_manifest_after_current_activation/u);
  assert.match(source, /verify_desire_runtime_release/u);
  assert.match(source, /quiesce_heartbeat/u);
  assert.match(source, /preserve-feature-flags\.mjs" capture/u);
  assert.match(source, /preserve-feature-flags\.mjs" restore/u);
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
  assert.match(source, /ARU_DESIRE_TURN_HOOK_TIMEOUT_MS=2000/u);
  assert.match(source, /INSTALL_STAGE=synthetic_preflight/u);
  assert.match(source, /INSTALL_STAGE=synthetic_postflight/u);
  assert.match(source, /randomBytes\(8\)\.toString\('hex'\)/u);
  assert.match(source, /verify-synthetic-ledger\.mjs" \\\s+absent/u);
  assert.match(source, /verify-synthetic-ledger\.mjs" \\\s+applied-once/u);
  assert.match(source, /SECRET_CHANNEL_BEFORE=present/u);
  assert.match(source, /cmp -s -- "\$ARU_SECRET" "\$DESIRE_SECRET"/u);
  assert.match(source, /restore_aru_hook_secret/u);
  assert.match(source, /restore_desire_hook_secret/u);
  assert.match(source, /if \[\[ \$SECRET_CHANNEL_BEFORE == absent \]\]; then/u);
  assert.match(source, /remove_staged_current_link/u);
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
  assert.match(source, /DEVICE_COUNT_AFTER == "\$DEVICE_COUNT_BEFORE"/u);
  assert.match(source, /BRIDGE_CODE_AFTER == "\$BRIDGE_CODE_BEFORE"/u);
  assert.match(source, /HEARTBEAT_TIMER_WAS_ACTIVE/u);
  assert.match(source, /restore_heartbeat_timer_active/u);
  assert.doesNotMatch(source, /chmod\s+(?:-R\s+)?777|chmod\s+(?:-R\s+)?0?777/iu);
  const verifyPosition = source.lastIndexOf(
    'node "$SOURCE_ROOT/scripts/verify-runtime-release.mjs" verify',
    source.indexOf('INSTALL_STAGE=prepare_current_release'),
  );
  const preparePosition = source.indexOf('INSTALL_STAGE=prepare_current_release');
  const activatePosition = source.indexOf('INSTALL_STAGE=activate_current_release');
  const manifestBeforePosition = source.indexOf(
    'INSTALL_STAGE=verify_runtime_manifest_before_current_activation',
  );
  const manifestAfterPosition = source.indexOf(
    'INSTALL_STAGE=verify_runtime_manifest_after_current_activation',
  );
  const metadataPosition = source.indexOf('INSTALL_STAGE=activate_deployment_metadata');
  assert.ok(verifyPosition >= 0 && verifyPosition < preparePosition);
  assert.ok(manifestBeforePosition >= 0 && manifestBeforePosition < preparePosition);
  assert.ok(preparePosition < activatePosition);
  assert.ok(activatePosition < source.indexOf('mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"') + 1);
  assert.ok(metadataPosition > activatePosition && metadataPosition < manifestAfterPosition);
  assert.ok(manifestAfterPosition > activatePosition);
});

test('runtime release closure starts at the real heartbeat entry and rejects every omission', async () => {
  const listing = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'list', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split('\n');
  for (const required of [
    'bin/desire-cycle.mjs', 'delivery/aru-adapter.mjs', 'delivery/aru-wake-sender.mjs',
    'src/engine.mjs', 'src/runtime.mjs', 'src/timeline.mjs',
    'src/pending-decision.mjs', 'scripts/local-import-closure.mjs',
    'scripts/runtime-release-manifest.mjs',
  ]) assert.ok(files.includes(required),
    `${required} absent from runtime release: ${JSON.stringify(listing.stdout)}`);

  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-release-verifier-'));
  directories.push(directory);
  for (const relative of [...files, 'config/default.json', 'config/aru-delivery.json']) {
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const verify = () => spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'verify', ROOT, directory,
  ], { encoding: 'utf8' });
  assert.equal(verify().status, 0);
  for (const relative of files) {
    const file = path.join(directory, relative);
    const missing = `${file}.missing`;
    await rename(file, missing);
    const result = verify();
    assert.notEqual(result.status, 0, `${relative} omission was accepted`);
    await rename(missing, file);
  }
  await writeFile(path.join(directory, 'src/runtime.mjs'), '// mixed release\n');
  const mixed = verify();
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /runtime release mismatch: src\/runtime\.mjs/u);
});

test('independent runtime manifest covers the exact closure and rejects absence or mixing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-manifest-'));
  directories.push(directory);
  const release = path.join(directory, 'release');
  const manifest = path.join(release, 'release-manifest.json');
  await mkdir(release);
  const listing = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'list', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split('\n');
  for (const relative of [...files, 'config/default.json', 'config/aru-delivery.json']) {
    const destination = path.join(release, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const script = path.join(release, 'scripts/runtime-release-manifest.mjs');
  const created = spawnSync(process.execPath, [script, 'create', ROOT], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(manifest, created.stdout, { mode: 0o644 });

  const verify = () => spawnSync(process.execPath, [script, 'verify', release, manifest], {
    encoding: 'utf8',
  });
  assert.equal(verify().status, 0);
  const parsed = JSON.parse(await readFile(manifest, 'utf8'));
  const packageMetadata = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(parsed.schema, 'aru.desire-heartbeat.file-manifest.v1');
  assert.equal(packageMetadata.version, '0.9.9');
  assert.equal(parsed.version, packageMetadata.version);
  assert.equal(parsed.fileCount, files.length);
  assert.deepEqual(parsed.files.map((file) => file.path), files);

  const missingManifest = `${manifest}.missing`;
  await rename(manifest, missingManifest);
  assert.notEqual(verify().status, 0, 'missing manifest was accepted');
  await rename(missingManifest, manifest);

  const mixedFile = path.join(release, 'dashboard/public/app.js');
  const original = await readFile(mixedFile);
  await writeFile(mixedFile, '// mixed runtime\n');
  const mixed = verify();
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /runtime manifest mismatch: dashboard\/public\/app\.js/u);
  await writeFile(mixedFile, original);

  const incomplete = JSON.parse(await readFile(manifest, 'utf8'));
  incomplete.files.pop();
  incomplete.fileCount -= 1;
  await writeFile(manifest, `${JSON.stringify(incomplete)}\n`);
  assert.notEqual(verify().status, 0, 'incomplete manifest was accepted');
});

test('manifest verification failure before activation invokes exact release rollback', async () => {
  const installer = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  const handler = installer.match(/handle_error\(\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(handler);
  const directory = await mkdtemp(path.join(tmpdir(), 'manifest-rollback-'));
  directories.push(directory);
  const release = path.join(directory, 'release');
  const oldRelease = path.join(directory, 'old-release');
  const current = path.join(directory, 'current');
  const manifest = path.join(release, 'release-manifest.json');
  await mkdir(release);
  await mkdir(oldRelease);
  await symlink(release, current);
  const listing = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'list', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  for (const relative of [
    ...listing.stdout.trim().split('\n'), 'config/default.json', 'config/aru-delivery.json',
  ]) {
    const destination = path.join(release, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const manifestScript = path.join(release, 'scripts/runtime-release-manifest.mjs');
  const created = spawnSync(process.execPath, [manifestScript, 'create', ROOT], {
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(manifest, created.stdout);
  await writeFile(path.join(release, 'src/runtime.mjs'), '// mixed before activation\n');

  const failure = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    ${handler}
    INSTALL_STAGE=verify_runtime_manifest_before_current_activation
    ROLLBACK_READY=true
    CURRENT=$2
    OLD=$3
    rollback() {
      ln -s "$OLD" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
      printf 'isolated manifest rollback invoked\\n' >&2
    }
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    "$1" "$4" verify "$5" "$6"
  `, 'manifest-rollback-rehearsal', process.execPath, current, oldRelease,
    manifestScript, release, manifest], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /stage=verify_runtime_manifest_before_current_activation/u);
  assert.match(failure.stderr, /isolated manifest rollback invoked/u);
  assert.match(failure.stderr, /rollback completed/u);
  assert.equal(await readlink(current), oldRelease);
});

test('missing runtime dependency fails before current activation and invokes rollback', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  const handler = source.match(/handle_error\(\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(handler);
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-omission-rollback-'));
  directories.push(directory);
  const target = path.join(directory, 'target');
  const oldRelease = path.join(directory, 'old-release');
  const current = path.join(directory, 'current');
  await mkdir(target);
  await mkdir(oldRelease);
  await symlink(oldRelease, current);
  for (const relative of ['config/default.json', 'config/aru-delivery.json']) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const failure = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    ${handler}
    INSTALL_STAGE=verify_desire_runtime_release
    ROLLBACK_READY=true
    CURRENT=$2
    OLD=$3
    rollback() {
      ln -s "$OLD" "$CURRENT.rollback"
      mv -Tf "$CURRENT.rollback" "$CURRENT"
      printf 'isolated exact rollback invoked\\n' >&2
    }
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    "$1" "$4" verify "$5" "$6"
  `, 'omission-rehearsal', process.execPath, current, oldRelease,
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), ROOT, target], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /stage=verify_desire_runtime_release/u);
  assert.match(failure.stderr, /isolated exact rollback invoked/u);
  assert.match(failure.stderr, /rollback completed/u);
  assert.equal(await readlink(current), oldRelease);
});

test('feature flag snapshot preserves all production gates exactly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'feature-flag-preservation-'));
  directories.push(directory);
  const config = path.join(directory, 'default.json');
  const snapshot = path.join(directory, 'flags.json');
  const original = JSON.parse(await readFile(path.join(ROOT, 'config/default.json'), 'utf8'));
  Object.assign(original, {
    observeOnly: false,
    deliveryEnabled: true,
    chatStimulusEnabled: true,
    arousalEnabled: false,
    arousalDriveSettlementEnabled: true,
    soloSessionsEnabled: false,
  });
  await writeFile(config, `${JSON.stringify(original)}\n`, { mode: 0o644 });
  const script = path.join(ROOT, 'scripts/preserve-feature-flags.mjs');
  const capture = spawnSync(process.execPath, [script, 'capture', config, snapshot], {
    encoding: 'utf8',
  });
  assert.equal(capture.status, 0, capture.stderr);
  await copyFile(path.join(ROOT, 'config/default.json'), config);
  const restore = spawnSync(process.execPath, [script, 'restore', config, snapshot], {
    encoding: 'utf8',
  });
  assert.equal(restore.status, 0, restore.stderr);
  const verify = spawnSync(process.execPath, [script, 'verify', config, snapshot], {
    encoding: 'utf8',
  });
  assert.equal(verify.status, 0, verify.stderr);
  const restored = JSON.parse(await readFile(config, 'utf8'));
  for (const key of [
    'observeOnly', 'deliveryEnabled', 'chatStimulusEnabled', 'arousalEnabled',
    'arousalDriveSettlementEnabled', 'soloSessionsEnabled',
  ]) assert.equal(restored[key], original[key], key);
  assert.equal((await stat(config)).mode & 0o777, 0o644);
  assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
});

test('exact installer rollback restores release, config, state, unit, and service states', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  const rollbackFunction = source.match(/rollback\(\) \{[\s\S]*?\n\}/u)?.[0];
  assert.ok(rollbackFunction, 'installer rollback function was not found');

  const directory = await mkdtemp(path.join(tmpdir(), 'turn-hook-rollback-rehearsal-'));
  directories.push(directory);
  const oldRelease = path.join(directory, 'old-release');
  const newRelease = path.join(directory, 'new-release');
  const currentLink = path.join(directory, 'current');
  const desireRoot = path.join(directory, 'desire');
  const desireData = path.join(directory, 'data');
  const backup = path.join(directory, 'backup');
  const receiverUnit = path.join(directory, 'systemd', 'receiver.service');
  const aruDropin = path.join(directory, 'systemd', 'aru.service.d', 'hook.conf');
  const aruSecret = path.join(directory, 'aru.secret');
  const desireSecret = path.join(directory, 'desire.secret');
  const serviceLog = path.join(directory, 'systemctl.log');
  await Promise.all([
    mkdir(oldRelease, { recursive: true }), mkdir(newRelease, { recursive: true }),
    mkdir(path.join(desireRoot, 'config'), { recursive: true }),
    mkdir(path.join(desireRoot, 'src'), { recursive: true }),
    mkdir(desireData, { recursive: true }),
    mkdir(path.join(backup, 'desire', 'config'), { recursive: true }),
    mkdir(path.join(backup, 'desire', 'src'), { recursive: true }),
    mkdir(path.join(backup, 'systemd'), { recursive: true }),
    mkdir(path.dirname(aruDropin), { recursive: true }),
  ]);
  await symlink(newRelease, currentLink);
  await symlink(newRelease, `${currentLink}.next`);
  await Promise.all([
    writeFile(path.join(desireRoot, 'config/default.json'), 'new-config\n'),
    writeFile(path.join(desireRoot, 'src/engine.mjs'), 'new-engine\n'),
    writeFile(path.join(desireRoot, 'src/new-only.mjs'), 'new-only\n'),
    writeFile(path.join(desireRoot, 'release-manifest.json'), 'new-manifest\n'),
    writeFile(path.join(desireRoot, 'release-manifest.json.next'), 'partial-manifest\n'),
    writeFile(path.join(desireRoot, 'deployment-metadata.json'), 'new-expected\n'),
    writeFile(path.join(desireRoot, 'deployment-metadata.json.next'), 'partial-expected\n'),
    writeFile(path.join(backup, 'desire/config/default.json'), 'old-config\n'),
    writeFile(path.join(backup, 'desire/src/engine.mjs'), 'old-engine\n'),
    writeFile(path.join(backup, 'desire/release-manifest.json'), 'old-manifest\n'),
    writeFile(path.join(backup, 'desire/deployment-metadata.json'), 'old-expected\n'),
    writeFile(
      path.join(backup, 'desire-missing-files'),
      'src/new-only.mjs\n',
    ),
    writeFile(path.join(desireData, 'state.json'), 'new-state\n'),
    writeFile(path.join(desireData, 'interaction-state.json'), 'new-interaction\n'),
    writeFile(path.join(backup, 'state.json'), 'old-state\n'),
    writeFile(path.join(backup, 'interaction-state.json'), 'old-interaction\n'),
    writeFile(receiverUnit, 'new-unit\n'),
    writeFile(aruDropin, 'new-dropin\n'),
    writeFile(path.join(backup, 'systemd/aru-desire-turn-receiver.service'), 'old-unit\n'),
    writeFile(path.join(backup, 'systemd/desire-turn-hook.conf'), 'old-dropin\n'),
    writeFile(aruSecret, 'new-secret\n'), writeFile(desireSecret, 'new-secret\n'),
    writeFile(path.join(backup, 'aru-turn-hook.secret'), 'old-secret\n'),
    writeFile(path.join(backup, 'desire-turn-hook.secret'), 'old-secret\n'),
  ]);
  await mkdir(path.join(backup, 'aru'), { recursive: true });
  await copyFile(path.join(backup, 'aru-turn-hook.secret'), path.join(backup, 'aru/turn-hook.secret'));

  const rehearsal = spawnSync('/bin/bash', ['-c', `
    set -Eeuo pipefail
    CURRENT_LINK=$1
    OLD_RELEASE=$2
    DESIRE_ROOT=$3
    DESIRE_DATA=$4
    BACKUP=$5
    RECEIVER_UNIT=$6
    ARU_DROPIN=$7
    ARU_SECRET=$8
    DESIRE_SECRET=$9
    SERVICE_LOG=\${10}
    RECEIVER_WAS_ENABLED=enabled
    RECEIVER_WAS_ACTIVE=active
    ARU_WAS_ACTIVE=active
    DASHBOARD_WAS_ACTIVE=inactive
    HEARTBEAT_TIMER_TOUCHED=true
    HEARTBEAT_TIMER=aru-desire-heartbeat.timer
    HEARTBEAT_TIMER_WAS_ACTIVE=active
    HEARTBEAT_TIMER_WAS_ENABLED=enabled
    RUNTIME_MANIFEST=release-manifest.json
    DEPLOYMENT_METADATA=deployment-metadata.json
    DESIRE_FILES=(config/default.json src/engine.mjs src/new-only.mjs release-manifest.json deployment-metadata.json)
    DATA_FILES=(state.json interaction-state.json)
    systemctl() {
      printf '%s\\n' "$*" >> "$SERVICE_LOG"
      [[ $1 != is-enabled ]] || printf 'enabled\\n'
    }
    install() {
      local mode='' make_parent=false
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -o|-g) shift 2 ;;
          -m) mode=$2; shift 2 ;;
          -D) make_parent=true; shift ;;
          *) break ;;
        esac
      done
      [[ $# -eq 2 ]]
      [[ $make_parent == false ]] || mkdir -p "$(dirname "$2")"
      command install -m "$mode" "$1" "$2"
    }
    ${rollbackFunction}
    rollback
  `, 'rollback-rehearsal', currentLink, oldRelease, desireRoot, desireData, backup,
    receiverUnit, aruDropin, aruSecret, desireSecret, serviceLog], { encoding: 'utf8' });
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  assert.equal(await readlink(currentLink), oldRelease);
  await assert.rejects(() => stat(`${currentLink}.next`), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(desireRoot, 'config/default.json'), 'utf8'), 'old-config\n');
  assert.equal(await readFile(path.join(desireRoot, 'src/engine.mjs'), 'utf8'), 'old-engine\n');
  await assert.rejects(() => stat(path.join(desireRoot, 'src/new-only.mjs')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(desireRoot, 'release-manifest.json'), 'utf8'),
    'old-manifest\n');
  await assert.rejects(() => stat(path.join(desireRoot, 'release-manifest.json.next')),
    { code: 'ENOENT' });
  assert.equal(await readFile(path.join(desireRoot, 'deployment-metadata.json'), 'utf8'),
    'old-expected\n');
  await assert.rejects(() => stat(path.join(desireRoot, 'deployment-metadata.json.next')),
    { code: 'ENOENT' });
  assert.equal(await readFile(path.join(desireData, 'state.json'), 'utf8'), 'old-state\n');
  assert.equal(await readFile(path.join(desireData, 'interaction-state.json'), 'utf8'), 'old-interaction\n');
  assert.equal(await readFile(receiverUnit, 'utf8'), 'old-unit\n');
  assert.equal(await readFile(aruDropin, 'utf8'), 'old-dropin\n');
  assert.equal(await readFile(aruSecret, 'utf8'), 'old-secret\n');
  assert.equal(await readFile(desireSecret, 'utf8'), 'old-secret\n');
  const serviceCalls = await readFile(serviceLog, 'utf8');
  assert.match(serviceCalls, /^stop aru-desire-turn-receiver\.service$/mu);
  assert.match(serviceCalls, /^daemon-reload$/mu);
  assert.match(serviceCalls, /^enable aru-desire-turn-receiver\.service$/mu);
  assert.match(serviceCalls, /^restart aru-desire-turn-receiver\.service$/mu);
  assert.match(serviceCalls, /^restart aru-selfhost\.service$/mu);
  assert.match(serviceCalls, /^stop aru-desire-dashboard\.service$/mu);
  assert.match(serviceCalls, /^start aru-desire-heartbeat\.timer$/mu);
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
    INSTALL_STAGE=synthetic_end_to_end
    ROLLBACK_READY=true
    rollback() { printf 'synthetic rollback invoked\\n' >&2; return 0; }
    trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR
    /bin/false
  `], { encoding: 'utf8' });
  assert.equal(rollbackRehearsal.status, 1);
  assert.match(rollbackRehearsal.stderr, /stage=synthetic_end_to_end/u);
  assert.match(rollbackRehearsal.stderr, /synthetic rollback invoked/u);
  assert.match(rollbackRehearsal.stderr, /rollback completed/u);
  assert.ok(
    rollbackRehearsal.stderr.indexOf('stage=synthetic_end_to_end') <
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
  const pairingUrl = ['aru://', 'pair?', 'pairing', 'Token=', credential,
    '&manifestUrl=https://example.invalid'].join('');
  const sample = [
    `{"pairingToken":"${credential}"}`,
    pairingUrl,
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

test('three isolated production artifacts start clean and process replay exactly once', async (t) => {
  for (let rehearsal = 0; rehearsal < 3; rehearsal += 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-hook-artifact-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const release = path.join(directory, 'release');
  const dataDirectory = path.join(directory, 'state');
  await mkdir(release, { mode: 0o700 });
  await mkdir(dataDirectory, { mode: 0o700 });

  const closureResult = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'list', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(closureResult.status, 0, closureResult.stderr);
  const closure = closureResult.stdout.trim().split('\n');
  for (const required of [
    'bin/desire-turn-receiver.mjs', 'src/turn-receiver.mjs', 'src/engine.mjs',
    'src/pending-decision.mjs', 'src/security.mjs', 'src/storage.mjs',
    'src/interaction-runtime.mjs',
  ]) assert.ok(closure.includes(required), `${required} absent from production closure`);
  for (const relative of ['config/default.json', 'config/aru-delivery.json', ...closure]) {
    const destination = path.join(release, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
    await chmod(destination, relative.startsWith('bin/') || relative.startsWith('scripts/')
      ? 0o755 : 0o644);
  }
  const releaseVerification = spawnSync(process.execPath, [
    path.join(release, 'scripts/verify-runtime-release.mjs'), 'verify', ROOT, release,
  ], { encoding: 'utf8' });
  assert.equal(releaseVerification.status, 0, releaseVerification.stderr);
  const manifestScript = path.join(release, 'scripts/runtime-release-manifest.mjs');
  const manifestPath = path.join(release, 'release-manifest.json');
  const manifestCreation = spawnSync(process.execPath, [manifestScript, 'create', ROOT], {
    encoding: 'utf8',
  });
  assert.equal(manifestCreation.status, 0, manifestCreation.stderr);
  await writeFile(manifestPath, manifestCreation.stdout, { mode: 0o644 });
  const manifestVerification = spawnSync(process.execPath, [
    manifestScript, 'verify', release, manifestPath,
  ], { encoding: 'utf8' });
  assert.equal(manifestVerification.status, 0, manifestVerification.stderr);

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
  assert.equal(enabledConfig.observeOnly, true);
  assert.equal(enabledConfig.deliveryEnabled, false);
  enabledConfig.expression.baseWillingness = 1;
  await writeFile(configPath, `${JSON.stringify(enabledConfig, null, 2)}\n`, { mode: 0o644 });

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
  const startedAt = Date.now();
  const initialState = engine.createInitialState(config, startedAt);
  initialState.drives.attachment = 1;
  await storage.atomicSaveState(
    dataDirectory, initialState, config, { mustCreate: true },
  );
  await interactionStorage.initializeInteractionState(
    dataDirectory, interactionRuntime.createInteractionState(startedAt), config,
  );

  const isolatedEnvironment = { ...process.env };
  delete isolatedEnvironment.NODE_TEST_CONTEXT;
  const heartbeatUnit = await readFile(
    path.join(ROOT, 'systemd/aru-desire-heartbeat.service'), 'utf8',
  );
  const heartbeatExec = heartbeatUnit.match(/^ExecStart=(.+)$/mu)?.[1];
  assert.ok(heartbeatExec);
  const heartbeatArguments = heartbeatExec.split(' ').slice(1).map((argument) => argument
    .replace('/opt/aru-desire-heartbeat', release)
    .replace('/var/lib/aru-desire-heartbeat', dataDirectory));
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const heartbeat = spawnSync(process.execPath, heartbeatArguments, {
      cwd: release, encoding: 'utf8', env: isolatedEnvironment,
    });
    assert.equal(heartbeat.status, 0, heartbeat.stderr);
    assert.equal(JSON.parse(heartbeat.stdout).status, 'held_disabled');
  }
  const restartedHeartbeatState = await storage.loadState(dataDirectory, config);
  assert.equal(restartedHeartbeatState.timeline.length, 1);
  assert.match(restartedHeartbeatState.pendingDecision.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(restartedHeartbeatState.timeline[0].decisionFingerprint,
    restartedHeartbeatState.pendingDecision.fingerprint);

  const secret = 'z'.repeat(48);
  const secretPath = path.join(dataDirectory, 'turn-hook.secret');
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 });
  const port = await unusedLoopbackPort();
  const child = spawn(executable, stagedArguments, {
    cwd: release,
    env: {
      ...isolatedEnvironment,
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
    completed_at: Date.now() + 1,
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
  const activationId = `activation-20260926T060000Z-${String(rehearsal + 1)
    .padStart(16, '0')}`;
  const preflight = spawnSync(process.execPath, [
    path.join(release, 'scripts/verify-synthetic-ledger.mjs'),
    'absent', configPath, dataDirectory, activationId,
  ], { encoding: 'utf8' });
  assert.equal(preflight.status, 0, preflight.stderr);
  const synthetic = spawnSync(process.execPath, [
    path.join(aruRelease, 'synthetic-check.mjs'), activationId,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ARU_DESIRE_TURN_HOOK_ENABLED: 'true',
      ARU_DESIRE_TURN_HOOK_ENDPOINT: `${baseUrl}/v1/complete-message`,
      ARU_DESIRE_TURN_HOOK_SECRET_FILE: secretPath,
      ARU_DESIRE_TURN_HOOK_TIMEOUT_MS: '2000',
    },
  });
  assert.equal(synthetic.status, 0, synthetic.stderr);
  const postflight = spawnSync(process.execPath, [
    path.join(release, 'scripts/verify-synthetic-ledger.mjs'),
    'applied-once', configPath, dataDirectory, activationId,
  ], { encoding: 'utf8' });
  assert.equal(postflight.status, 0, postflight.stderr);
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
  }
});
