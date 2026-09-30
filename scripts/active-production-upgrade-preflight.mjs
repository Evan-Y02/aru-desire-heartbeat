#!/usr/bin/env node
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeliveryConfig } from '../delivery/aru-adapter.mjs';
import { validateInteractionState } from '../src/interaction-runtime.mjs';
import { validateConfig, validateState } from '../src/schema.mjs';
import { verifyFormalReleaseLayout } from './formal-release-layout.mjs';
import { createRuntimeManifest } from './runtime-release-manifest.mjs';

const EXPECTED_TARGET = '0.9.17';
const SUPPORTED_OLD = new Set(['0.9.14', '0.9.15', '0.9.16']);
const ENABLE_MAGIC = 'aru-desire-heartbeat-external-trigger-v1\n';

export function normalizeSystemdUnitBytes(value) {
  const lines = Buffer.from(value).toString('latin1').replaceAll('\r\n', '\n').split('\n');
  while (lines.length > 0 && /^[\t ]*$/u.test(lines.at(-1))) lines.pop();
  return Buffer.from(`${lines.join('\n')}\n`, 'latin1');
}

export function systemdUnitBytesEquivalent(left, right) {
  return normalizeSystemdUnitBytes(left).equals(normalizeSystemdUnitBytes(right));
}

class PreflightFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function checked(code, operation) {
  try {
    return await operation();
  } catch {
    throw new PreflightFailure(code);
  }
}

function requireCheck(condition, code) {
  if (!condition) throw new PreflightFailure(code);
}

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
  const sourcePackage = await checked('source_package_file', async () => json((await regular(
    path.join(options.sourceRoot, 'package.json'), 'source package', { uid: sourceOwner, mode: publicMode },
  )).bytes, 'source package'));
  const installedPackage = await checked('installed_package_file', async () => json((await regular(
    path.join(options.heartbeatRoot, 'package.json'), 'installed package', { uid: owner },
  )).bytes, 'installed package'));
  requireCheck(sourcePackage.version === EXPECTED_TARGET &&
    options.targetVersion === EXPECTED_TARGET, 'target_version');
  requireCheck(SUPPORTED_OLD.has(installedPackage.version), 'installed_version');
  requireCheck(installedPackage.version !== sourcePackage.version, 'already_installed');

  const sourceManifest = await checked(
    'source_manifest', () => createRuntimeManifest(options.sourceRoot),
  );
  requireCheck(sourceManifest.version === EXPECTED_TARGET, 'source_manifest');
  const layout = await checked('formal_layout', () => verifyFormalReleaseLayout({
    currentLink: options.currentLink,
    heartbeatRoot: options.heartbeatRoot,
    metadataPath: path.join(options.heartbeatRoot, 'deployment-metadata.json'),
    releasePrefix: options.releasePrefix,
    backupPrefix: options.installBackupPrefix,
    expectedUid: owner,
  }));
  requireCheck(layout.version === installedPackage.version, 'formal_layout');

  const configFile = await checked('heartbeat_config_file', () => regular(
    path.join(options.heartbeatRoot, 'config/default.json'), 'heartbeat config',
    { uid: owner, mode: publicMode },
  ));
  const deliveryFile = await checked('delivery_config_file', () => regular(
    path.join(options.heartbeatRoot, 'config/aru-delivery.json'), 'delivery config',
    { uid: owner, mode: publicMode },
  ));
  const stateFile = await checked('runtime_primary_file', () => regular(
    path.join(options.dataRoot, 'state.json'), 'state',
    { uid: serviceOwner, gid: serviceGroup, mode: privateMode },
  ));
  const interactionFile = await checked('runtime_interaction_file', () => regular(
    path.join(options.dataRoot, 'interaction-state.json'), 'interaction state',
    { uid: serviceOwner, gid: serviceGroup, mode: privateMode },
  ));
  const config = await checked(
    'heartbeat_config_schema', async () => validateConfig(json(configFile.bytes, 'heartbeat config')),
  );
  const delivery = await checked(
    'delivery_config_schema', async () => validateDeliveryConfig(json(deliveryFile.bytes, 'delivery config')),
  );
  const state = await checked(
    'runtime_primary_schema', async () => validateState(json(stateFile.bytes, 'state'), config),
  );
  await checked('runtime_interaction_schema', async () =>
    validateInteractionState(json(interactionFile.bytes, 'interaction state'), config));
  requireCheck(state.pendingDecision === null, 'runtime_not_idle');
  requireCheck(config.observeOnly === false && config.deliveryEnabled === true &&
    delivery.enabled === true, 'production_gates');
  requireCheck(delivery.credentialPath === options.credentialPath &&
    delivery.enableFile === options.enableFile, 'delivery_binding');
  await checked('delivery_auth_file', () => regular(options.credentialPath, 'delivery credential', {
    uid: serviceOwner, gid: serviceGroup, mode: privateMode,
  }));
  const marker = await checked('delivery_marker_file', () => regular(options.enableFile, 'delivery enable marker', {
    uid: owner, gid: serviceGroup, mode: markerMode,
  }));
  requireCheck(marker.bytes.toString('utf8') === ENABLE_MAGIC, 'delivery_marker_content');
  const current = await checked('release_identity', () => realpath(options.currentLink));
  requireCheck(current === layout.current, 'release_identity');
  return { oldVersion: installedPackage.version, targetVersion: EXPECTED_TARGET };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv[2] === '--compare-systemd-unit') {
    if (process.argv.length !== 5) process.exitCode = 1;
    else {
      try {
        const [left, right] = await Promise.all([
          readFile(process.argv[3]), readFile(process.argv[4]),
        ]);
        process.exitCode = systemdUnitBytesEquivalent(left, right) ? 0 : 1;
      } catch {
        process.exitCode = 1;
      }
    }
  } else {
    const configPath = process.argv[2];
    if (!configPath || process.argv.length !== 3) throw new Error('usage: preflight CONFIG_JSON');
    const options = json(await readFile(configPath), 'preflight options');
    try {
      const result = await activeUpgradePreflight(options);
      process.stdout.write(
        `ACTIVE_UPGRADE_PREFLIGHT=PASS\nold_version=${result.oldVersion}\n` +
        `target_version=${result.targetVersion}\n`,
      );
    } catch (error) {
      const code = error instanceof PreflightFailure ? error.code : 'internal_preflight_failed';
      process.stdout.write(`ACTIVE_UPGRADE_PREFLIGHT=FAIL\nfailure_class=${code}\n`);
      process.exitCode = 1;
    }
  }
}
