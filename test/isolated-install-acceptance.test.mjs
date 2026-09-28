import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/test-installed-hook-isolated-state.sh');
const directories = [];

test.after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'isolated-install-acceptance-'));
  directories.push(root);
  const temporaryParent = path.join(root, 'acceptance-tmp');
  const productionData = path.join(root, 'production-state-must-not-be-opened');
  await mkdir(temporaryParent);
  await mkdir(productionData, { mode: 0o700 });
  const productionFiles = [
    path.join(productionData, 'state.json'),
    path.join(productionData, 'interaction-state.json'),
  ];
  await writeFile(productionFiles[0], '{"sentinel":"desire-state"}\n', { mode: 0o600 });
  await writeFile(productionFiles[1], '{"sentinel":"interaction-state"}\n', { mode: 0o600 });
  const bytes = await Promise.all(productionFiles.map((file) => readFile(file)));
  await Promise.all(productionFiles.map((file) => chmod(file, 0o000)));
  const metadata = await Promise.all(
    productionFiles.map((file) => stat(file, { bigint: true })),
  );
  return { temporaryParent, productionFiles, before: { bytes, metadata } };
}

function runIsolated(temporaryParent, extraEnvironment = {}) {
  return spawnSync('/bin/bash', [SCRIPT, ROOT, ROOT, path.join(ROOT, 'aru-hook')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ARU_DESIRE_ISOLATED_TEST_MODE: 'true',
      ARU_DESIRE_ISOLATED_TMP_PARENT: temporaryParent,
      ...extraEnvironment,
    },
  });
}

async function assertProductionUnchanged(fixtureValue) {
  for (let index = 0; index < fixtureValue.productionFiles.length; index += 1) {
    const currentMetadata = await stat(fixtureValue.productionFiles[index], { bigint: true });
    const previous = fixtureValue.before.metadata[index];
    assert.equal(currentMetadata.mode, previous.mode);
    assert.equal(currentMetadata.uid, previous.uid);
    assert.equal(currentMetadata.gid, previous.gid);
    assert.equal(currentMetadata.size, previous.size);
    assert.equal(currentMetadata.mtimeNs, previous.mtimeNs);
    await chmod(fixtureValue.productionFiles[index], 0o600);
    assert.deepEqual(
      await readFile(fixtureValue.productionFiles[index]), fixtureValue.before.bytes[index],
    );
  }
}

test('isolated acceptance succeeds without opening or changing production state', async () => {
  const f = await fixture();
  const result = runIsolated(f.temporaryParent);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^isolated_turn_hook_acceptance=PASS$/mu);
  assert.deepEqual(await readdir(f.temporaryParent), []);
  await assertProductionUnchanged(f);
});

test('isolated acceptance failure cleans its fixture and leaves production state unchanged', async () => {
  const f = await fixture();
  const result = runIsolated(f.temporaryParent, {
    ARU_DESIRE_ISOLATED_FORCE_FAILURE: 'after_health',
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 91, result.stderr);
  assert.deepEqual(await readdir(f.temporaryParent), []);
  await assertProductionUnchanged(f);
});

test('isolated acceptance interruption cleans its process and fixture', {
  timeout: 15_000,
}, async () => {
  const f = await fixture();
  const child = spawn('/bin/bash', [SCRIPT, ROOT, ROOT, path.join(ROOT, 'aru-hook')], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      ARU_DESIRE_ISOLATED_TEST_MODE: 'true',
      ARU_DESIRE_ISOLATED_TMP_PARENT: f.temporaryParent,
      ARU_DESIRE_ISOLATED_PAUSE_AFTER_HEALTH_SECONDS: '5',
    },
  });
  const deadline = Date.now() + 8_000;
  let ready = false;
  while (Date.now() < deadline) {
    const entries = await readdir(f.temporaryParent);
    if (entries.length === 1) {
      try {
        await stat(path.join(f.temporaryParent, entries[0], 'test-health-ready'));
        ready = true;
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, 'isolated acceptance never reached its interruptible health stage');
  child.kill('SIGTERM');
  const result = await new Promise((resolve) => child.once('exit', (code, signal) => {
    resolve({ code, signal });
  }));
  assert.deepEqual(result, { code: 143, signal: null });
  assert.deepEqual(await readdir(f.temporaryParent), []);
  await assertProductionUnchanged(f);
});

test('isolated acceptance has no production state or fixed receiver endpoint', async () => {
  const source = await readFile(SCRIPT, 'utf8');
  const installer = await readFile(
    path.join(ROOT, 'scripts/install-complete-message-hook-once.sh'), 'utf8',
  );
  assert.doesNotMatch(source, /\/var\/lib\/aru-desire-heartbeat/u);
  assert.doesNotMatch(source, /\/opt\/aru-desire-heartbeat/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:18761/u);
  assert.match(source, /mktemp -d "\$TEST_PARENT\/aru-v0910-isolated\.XXXXXXXX"/u);
  assert.match(source, /ARU_DESIRE_CONFIG="\$TEST_CONFIG"/u);
  assert.match(source, /ARU_DESIRE_DATA_DIR="\$TEST_DATA"/u);
  assert.match(source, /ARU_DESIRE_TURN_HOOK_ENDPOINT="http:\/\/127\.0\.0\.1:\$PORT/u);
  assert.match(source, /chmod 0755 "\$TEST_ROOT"/u);
  assert.match(source, /run_desire node "\$RUNTIME_ROOT\/bin\/desire-heartbeat\.mjs" init/u);
  assert.doesNotMatch(source, /run_desire node "\$SOURCE_ROOT/u);
  assert.match(source, /trap 'cleanup 130' INT/u);
  assert.match(source, /trap 'cleanup 143' TERM/u);
  assert.doesNotMatch(installer, /(?:interaction-)?state\.json/u);
  assert.doesNotMatch(installer, /verify-synthetic-ledger\.mjs/u);
  assert.deepEqual(
    installer.split('\n').filter((line) => line.includes('DESIRE_DATA')),
    [
      'readonly DESIRE_DATA=/var/lib/aru-desire-heartbeat',
      'readonly DESIRE_SECRET=${DESIRE_DATA}/turn-hook.secret',
    ],
  );
});
