import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeploymentMetadata, verifiedManifestPathRecord, verifyFormalReleaseLayout,
} from '../scripts/formal-release-layout.mjs';
import {
  createRuntimeManifest,
} from '../scripts/runtime-release-manifest.mjs';
import { runtimeReleaseFiles } from '../scripts/verify-runtime-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  await readFile(path.join(ROOT, 'package.json'), 'utf8'),
).version;
assert.equal(PACKAGE_VERSION, '0.9.11');
const directories = [];
test.after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'formal-release-layout-'));
  directories.push(root);
  const releases = path.join(root, 'releases');
  const backups = path.join(root, 'backups');
  const oldRelease = path.join(releases, 'old');
  const newRelease = path.join(releases, 'new');
  const heartbeatRoot = path.join(root, 'heartbeat');
  const backupRoot = path.join(backups, 'attempt');
  const currentLink = path.join(root, 'current');
  const metadataPath = path.join(heartbeatRoot, 'deployment-metadata.json');
  await Promise.all([
    mkdir(oldRelease, { recursive: true }),
    mkdir(newRelease, { recursive: true }),
    mkdir(heartbeatRoot, { recursive: true }),
    mkdir(backupRoot, { recursive: true }),
  ]);
  const files = await runtimeReleaseFiles(ROOT);
  for (const relative of files) {
    const destination = path.join(heartbeatRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, relative), destination);
  }
  const manifest = await createRuntimeManifest(heartbeatRoot);
  assert.equal(manifest.fileCount, 31);
  assert.equal(manifest.version, PACKAGE_VERSION);
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const heartbeatManifest = path.join(heartbeatRoot, 'release-manifest.json');
  await Promise.all([
    writeFile(heartbeatManifest, manifestBytes, { mode: 0o644 }),
    writeFile(path.join(oldRelease, 'release-manifest.json'), manifestBytes, { mode: 0o644 }),
    writeFile(path.join(newRelease, 'release-manifest.json'), manifestBytes, { mode: 0o644 }),
  ]);
  await symlink(oldRelease, currentLink);
  const options = {
    releasePrefix: `${releases}/`,
    backupPrefix: `${backups}/`,
  };
  const metadata = (expectedCurrent, previousRelease) => createDeploymentMetadata({
    expectedCurrent,
    previousRelease,
    backupRoot,
    installedAt: '2026-09-27T00:00:00Z',
  }, options);
  await writeFile(metadataPath, `${JSON.stringify(metadata(oldRelease, oldRelease))}\n`, {
    mode: 0o644,
  });
  const verify = () => verifyFormalReleaseLayout({
    currentLink,
    heartbeatRoot,
    metadataPath,
    ...options,
  });
  return {
    oldRelease, newRelease, currentLink, heartbeatRoot, metadataPath,
    heartbeatManifest, manifestBytes, metadata, options, verify,
  };
}

async function switchCurrent(currentLink, target) {
  await symlink(target, `${currentLink}.next`);
  await rename(`${currentLink}.next`, currentLink);
}

async function replaceMetadata(metadataPath, value) {
  const next = `${metadataPath}.next`;
  await writeFile(next, `${JSON.stringify(value)}\n`, { mode: 0o644 });
  await rename(next, metadataPath);
}

test('formal layout success binds current, expected metadata, and both 31-file manifests', async () => {
  const f = await fixture();
  await switchCurrent(f.currentLink, f.newRelease);
  await replaceMetadata(f.metadataPath, f.metadata(f.newRelease, f.oldRelease));
  const result = await f.verify();
  assert.equal(result.current, f.newRelease);
  assert.equal(result.metadata.expectedCurrent, f.newRelease);
  assert.equal(result.fileCount, 31);
  assert.equal(result.version, PACKAGE_VERSION);
  assert.equal(result.releaseManifest, path.join(f.newRelease, 'release-manifest.json'));
  assert.equal(result.heartbeatManifest, f.heartbeatManifest);
  assert.deepEqual(verifiedManifestPathRecord(result), {
    currentRelease: path.join(f.newRelease, 'release-manifest.json'),
    independentRuntime: f.heartbeatManifest,
  });
  assert.deepEqual(
    await readFile(path.join(f.newRelease, 'release-manifest.json')),
    await readFile(path.join(f.heartbeatRoot, 'release-manifest.json')),
  );
});

test('verified paths follow current and current.expected across activation and rollback', async () => {
  const f = await fixture();
  const old = await f.verify();
  assert.equal(old.current, f.oldRelease);
  assert.equal(old.releaseManifest, path.join(f.oldRelease, 'release-manifest.json'));

  await switchCurrent(f.currentLink, f.newRelease);
  await replaceMetadata(f.metadataPath, f.metadata(f.newRelease, f.oldRelease));
  const activated = await f.verify();
  assert.equal(activated.current, f.newRelease);
  assert.equal(activated.metadata.expectedCurrent, f.newRelease);
  assert.equal(
    verifiedManifestPathRecord(activated).currentRelease,
    path.join(f.newRelease, 'release-manifest.json'),
  );

  await switchCurrent(f.currentLink, f.oldRelease);
  await replaceMetadata(f.metadataPath, f.metadata(f.oldRelease, f.newRelease));
  const rolledBack = await f.verify();
  assert.equal(rolledBack.current, f.oldRelease);
  assert.equal(rolledBack.metadata.expectedCurrent, f.oldRelease);
  assert.equal(
    verifiedManifestPathRecord(rolledBack).currentRelease,
    path.join(f.oldRelease, 'release-manifest.json'),
  );
});

test('formal layout rejects noncanonical independent and release manifest paths', async () => {
  const f = await fixture();
  const decoy = path.join(f.heartbeatRoot, 'decoy-manifest.json');
  await writeFile(decoy, f.manifestBytes, { mode: 0o644 });
  await assert.rejects(() => verifyFormalReleaseLayout({
    currentLink: f.currentLink,
    heartbeatRoot: f.heartbeatRoot,
    metadataPath: f.metadataPath,
    heartbeatManifest: decoy,
    ...f.options,
  }), /heartbeat runtime manifest path is not canonical/u);
  await assert.rejects(() => verifyFormalReleaseLayout({
    currentLink: f.currentLink,
    heartbeatRoot: f.heartbeatRoot,
    metadataPath: f.metadataPath,
    releaseManifestName: 'old-release-manifest.json',
    ...f.options,
  }), /release runtime manifest name is not canonical/u);
});

test('formal layout rejects either missing manifest and mixed manifest copies', async () => {
  const missingIndependent = await fixture();
  await unlink(missingIndependent.heartbeatManifest);
  await assert.rejects(
    missingIndependent.verify,
    /heartbeat runtime manifest is missing or unsafe/u,
  );

  const missingRelease = await fixture();
  await unlink(path.join(missingRelease.oldRelease, 'release-manifest.json'));
  await assert.rejects(
    missingRelease.verify,
    /release runtime manifest is missing or unsafe/u,
  );

  const mixed = await fixture();
  await writeFile(
    path.join(mixed.oldRelease, 'release-manifest.json'),
    `${mixed.manifestBytes}\n`,
    { mode: 0o644 },
  );
  await assert.rejects(mixed.verify, /release and heartbeat manifests differ/u);
});

test('formal layout rejects a missing manifest and an expected-current mismatch', async () => {
  const f = await fixture();
  await switchCurrent(f.currentLink, f.newRelease);
  await assert.rejects(f.verify, /current does not match deployment metadata/u);
  await replaceMetadata(f.metadataPath, f.metadata(f.newRelease, f.oldRelease));
  await unlink(path.join(f.newRelease, 'release-manifest.json'));
  await assert.rejects(f.verify, /release runtime manifest is missing or unsafe/u);
});

test('formal layout rejects unsafe manifest and metadata permissions', async () => {
  const f = await fixture();
  await chmod(f.metadataPath, 0o666);
  await assert.rejects(f.verify, /deployment metadata is group\/world writable/u);
  await chmod(f.metadataPath, 0o644);
  await chmod(path.join(f.oldRelease, 'release-manifest.json'), 0o666);
  await assert.rejects(f.verify, /release runtime manifest is group\/world writable/u);
});

test('interrupted switch and manifest failure roll back current, expected metadata, and manifest', async () => {
  const f = await fixture();
  const oldMetadata = await readFile(f.metadataPath);
  const oldManifest = await readFile(path.join(f.heartbeatRoot, 'release-manifest.json'));
  await switchCurrent(f.currentLink, f.newRelease);
  await assert.rejects(f.verify, /current does not match deployment metadata/u);

  await switchCurrent(f.currentLink, f.oldRelease);
  await writeFile(f.metadataPath, oldMetadata);
  assert.equal((await f.verify()).current, f.oldRelease);

  let rolledBack = false;
  let installFailure = null;
  try {
    await switchCurrent(f.currentLink, f.newRelease);
    await replaceMetadata(f.metadataPath, f.metadata(f.newRelease, f.oldRelease));
    await chmod(path.join(f.newRelease, 'release-manifest.json'), 0o644);
    await unlink(path.join(f.newRelease, 'release-manifest.json'));
    await f.verify();
  } catch (error) {
    installFailure = error;
  } finally {
    await switchCurrent(f.currentLink, f.oldRelease);
    await writeFile(f.metadataPath, oldMetadata);
    await writeFile(path.join(f.heartbeatRoot, 'release-manifest.json'), oldManifest);
    rolledBack = true;
  }
  assert.match(installFailure?.message ?? '', /release runtime manifest is missing or unsafe/u);
  assert.equal(rolledBack, true);
  const restored = await f.verify();
  assert.equal(restored.current, f.oldRelease);
  assert.equal(restored.metadata.expectedCurrent, f.oldRelease);
});

test('production audit derives its boundary and expected release from installed metadata', async () => {
  const source = await readFile(
    path.join(ROOT, 'scripts/audit-production-readonly-once.mjs'), 'utf8',
  );
  assert.match(source, /readDeploymentMetadata\(DEPLOYMENT_METADATA_PATH,/u);
  assert.match(source, /const START_ISO = DEPLOYMENT\.installedAt/u);
  assert.match(source, /const EXPECTED_CURRENT = DEPLOYMENT\.expectedCurrent/u);
  assert.match(source, /const ROLLBACK_ROOT = DEPLOYMENT\.backupRoot/u);
  assert.match(source, /verifyFormalReleaseLayout/u);
  assert.match(source, /verifiedManifestPathRecord\(formalLayout\)/u);
  assert.match(source, /currentReleasePath: manifestPaths\.currentRelease/u);
  assert.match(source, /independentRuntimePath: manifestPaths\.independentRuntime/u);
  assert.doesNotMatch(source, /release\/release-manifest\.json/u);
  assert.doesNotMatch(source, /20260926T135105Z/u);
});
