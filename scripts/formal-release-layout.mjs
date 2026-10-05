#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest } from './runtime-release-manifest.mjs';

export const DEPLOYMENT_METADATA_SCHEMA = 'aru.desire-heartbeat.deployment.v1';

async function safeRegularFile(file, label, expectedUid = null) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} is missing or unsafe`);
  }
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} is group/world writable`);
  if (expectedUid !== null && info.uid !== expectedUid) {
    throw new Error(`${label} has an unexpected owner`);
  }
  return { info, bytes: await readFile(file) };
}

function safeAbsolute(value, prefix, label) {
  if (typeof value !== 'string' || !value.startsWith(prefix) ||
      path.normalize(value) !== value || value.includes('\n')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function createDeploymentMetadata({
  expectedCurrent, previousRelease, backupRoot, installedAt,
}, {
  releasePrefix = '/opt/aru-selfhost/releases/',
  backupPrefix = '/var/backups/aru-desire-turn-hook/',
} = {}) {
  safeAbsolute(expectedCurrent, releasePrefix, 'expected current');
  safeAbsolute(previousRelease, releasePrefix, 'previous release');
  safeAbsolute(backupRoot, backupPrefix, 'backup root');
  if (typeof installedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(installedAt) ||
      !Number.isFinite(Date.parse(installedAt))) {
    throw new Error('installedAt is invalid');
  }
  return {
    schema: DEPLOYMENT_METADATA_SCHEMA,
    expectedCurrent,
    previousRelease,
    backupRoot,
    installedAt,
  };
}

export async function readDeploymentMetadata(metadataPath, {
  releasePrefix = '/opt/aru-selfhost/releases/',
  backupPrefix = '/var/backups/aru-desire-turn-hook/',
  expectedUid = null,
} = {}) {
  const { info, bytes } = await safeRegularFile(
    metadataPath, 'deployment metadata', expectedUid,
  );
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('deployment metadata is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'backupRoot,expectedCurrent,installedAt,previousRelease,schema' ||
      parsed.schema !== DEPLOYMENT_METADATA_SCHEMA) {
    throw new Error('deployment metadata shape is invalid');
  }
  safeAbsolute(parsed.expectedCurrent, releasePrefix, 'expected current');
  safeAbsolute(parsed.previousRelease, releasePrefix, 'previous release');
  safeAbsolute(parsed.backupRoot, backupPrefix, 'backup root');
  if (typeof parsed.installedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(parsed.installedAt) ||
      !Number.isFinite(Date.parse(parsed.installedAt))) {
    throw new Error('deployment metadata installedAt is invalid');
  }
  return { metadata: parsed, info, bytes };
}

export async function verifyFormalReleaseLayout({
  currentLink,
  heartbeatRoot,
  metadataPath,
  heartbeatManifest = path.join(heartbeatRoot, 'release-manifest.json'),
  releaseManifestName = 'release-manifest.json',
  releasePrefix = '/opt/aru-selfhost/releases/',
  backupPrefix = '/var/backups/aru-desire-turn-hook/',
  expectedUid = null,
  expectedRuntimeFiles = null,
}) {
  const canonicalHeartbeatManifest = path.join(
    path.resolve(heartbeatRoot), 'release-manifest.json',
  );
  if (path.resolve(heartbeatManifest) !== canonicalHeartbeatManifest) {
    throw new Error('heartbeat runtime manifest path is not canonical');
  }
  if (releaseManifestName !== 'release-manifest.json') {
    throw new Error('release runtime manifest name is not canonical');
  }
  const { metadata } = await readDeploymentMetadata(metadataPath, {
    releasePrefix,
    backupPrefix,
    expectedUid,
  });
  const current = await realpath(currentLink);
  const expected = await realpath(metadata.expectedCurrent);
  if (current !== expected) throw new Error('current does not match deployment metadata');

  const releaseManifest = path.join(current, releaseManifestName);
  const [heartbeatFile, releaseFile] = await Promise.all([
    safeRegularFile(heartbeatManifest, 'heartbeat runtime manifest', expectedUid),
    safeRegularFile(releaseManifest, 'release runtime manifest', expectedUid),
  ]);
  if (!heartbeatFile.bytes.equals(releaseFile.bytes)) {
    throw new Error('release and heartbeat manifests differ');
  }
  const verificationOptions = { expectedFiles: expectedRuntimeFiles };
  const [heartbeatVerified, releaseVerified] = await Promise.all([
    verifyRuntimeManifest(heartbeatRoot, heartbeatManifest, verificationOptions),
    verifyRuntimeManifest(heartbeatRoot, releaseManifest, verificationOptions),
  ]);
  if (heartbeatVerified.digest !== releaseVerified.digest) {
    throw new Error('verified manifest digests differ');
  }
  return {
    metadata,
    current,
    heartbeatManifest: canonicalHeartbeatManifest,
    releaseManifest,
    schema: heartbeatVerified.schema,
    version: heartbeatVerified.version,
    fileCount: heartbeatVerified.fileCount,
    digest: heartbeatVerified.digest,
  };
}

export function verifiedManifestPathRecord(formalLayout) {
  if (formalLayout === null || typeof formalLayout !== 'object' ||
      !path.isAbsolute(formalLayout.releaseManifest) ||
      !path.isAbsolute(formalLayout.heartbeatManifest)) {
    throw new Error('verified manifest paths are unavailable');
  }
  return {
    currentRelease: formalLayout.releaseManifest,
    independentRuntime: formalLayout.heartbeatManifest,
  };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create' && args.length === 4) {
    const [expectedCurrent, previousRelease, backupRoot, installedAt] = args;
    process.stdout.write(`${JSON.stringify(createDeploymentMetadata({
      expectedCurrent, previousRelease, backupRoot, installedAt,
    }), null, 2)}\n`);
  } else if (command === 'metadata' && args.length === 1) {
    const { metadata } = await readDeploymentMetadata(args[0], {
      expectedUid: process.getuid?.() === 0 ? 0 : null,
    });
    process.stdout.write(`${JSON.stringify({
      schema: metadata.schema,
      expectedCurrent: metadata.expectedCurrent,
      installedAt: metadata.installedAt,
    })}\n`);
  } else if (command === 'verify' && args.length === 3) {
    const [currentLink, heartbeatRoot, metadataPath] = args;
    const result = await verifyFormalReleaseLayout({
      currentLink,
      heartbeatRoot,
      metadataPath,
      expectedUid: process.getuid?.() === 0 ? 0 : null,
    });
    process.stdout.write(`${JSON.stringify({
      current: result.current,
      schema: result.schema,
      version: result.version,
      fileCount: result.fileCount,
      digest: result.digest,
    })}\n`);
  } else {
    throw new Error(
      'usage: formal-release-layout.mjs create EXPECTED PREVIOUS BACKUP INSTALLED_AT | ' +
      'metadata METADATA | ' +
      'verify CURRENT_LINK HEARTBEAT_ROOT METADATA',
    );
  }
}
