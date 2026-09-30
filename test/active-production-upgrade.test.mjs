import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod, copyFile, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/engine.mjs';
import { createInteractionState } from '../src/interaction-runtime.mjs';
import { createDeploymentMetadata } from '../scripts/formal-release-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE = path.join(ROOT, 'scripts/upgrade-active-production-once.sh');
const ROLLBACK = path.join(ROOT, 'scripts/rollback-active-production-upgrade.sh');
const LEGACY_ATTEMPT_SCHEDULER_VERSIONS = new Set(['0.9.14', '0.9.15', '0.9.16']);
const fixtures = [];
test.after(async () => Promise.all(fixtures.map((item) => rm(item, { recursive: true, force: true }))));

async function executable(file, source) {
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
}

async function makeFixture(oldVersion = '0.9.14') {
  const root = await mkdtemp(path.join(tmpdir(), 'active-upgrade-'));
  fixtures.push(root);
  const heartbeat = path.join(root, 'opt/aru-desire-heartbeat');
  const data = path.join(root, 'var/lib/aru-desire-heartbeat');
  const releases = path.join(root, 'opt/aru-selfhost/releases');
  const oldRelease = path.join(releases, `old-${oldVersion}`);
  const unitDir = path.join(root, 'etc/systemd/system');
  const stateDir = path.join(root, 'systemctl-state');
  const installBackup = path.join(root, 'var/backups/aru-desire-turn-hook/original');
  await Promise.all([
    mkdir(heartbeat, { recursive: true }), mkdir(data, { recursive: true }),
    mkdir(oldRelease, { recursive: true }), mkdir(unitDir, { recursive: true }),
    mkdir(path.join(unitDir, 'aru-selfhost.service.d'), { recursive: true }),
    mkdir(stateDir, { recursive: true }), mkdir(installBackup, { recursive: true }),
    mkdir(path.join(root, 'etc/aru-desire-heartbeat'), { recursive: true }),
  ]);

  const listing = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/verify-runtime-release.mjs'), 'list', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = listing.stdout.trim().split('\n');
  for (const relative of [...files, 'config/default.json', 'config/aru-delivery.json']) {
    const destination = path.join(heartbeat, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const packageMetadata = JSON.parse(await readFile(path.join(heartbeat, 'package.json')));
  packageMetadata.version = oldVersion;
  await writeFile(path.join(heartbeat, 'package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`);
  const config = JSON.parse(await readFile(path.join(heartbeat, 'config/default.json')));
  Object.assign(config, {
    observeOnly: false, deliveryEnabled: true, chatStimulusEnabled: true,
    arousalEnabled: true, arousalDriveSettlementEnabled: true, soloSessionsEnabled: false,
  });
  const stateConfig = structuredClone(config);
  if (LEGACY_ATTEMPT_SCHEDULER_VERSIONS.has(oldVersion)) {
    delete config.attemptWindowMinSeconds;
    delete config.attemptWindowMaxSeconds;
  }
  await writeFile(path.join(heartbeat, 'config/default.json'), `${JSON.stringify(config, null, 2)}\n`);
  const delivery = JSON.parse(await readFile(path.join(heartbeat, 'config/aru-delivery.json')));
  delivery.enabled = true;
  delivery.credentialPath = path.join(data, 'external-trigger.send-credential');
  delivery.enableFile = path.join(root, 'etc/aru-desire-heartbeat/external-trigger.enable');
  await writeFile(path.join(heartbeat, 'config/aru-delivery.json'), `${JSON.stringify(delivery, null, 2)}\n`);
  const now = Date.now();
  const state = createInitialState(stateConfig, now);
  if (LEGACY_ATTEMPT_SCHEDULER_VERSIONS.has(oldVersion)) delete state.nextAttemptAt;
  await writeFile(path.join(data, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(
    path.join(data, 'interaction-state.json'),
    `${JSON.stringify(createInteractionState(now), null, 2)}\n`,
  );
  const credential = 'A'.repeat(64);
  await writeFile(path.join(data, 'external-trigger.send-credential'), `${credential}\n`, { mode: 0o600 });
  await writeFile(
    path.join(root, 'etc/aru-desire-heartbeat/external-trigger.enable'),
    'aru-desire-heartbeat-external-trigger-v1\n',
  );
  const manifestResult = spawnSync(process.execPath, [
    path.join(heartbeat, 'scripts/runtime-release-manifest.mjs'), 'create', heartbeat,
  ], { encoding: 'utf8' });
  assert.equal(manifestResult.status, 0, manifestResult.stderr);
  await writeFile(path.join(heartbeat, 'release-manifest.json'), manifestResult.stdout);
  await copyFile(path.join(heartbeat, 'release-manifest.json'), path.join(oldRelease, 'release-manifest.json'));
  await chmod(path.join(heartbeat, 'release-manifest.json'), 0o644);
  await chmod(path.join(oldRelease, 'release-manifest.json'), 0o644);
  await writeFile(path.join(oldRelease, 'server.mjs'), '// old release identity\n');
  await symlink(oldRelease, path.join(root, 'opt/aru-selfhost/current'));
  const metadata = createDeploymentMetadata({
    expectedCurrent: oldRelease,
    previousRelease: path.join(releases, 'previous'),
    backupRoot: installBackup,
    installedAt: '2026-09-29T00:00:00Z',
  }, {
    releasePrefix: `${releases}/`,
    backupPrefix: path.join(root, 'var/backups/aru-desire-turn-hook/'),
  });
  await writeFile(
    path.join(heartbeat, 'deployment-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await chmod(path.join(heartbeat, 'deployment-metadata.json'), 0o644);
  for (const unit of [
    'aru-desire-heartbeat.service', 'aru-desire-heartbeat.timer',
    'aru-desire-turn-receiver.service', 'aru-desire-dashboard.service',
  ]) await copyFile(path.join(ROOT, 'systemd', unit), path.join(unitDir, unit));
  await copyFile(
    path.join(ROOT, 'systemd/aru-selfhost-desire-turn-hook.conf'),
    path.join(unitDir, 'aru-selfhost.service.d/desire-turn-hook.conf'),
  );

  const serviceStates = {
    'aru-desire-heartbeat.service': ['static', 'inactive'],
    'aru-desire-heartbeat.timer': ['enabled', 'active'],
    'aru-desire-turn-receiver.service': ['enabled', 'active'],
    'aru-desire-dashboard.service': ['enabled', 'active'],
    'aru-selfhost.service': ['enabled', 'active'],
  };
  for (const [unit, [enabled, active]] of Object.entries(serviceStates)) {
    await writeFile(path.join(stateDir, `${unit}.enabled`), `${enabled}\n`);
    await writeFile(path.join(stateDir, `${unit}.active`), `${active}\n`);
  }
  const systemctl = path.join(root, 'fake-systemctl');
  await executable(systemctl, `#!/usr/bin/env bash
set -Eeuo pipefail
dir=\${SYSTEMCTL_STATE_DIR:?}
op=\$1; shift
case \$op in
  is-enabled) cat "\$dir/\$1.enabled" ;;
  is-active) cat "\$dir/\$1.active" ;;
  daemon-reload) exit 0 ;;
  start|restart|stop)
    value=active; [[ \$op != stop ]] || value=inactive
    for unit in "\$@"; do printf '%s\\n' "\$value" > "\$dir/\$unit.active"; done ;;
  enable|disable)
    value=enabled; [[ \$op != disable ]] || value=disabled
    if [[ \${1:-} == --now ]]; then shift; fi
    for unit in "\$@"; do printf '%s\\n' "\$value" > "\$dir/\$unit.enabled"; done ;;
  *) exit 64 ;;
esac
`);

  const installer = path.join(root, 'fake-installer');
  await executable(installer, `#!/usr/bin/env bash
set -Eeuo pipefail
source_root=\$1; prefix=\$2
[[ \${ARU_ACTIVE_UPGRADE_FAIL_STAGE:-} != installer_internal ]] || exit 91
target="\$prefix/opt/aru-desire-heartbeat"
old_config="\$(mktemp)"; cp "\$target/config/default.json" "\$old_config"
listing="\$(node "\$source_root/scripts/verify-runtime-release.mjs" list "\$source_root")"
while IFS= read -r relative; do
  mkdir -p "\$target/\$(dirname "\$relative")"
  cp "\$source_root/\$relative" "\$target/\$relative"
done <<< "\$listing"
cp "\$source_root/config/default.json" "\$target/config/default.json"
node -e 'const fs=require("fs"),n=JSON.parse(fs.readFileSync(process.argv[1])),o=JSON.parse(fs.readFileSync(process.argv[2])); for(const k of ["observeOnly","deliveryEnabled","chatStimulusEnabled","arousalEnabled","arousalDriveSettlementEnabled","soloSessionsEnabled"]) n[k]=o[k]; fs.writeFileSync(process.argv[1],JSON.stringify(n,null,2)+"\\n")' "\$target/config/default.json" "\$old_config"
manifest="\$(node "\$target/scripts/runtime-release-manifest.mjs" create "\$target")"
printf '%s\\n' "\$manifest" > "\$target/release-manifest.json"
stamp=fixture
new_release="\$prefix/opt/aru-selfhost/releases/v0.9.18-\$stamp"
rm -rf "\$new_release"; mkdir -p "\$new_release"
cp "\$target/release-manifest.json" "\$new_release/release-manifest.json"
printf '// upgraded release\\n' > "\$new_release/server.mjs"
old_release="\$(readlink -f "\$prefix/opt/aru-selfhost/current")"
backup="\$prefix/var/backups/aru-desire-turn-hook/fake-install"
mkdir -p "\$backup"
node --input-type=module -e 'const {createDeploymentMetadata}=await import(process.argv[1]); const m=createDeploymentMetadata({expectedCurrent:process.argv[2],previousRelease:process.argv[3],backupRoot:process.argv[4],installedAt:"2026-09-29T00:01:00Z"},{releasePrefix:process.argv[5],backupPrefix:process.argv[6]}); process.stdout.write(JSON.stringify(m,null,2)+"\\n")' "file://\$source_root/scripts/formal-release-layout.mjs" "\$new_release" "\$old_release" "\$backup" "\$prefix/opt/aru-selfhost/releases/" "\$prefix/var/backups/aru-desire-turn-hook/" > "\$target/deployment-metadata.json"
ln -s "\$new_release" "\$prefix/opt/aru-selfhost/current.next"
mv -Tf "\$prefix/opt/aru-selfhost/current.next" "\$prefix/opt/aru-selfhost/current"
`);

  return { root, heartbeat, data, stateDir, systemctl, installer, oldRelease };
}

async function withHealthServer(run) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}/healthz`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runUpgrade(fixture, healthUrl, extra = {}) {
  const child = spawn(UPGRADE, ['--apply'], {
    env: {
      ...process.env,
      ARU_ACTIVE_UPGRADE_ISOLATED_TEST_MODE: '1',
      ARU_ACTIVE_UPGRADE_TEST_ROOT: fixture.root,
      ARU_ACTIVE_UPGRADE_TEST_SYSTEMCTL: fixture.systemctl,
      ARU_ACTIVE_UPGRADE_TEST_INSTALLER: fixture.installer,
      ARU_ACTIVE_UPGRADE_TEST_DASHBOARD_HEALTH_URL: healthUrl,
      SYSTEMCTL_STATE_DIR: fixture.stateDir,
      ...extra,
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({
      status, signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

test('active production upgrade succeeds, is repeat-safe, and explicitly rolls back', async () => {
  await withHealthServer(async (healthUrl) => {
    const fixture = await makeFixture('0.9.14');
    const stateBefore = await readFile(path.join(fixture.data, 'state.json'));
    const interactionBefore = await readFile(path.join(fixture.data, 'interaction-state.json'));
    const legacyConfig = JSON.parse(await readFile(
      path.join(fixture.heartbeat, 'config/default.json'), 'utf8',
    ));
    assert.equal(Object.hasOwn(legacyConfig, 'attemptWindowMinSeconds'), false);
    assert.equal(Object.hasOwn(legacyConfig, 'attemptWindowMaxSeconds'), false);
    assert.equal(Object.hasOwn(JSON.parse(stateBefore), 'nextAttemptAt'), false);
    const result = await runUpgrade(fixture, healthUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ACTIVE_UPGRADE=PASS$/mu);
    assert.match(result.stdout, /^new_version=0\.9\.18$/mu);
    assert.doesNotMatch(result.stdout + result.stderr, /A{16}|message|token|credential/iu);
    assert.deepEqual(await readFile(path.join(fixture.data, 'state.json')), stateBefore);
    assert.deepEqual(await readFile(path.join(fixture.data, 'interaction-state.json')), interactionBefore);
    assert.equal(JSON.parse(await readFile(
      path.join(fixture.heartbeat, 'config/aru-delivery.json'), 'utf8',
    )).enabled, true);
    const migratedConfig = JSON.parse(await readFile(
      path.join(fixture.heartbeat, 'config/default.json'), 'utf8',
    ));
    assert.equal(migratedConfig.attemptWindowMinSeconds, 1800);
    assert.equal(migratedConfig.attemptWindowMaxSeconds, 7200);
    assert.equal((await readFile(path.join(fixture.stateDir,
      'aru-desire-heartbeat.timer.active'), 'utf8')).trim(), 'active');
    const backup = result.stdout.match(/^backup=(.+)$/mu)?.[1];
    assert.ok(backup);

    const repeat = await runUpgrade(fixture, healthUrl);
    assert.notEqual(repeat.status, 0);
    assert.match(repeat.stderr, /^ACTIVE_UPGRADE=FAIL$/mu);
    assert.deepEqual(await readFile(path.join(fixture.data, 'state.json')), stateBefore);

    const rollback = spawnSync(ROLLBACK, [backup], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARU_ACTIVE_UPGRADE_ISOLATED_TEST_MODE: '1',
        ARU_ACTIVE_UPGRADE_TEST_ROOT: fixture.root,
        ARU_ACTIVE_UPGRADE_TEST_SYSTEMCTL: fixture.systemctl,
        SYSTEMCTL_STATE_DIR: fixture.stateDir,
      },
    });
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.match(rollback.stdout, /^ACTIVE_UPGRADE_ROLLBACK=PASS$/mu);
    assert.equal(JSON.parse(await readFile(path.join(fixture.heartbeat, 'package.json'))).version,
      '0.9.14');
    assert.equal(await readlink(path.join(fixture.root, 'opt/aru-selfhost/current')),
      fixture.oldRelease);
    assert.deepEqual(await readFile(path.join(fixture.data, 'state.json')), stateBefore);
  });
});

test('legacy config migration accepts absence but rejects a present wrong type before mutation', async () => {
  await withHealthServer(async (healthUrl) => {
    const fixture = await makeFixture('0.9.14');
    const heartbeatConfig = path.join(fixture.heartbeat, 'config/default.json');
    const malformed = JSON.parse(await readFile(heartbeatConfig, 'utf8'));
    malformed.attemptWindowMinSeconds = '1800';
    await writeFile(heartbeatConfig, `${JSON.stringify(malformed, null, 2)}\n`);
    const before = await Promise.all([
      readFile(path.join(fixture.heartbeat, 'package.json')),
      readFile(heartbeatConfig),
      readFile(path.join(fixture.data, 'state.json')),
      readFile(path.join(fixture.data, 'interaction-state.json')),
    ]);
    const result = await runUpgrade(fixture, healthUrl);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr,
      'ACTIVE_UPGRADE=FAIL\nstage=preflight\n' +
      'failure_class=heartbeat_config_schema\n');
    assert.deepEqual(await Promise.all([
      readFile(path.join(fixture.heartbeat, 'package.json')),
      readFile(heartbeatConfig),
      readFile(path.join(fixture.data, 'state.json')),
      readFile(path.join(fixture.data, 'interaction-state.json')),
    ]), before);
    await assert.rejects(() => readFile(path.join(
      fixture.root, 'var/backups/aru-desire-active-upgrades',
    )));
    assert.equal((await readFile(path.join(fixture.stateDir,
      'aru-desire-heartbeat.timer.active'), 'utf8')).trim(), 'active');
  });
});

test('active preflight accepts a unit differing only by trailing blank lines', async () => {
  await withHealthServer(async (healthUrl) => {
    const fixture = await makeFixture('0.9.14');
    const unit = path.join(fixture.root, 'etc/systemd/system/aru-desire-heartbeat.service');
    await writeFile(unit, `${await readFile(unit, 'utf8')}\n \t\n\n`);
    const result = await runUpgrade(fixture, healthUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ACTIVE_UPGRADE=PASS$/mu);
  });
});

test('active preflight accepts CRLF line endings and a missing final newline', async () => {
  await withHealthServer(async (healthUrl) => {
    for (const transform of [
      (value) => value.replaceAll('\n', '\r\n'),
      (value) => value.replace(/\n$/u, ''),
    ]) {
      const fixture = await makeFixture('0.9.14');
      const unit = path.join(fixture.root, 'etc/systemd/system/aru-desire-heartbeat.service');
      await writeFile(unit, transform(await readFile(unit, 'utf8')));
      const result = await runUpgrade(fixture, healthUrl);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^ACTIVE_UPGRADE=PASS$/mu);
    }
  });
});

test('meaningful unit and ExecStart path drift fail closed before production mutation', async () => {
  await withHealthServer(async (healthUrl) => {
    for (const mutate of [
      (value) => value.replace(
        'Description=Aru autonomous desire heartbeat',
        'Description=Aru autonomous desire heartbeat changed',
      ),
      (value) => value.replace('/usr/bin/node', '/usr/local/bin/node'),
    ]) {
      const fixture = await makeFixture('0.9.14');
      const unit = path.join(fixture.root, 'etc/systemd/system/aru-desire-heartbeat.service');
      const heartbeatConfig = path.join(fixture.heartbeat, 'config/default.json');
      const deliveryConfig = path.join(fixture.heartbeat, 'config/aru-delivery.json');
      const marker = path.join(
        fixture.root, 'etc/aru-desire-heartbeat/external-trigger.enable',
      );
      const originalUnit = await readFile(unit, 'utf8');
      const unitBefore = mutate(originalUnit);
      assert.notEqual(unitBefore, originalUnit);
      await writeFile(unit, unitBefore);
      const before = await Promise.all([
        readFile(path.join(fixture.heartbeat, 'package.json')),
        readFile(heartbeatConfig), readFile(deliveryConfig), readFile(marker),
        readFile(path.join(fixture.data, 'state.json')),
        readFile(path.join(fixture.data, 'interaction-state.json')),
      ]);
      const result = await runUpgrade(fixture, healthUrl);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr,
        'ACTIVE_UPGRADE=FAIL\nstage=preflight\n' +
        'failure_class=heartbeat_unit_content_mismatch\n');
      assert.doesNotMatch(result.stderr, /A{16}|message|token|credential|https?:\/\//iu);
      assert.deepEqual(await Promise.all([
        readFile(path.join(fixture.heartbeat, 'package.json')),
        readFile(heartbeatConfig), readFile(deliveryConfig), readFile(marker),
        readFile(path.join(fixture.data, 'state.json')),
        readFile(path.join(fixture.data, 'interaction-state.json')),
      ]), before);
      assert.equal(await readFile(unit, 'utf8'), unitBefore);
      await assert.rejects(() => readFile(path.join(
        fixture.root, 'var/backups/aru-desire-active-upgrades',
      )));
      assert.equal((await readFile(path.join(fixture.stateDir,
        'aru-desire-heartbeat.timer.active'), 'utf8')).trim(), 'active');
      assert.equal((await readFile(path.join(fixture.stateDir,
        'aru-desire-heartbeat.service.active'), 'utf8')).trim(), 'inactive');
    }
  });
});

test('every active-upgrade critical failure restores the exact old snapshot', async () => {
  await withHealthServer(async (healthUrl) => {
    for (const stage of [
      'after_backup', 'after_quiesce', 'after_safe_gates', 'installer_internal',
      'after_install', 'after_restore_gates', 'after_restore_services',
    ]) {
      const fixture = await makeFixture('0.9.14');
      const runtimeBefore = await readFile(path.join(fixture.heartbeat, 'package.json'));
      const stateBefore = await readFile(path.join(fixture.data, 'state.json'));
      const interactionBefore = await readFile(path.join(fixture.data, 'interaction-state.json'));
      const result = await runUpgrade(
        fixture, healthUrl, { ARU_ACTIVE_UPGRADE_FAIL_STAGE: stage },
      );
      assert.notEqual(result.status, 0, stage);
      assert.match(result.stderr, /automatic_rollback=PASS/u, stage);
      assert.deepEqual(await readFile(path.join(fixture.heartbeat, 'package.json')), runtimeBefore, stage);
      assert.deepEqual(await readFile(path.join(fixture.data, 'state.json')), stateBefore, stage);
      assert.deepEqual(await readFile(path.join(fixture.data, 'interaction-state.json')),
        interactionBefore, stage);
      assert.equal(JSON.parse(await readFile(
        path.join(fixture.heartbeat, 'config/aru-delivery.json'), 'utf8',
      )).enabled, true, stage);
      assert.equal((await readFile(path.join(fixture.stateDir,
        'aru-desire-heartbeat.timer.active'), 'utf8')).trim(), 'active', stage);
      assert.equal((await readFile(path.join(fixture.stateDir,
        'aru-desire-heartbeat.timer.enabled'), 'utf8')).trim(), 'enabled', stage);
    }
  });
});

test('v0.9.15 through v0.9.17 are accepted and unsupported versions fail closed', async () => {
  await withHealthServer(async (healthUrl) => {
    const compatible = await makeFixture('0.9.15');
    assert.equal((await runUpgrade(compatible, healthUrl)).status, 0);
    const latestCompatible = await makeFixture('0.9.16');
    assert.equal((await runUpgrade(latestCompatible, healthUrl)).status, 0);
    const currentCompatible = await makeFixture('0.9.17');
    assert.equal((await runUpgrade(currentCompatible, healthUrl)).status, 0);
    const unsupported = await makeFixture('0.9.13');
    const before = await readFile(path.join(unsupported.heartbeat, 'package.json'));
    const result = await runUpgrade(unsupported, healthUrl);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(path.join(unsupported.heartbeat, 'package.json')), before);
  });
});
