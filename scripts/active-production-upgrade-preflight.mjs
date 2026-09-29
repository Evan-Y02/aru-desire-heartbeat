#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeliveryConfig } from '../delivery/aru-adapter.mjs';
import { validateInteractionState } from '../src/interaction-runtime.mjs';
import { validateConfig, validateState } from '../src/schema.mjs';
import { verifyFormalReleaseLayout } from './formal-release-layout.mjs';
import { createRuntimeManifest } from './runtime-release-manifest.mjs';

const EXPECTED_TARGET = '0.9.16';
const SUPPORTED_OLD = new Set(['0.9.14', '0.9.15']);
const ENABLE_MAGIC = 'aru-desire-heartbeat-external-trigger-v1\n';

async function regular(file, label, { mode = null, uid = null, gid = null } = {}) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} is missing or unsafe`);
  }
  if (mode !== null && (info.mode & 0o777) !== mode) throw new Error(`${label} mode is unsafe`);
  if (uid !== null && info.uid !== uid) throw new Error(`${label} owner is unsafe`);
  if (gid !== null && info.gid !== gid) throw new Error(`${label} group is unsafe`);
  return { info, bytes: await readFile(file) };
}

function json(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

export async function activeUpgradePreflight(options) {
  const owner = options.enforceOwnership ? 0 : null;
  const sourceOwner = options.enforceOwnership ? options.sourceUid : null;
  const serviceOwner = options.enforceOwnership ? options.serviceUid : null;
  const serviceGroup = options.enforceOwnership ? options.serviceGid : null;
  const publicMode = options.enforceOwnership ? 0o644 : null;
  const privateMode = options.enforceOwnership ? 0o600 : null;
  const markerMode = options.enforceOwnership ? 0o640 : null;
  const sourcePackage = json((await regular(
    path.join(options.sourceRoot, 'package.json'), 'source package', { uid: sourceOwner, mode: publicMode },
  )).bytes, 'source package');
  const installedPackage = json((await regular(
    path.join(options.heartbeatRoot, 'package.json'), 'installed package', { uid: owner },
  )).bytes, 'installed package');
  if (sourcePackage.version !== EXPECTED_TARGET || options.targetVersion !== EXPECTED_TARGET) {
    throw new Error('target version is not the expected release');
  }
  if (!SUPPORTED_OLD.has(installedPackage.version)) throw new Error('installed version is unsupported');
  if (installedPackage.version === sourcePackage.version) throw new Error('target version is already installed');

  const sourceManifest = await createRuntimeManifest(options.sourceRoot);
  if (sourceManifest.version !== EXPECTED_TARGET) throw new Error('source manifest version mismatch');
  const layout = await verifyFormalReleaseLayout({
    currentLink: options.currentLink,
    heartbeatRoot: options.heartbeatRoot,
    metadataPath: path.join(options.heartbeatRoot, 'deployment-metadata.json'),
    releasePrefix: options.releasePrefix,
    backupPrefix: options.installBackupPrefix,
    expectedUid: owner,
  });
  if (layout.version !== installedPackage.version) throw new Error('installed manifest version mismatch');

  const [configFile, deliveryFile, stateFile, interactionFile] = await Promise.all([
    regular(path.join(options.heartbeatRoot, 'config/default.json'), 'heartbeat config', { uid: owner, mode: publicMode }),
    regular(path.join(options.heartbeatRoot, 'config/aru-delivery.json'), 'delivery config', { uid: owner, mode: publicMode }),
    regular(path.join(options.dataRoot, 'state.json'), 'state', { uid: serviceOwner, gid: serviceGroup, mode: privateMode }),
    regular(path.join(options.dataRoot, 'interaction-state.json'), 'interaction state', { uid: serviceOwner, gid: serviceGroup, mode: privateMode }),
  ]);
  const config = validateConfig(json(configFile.bytes, 'heartbeat config'));
  const delivery = validateDeliveryConfig(json(deliveryFile.bytes, 'delivery config'));
  const state = validateState(json(stateFile.bytes, 'state'), config);
  validateInteractionState(json(interactionFile.bytes, 'interaction state'), config);
  if (state.pendingDecision !== null) throw new Error('pending decision blocks active upgrade');
  if (config.observeOnly !== false || config.deliveryEnabled !== true || delivery.enabled !== true) {
    throw new Error('production is not fully enabled');
  }
  if (delivery.credentialPath !== options.credentialPath ||
      delivery.enableFile !== options.enableFile) {
    throw new Error('delivery path binding mismatch');
  }
  await regular(options.credentialPath, 'delivery credential', {
    uid: serviceOwner, gid: serviceGroup, mode: privateMode,
  });
  const marker = await regular(options.enableFile, 'delivery enable marker', {
    uid: owner, gid: serviceGroup, mode: markerMode,
  });
  if (marker.bytes.toString('utf8') !== ENABLE_MAGIC) throw new Error('delivery enable marker is invalid');
  const current = await realpath(options.currentLink);
  if (current !== layout.current) throw new Error('current release identity mismatch');
  return { oldVersion: installedPackage.version, targetVersion: EXPECTED_TARGET };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw new Error('usage: preflight CONFIG_JSON');
  const options = json(await readFile(configPath), 'preflight options');
  try {
    const result = await activeUpgradePreflight(options);
    process.stdout.write(
      `ACTIVE_UPGRADE_PREFLIGHT=PASS\nold_version=${result.oldVersion}\n` +
      `target_version=${result.targetVersion}\n`,
    );
  } catch {
    process.stdout.write('ACTIVE_UPGRADE_PREFLIGHT=FAIL\n');
    process.exitCode = 1;
  }
}
