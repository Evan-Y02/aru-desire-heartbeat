import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInitialState, decideState } from '../src/engine.mjs';
import {
  renderAutonomyActivationPreflight,
  runAutonomyActivationPreflight,
} from '../scripts/autonomy-activation-preflight.mjs';

const directories = [];
const uid = process.getuid();
const gid = process.getgid();
const secretMarker = 'DO-NOT-PRINT-private-marker';
const privateURL = 'https://private.example/hidden/events';

after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function fixture({ pending = false, timer = 'active' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'autonomy-preflight-'));
  directories.push(root);
  const heartbeat = JSON.parse(await readFile(
    new URL('../config/default.json', import.meta.url), 'utf8'));
  heartbeat.observeOnly = true;
  heartbeat.deliveryEnabled = false;
  const delivery = JSON.parse(await readFile(
    new URL('../config/aru-delivery.json', import.meta.url), 'utf8'));
  delivery.enabled = true;
  delivery.credentialPath = path.join(root, 'credential');
  delivery.enableFile = path.join(root, 'enable');
  const now = Date.parse('2026-09-29T00:00:00Z');
  let state = createInitialState(heartbeat, now);
  if (pending) {
    state.drives.attachment = 1;
    state.drives.fatigue = 0;
    state = decideState(state, heartbeat, now + 1).state;
    assert.notEqual(state.pendingDecision, null);
  }
  const credential = {
    schema: 'aru.wake-bridge.sender-bundle.v2',
    triggerId: 'private-trigger-id', submitURL: privateURL,
    submitToken: secretMarker,
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  };
  const files = {
    heartbeat: path.join(root, 'heartbeat.json'), delivery: path.join(root, 'delivery.json'),
    state: path.join(root, 'state.json'), credential: path.join(root, 'credential'),
    sourceCredential: path.join(root, 'source-credential'),
    sourcePackage: path.join(root, 'source-package.json'),
    targetPackage: path.join(root, 'target-package.json'),
    sourceService: path.join(root, 'source.service'),
    installedService: path.join(root, 'installed.service'),
    sourceTimer: path.join(root, 'source.timer'),
    installedTimer: path.join(root, 'installed.timer'),
    systemctl: path.join(root, 'systemctl'), enableFile: path.join(root, 'enable'),
  };
  const writes = [
    [files.heartbeat, heartbeat, 0o644], [files.delivery, delivery, 0o644],
    [files.state, state, 0o600], [files.credential, credential, 0o600],
    [files.sourceCredential, credential, 0o600],
    [files.sourcePackage, { version: '0.9.13' }, 0o644],
    [files.targetPackage, { version: '0.9.13' }, 0o644],
  ];
  for (const [file, value, mode] of writes) {
    await writeFile(file, `${JSON.stringify(value)}\n`, { mode });
    await chmod(file, mode);
  }
  for (const file of [files.sourceService, files.installedService,
    files.sourceTimer, files.installedTimer]) {
    await writeFile(file, '[Unit]\nDescription=safe\n', { mode: 0o644 });
    await chmod(file, 0o644);
  }
  await writeFile(files.systemctl, `#!/bin/sh
if [ "$1" = is-active ] && [ "$2" = aru-desire-heartbeat.service ]; then echo inactive; exit 3; fi
if [ "$1" = is-active ]; then echo ${timer}; exit 0; fi
if [ "$1" = is-enabled ]; then echo enabled; exit 0; fi
exit 1
`, { mode: 0o755 });
  await chmod(files.systemctl, 0o755);
  return {
    root, files,
    options: {
      heartbeat: files.heartbeat, delivery: files.delivery, state: files.state,
      credential: files.credential, sourceCredential: files.sourceCredential,
      enableFile: files.enableFile, sourcePackage: files.sourcePackage,
      targetPackage: files.targetPackage,
      units: [
        { source: files.sourceService, installed: files.installedService },
        { source: files.sourceTimer, installed: files.installedTimer },
      ],
      rootUid: uid, rootGid: gid, sourceUid: uid, credentialSourceUid: uid,
      serviceUid: uid, serviceGid: gid, sourceFileMode: 0o644,
      systemctl: files.systemctl, serviceUnit: 'aru-desire-heartbeat.service',
      timerUnit: 'aru-desire-heartbeat.timer',
    },
  };
}

test('clean fixture passes and reports that an active timer needs quiescing', async () => {
  const { options } = await fixture();
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.result, 'PASS');
  assert.equal(report.timerQuiesceRequired, 1);
  assert.equal(report.credential, 'PASS');
});

test('preflight output is fixed and never exposes credential or URL material', async () => {
  const { options } = await fixture();
  const output = renderAutonomyActivationPreflight(
    await runAutonomyActivationPreflight(options));
  assert.doesNotMatch(output, /private|https|token|trigger-id|credential\.send/u);
  assert.match(output, /^AUTONOMY_ACTIVATION_PREFLIGHT=PASS$/mu);
});

test('pending decision stops before credential identity access', async () => {
  const { options, files } = await fixture({ pending: true });
  options.credential = path.join(path.dirname(files.credential), 'missing-installed-secret');
  options.sourceCredential = path.join(path.dirname(files.credential), 'missing-source-secret');
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.result, 'FAIL');
  assert.equal(report.pending, 'FAIL', JSON.stringify(report));
  assert.equal(report.credential, 'INCONCLUSIVE');
  assert.equal(report.credentialErrors, 0);
});

test('credential identity mismatch fails closed without exposing values', async () => {
  const { options, files } = await fixture();
  const changed = JSON.parse(await readFile(files.sourceCredential, 'utf8'));
  changed.triggerId = 'different-private-trigger';
  await writeFile(files.sourceCredential, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.credential, 'FAIL');
  assert.equal(report.identityErrors, 1);
  assert.doesNotMatch(renderAutonomyActivationPreflight(report), /different/u);
});

test('malformed credential is classified separately from identity mismatch', async () => {
  const { options, files } = await fixture();
  await writeFile(files.credential, '{invalid\n', { mode: 0o600 });
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.credential, 'FAIL');
  assert.equal(report.credentialErrors, 1);
  assert.equal(report.identityErrors, 0);
});

test('unsafe outer gates fail closed', async () => {
  const { options, files } = await fixture();
  const heartbeat = JSON.parse(await readFile(files.heartbeat, 'utf8'));
  heartbeat.deliveryEnabled = true;
  await writeFile(files.heartbeat, `${JSON.stringify(heartbeat)}\n`, { mode: 0o644 });
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.config, 'FAIL');
  assert.equal(report.credential, 'INCONCLUSIVE');
});

test('delivery paths must remain bound to the files that preflight checks', async () => {
  const { options, files } = await fixture();
  const delivery = JSON.parse(await readFile(files.delivery, 'utf8'));
  delivery.credentialPath = path.join(path.dirname(files.delivery), 'unchecked-secret');
  await writeFile(files.delivery, `${JSON.stringify(delivery)}\n`, { mode: 0o644 });
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.config, 'FAIL');
  assert.equal(report.credential, 'INCONCLUSIVE');
});

test('version and normalized unit mismatches are independently classified', async () => {
  const { options, files } = await fixture();
  await writeFile(files.targetPackage, '{"version":"0.9.12"}\n', { mode: 0o644 });
  await writeFile(files.installedTimer, '[Unit]\nDescription=changed\n', { mode: 0o644 });
  const report = await runAutonomyActivationPreflight(options);
  assert.equal(report.versionErrors, 1);
  assert.equal(report.unitErrors, 1);
});

test('preflight has no fixture side effects', async () => {
  const { root, options } = await fixture({ timer: 'inactive' });
  const before = (await readdir(root)).sort();
  await runAutonomyActivationPreflight(options);
  assert.deepEqual((await readdir(root)).sort(), before);
});
