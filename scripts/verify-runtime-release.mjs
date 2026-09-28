#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeliveryConfig } from '../delivery/aru-adapter.mjs';
import { localImportClosure } from './local-import-closure.mjs';

export const RUNTIME_ENTRIES = Object.freeze([
  'bin/desire-cycle.mjs',
  'bin/desire-turn-receiver.mjs',
  'bin/desire-interaction-init.mjs',
  'scripts/set-interaction-flags.mjs',
  'scripts/preserve-feature-flags.mjs',
  'scripts/runtime-release-manifest.mjs',
  'scripts/verify-runtime-release.mjs',
  'scripts/verify-synthetic-ledger.mjs',
]);

const RELEASE_FILES = Object.freeze([
  'package.json',
  'dashboard/server.py',
  'dashboard/public/app.js',
  'dashboard/public/index.html',
  'dashboard/public/styles.css',
]);
const CRITICAL_MODULES = Object.freeze([
  'src/engine.mjs',
  'src/runtime.mjs',
  'src/timeline.mjs',
  'src/pending-decision.mjs',
]);
const FEATURE_FLAGS = Object.freeze([
  'observeOnly',
  'deliveryEnabled',
  'chatStimulusEnabled',
  'arousalEnabled',
  'arousalDriveSettlementEnabled',
  'soloSessionsEnabled',
]);

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} is missing or unsafe`);
  }
  return readFile(file);
}

export async function runtimeReleaseFiles(root) {
  const closure = await localImportClosure(root, RUNTIME_ENTRIES);
  for (const required of CRITICAL_MODULES) {
    if (!closure.includes(required)) throw new Error(`critical runtime dependency absent: ${required}`);
  }
  return [...new Set([...closure, ...RELEASE_FILES])].sort();
}

function normalizedHeartbeatConfig(value) {
  const copy = structuredClone(value);
  for (const key of FEATURE_FLAGS) {
    if (typeof copy[key] !== 'boolean') throw new Error(`feature flag is invalid: ${key}`);
    copy[key] = '__PRESERVED_FEATURE_FLAG__';
  }
  return copy;
}

async function validateConfigCompatibility(sourceRoot, targetRoot) {
  const source = JSON.parse(await regularFile(
    path.join(sourceRoot, 'config/default.json'), 'source heartbeat config',
  ));
  const target = JSON.parse(await regularFile(
    path.join(targetRoot, 'config/default.json'), 'target heartbeat config',
  ));
  if (JSON.stringify(normalizedHeartbeatConfig(source)) !==
      JSON.stringify(normalizedHeartbeatConfig(target))) {
    throw new Error('target heartbeat config does not match the source release');
  }
  const delivery = JSON.parse(await regularFile(
    path.join(targetRoot, 'config/aru-delivery.json'), 'preserved delivery config',
  ));
  validateDeliveryConfig(delivery);
}

export async function verifyRuntimeRelease(sourceArgument, targetArgument) {
  const sourceRoot = path.resolve(sourceArgument);
  const targetRoot = path.resolve(targetArgument);
  const files = await runtimeReleaseFiles(sourceRoot);
  const combined = createHash('sha256');
  for (const relative of files) {
    const source = await regularFile(path.join(sourceRoot, relative), `source ${relative}`);
    const target = await regularFile(path.join(targetRoot, relative), `target ${relative}`);
    if (!source.equals(target)) throw new Error(`runtime release mismatch: ${relative}`);
    combined.update(relative, 'utf8');
    combined.update('\0');
    combined.update(createHash('sha256').update(source).digest());
  }
  await validateConfigCompatibility(sourceRoot, targetRoot);
  const packageJson = JSON.parse(await readFile(path.join(targetRoot, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(packageJson.version)) {
    throw new Error('runtime release version is invalid');
  }
  return {
    schema: 'aru.desire-heartbeat.runtime-release.v1',
    version: packageJson.version,
    fileCount: files.length,
    digest: combined.digest('hex'),
    files,
  };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, sourceRoot, targetRoot] = process.argv.slice(2);
  if (command === 'list' && sourceRoot && !targetRoot) {
    process.stdout.write(`${(await runtimeReleaseFiles(sourceRoot)).join('\n')}\n`);
  } else if (command === 'verify' && sourceRoot && targetRoot) {
    const result = await verifyRuntimeRelease(sourceRoot, targetRoot);
    process.stdout.write(`${JSON.stringify({
      schema: result.schema,
      version: result.version,
      fileCount: result.fileCount,
      digest: result.digest,
    })}\n`);
  } else {
    throw new Error('usage: verify-runtime-release.mjs list SOURCE | verify SOURCE TARGET');
  }
}
