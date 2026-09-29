#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseSenderBundle } from '../delivery/aru-wake-sender.mjs';
import { validateDeliveryConfig } from '../delivery/aru-adapter.mjs';
import { validateState } from '../src/schema.mjs';

const execFileAsync = promisify(execFile);
const MAX_JSON_BYTES = 1024 * 1024;

function initialReport() {
  return {
    result: 'PASS', pending: 'INCONCLUSIVE', structure: 'INCONCLUSIVE',
    version: 'INCONCLUSIVE', units: 'INCONCLUSIVE', config: 'INCONCLUSIVE',
    credential: 'INCONCLUSIVE', systemd: 'INCONCLUSIVE',
    timerQuiesceRequired: 0, structureErrors: 0, versionErrors: 0,
    unitErrors: 0, configErrors: 0, credentialErrors: 0,
    identityErrors: 0, systemdErrors: 0, pendingErrors: 0,
  };
}

function fail(report, field, counter) {
  report.result = 'FAIL';
  report[field] = 'FAIL';
  report[counter] = 1;
}

async function safeFile(file, { uid, gid, mode, maximum = MAX_JSON_BYTES }) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.uid !== uid || (gid !== null && info.gid !== gid) ||
      (info.mode & 0o777) !== mode || info.size < 1 || info.size > maximum) {
    throw new Error('unsafe file');
  }
  return readFile(file);
}

function parseJson(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid object');
  }
  return value;
}

function normalizedUnit(bytes) {
  return bytes.toString('utf8').replace(/[ \t]+$/gmu, '').replace(/\s+$/u, '') + '\n';
}

function sameCredential(left, right) {
  const canonical = (value) => createHash('sha256')
    .update(JSON.stringify(parseSenderBundle(value.toString('utf8').trim())))
    .digest();
  return timingSafeEqual(canonical(left), canonical(right));
}

async function systemctlState(systemctl, operation, unit) {
  try {
    const { stdout } = await execFileAsync(systemctl, [operation, unit], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    });
    return stdout.trim();
  } catch (error) {
    const value = String(error?.stdout ?? '').trim();
    if (value) return value;
    throw error;
  }
}

export async function runAutonomyActivationPreflight(options) {
  const report = initialReport();
  let heartbeat;
  let delivery;
  let state;
  try {
    const [heartbeatBytes, deliveryBytes, stateBytes] = await Promise.all([
      safeFile(options.heartbeat, { uid: options.rootUid, gid: options.rootGid, mode: 0o644 }),
      safeFile(options.delivery, { uid: options.rootUid, gid: options.rootGid, mode: 0o644 }),
      safeFile(options.state, {
        uid: options.serviceUid, gid: options.serviceGid, mode: 0o600,
      }),
    ]);
    heartbeat = parseJson(heartbeatBytes);
    delivery = parseJson(deliveryBytes);
    state = parseJson(stateBytes);
    report.structure = 'PASS';
  } catch {
    fail(report, 'structure', 'structureErrors');
    return report;
  }

  if (Object.hasOwn(state, 'pendingDecision') && state.pendingDecision !== null) {
    fail(report, 'pending', 'pendingErrors');
    return report;
  }

  try {
    validateDeliveryConfig(delivery);
    validateState(state, heartbeat);
    if (heartbeat.observeOnly !== true || heartbeat.deliveryEnabled !== false ||
        delivery.enabled !== true || delivery.credentialPath !== options.credential ||
        delivery.enableFile !== options.enableFile) throw new Error('unsafe gates');
    report.config = 'PASS';
  } catch {
    fail(report, 'config', 'configErrors');
    return report;
  }

  report.pending = 'PASS';

  try {
    const [sourcePackage, targetPackage] = await Promise.all([
      safeFile(options.sourcePackage, {
        uid: options.sourceUid, gid: null, mode: options.sourceFileMode,
      }),
      safeFile(options.targetPackage, {
        uid: options.rootUid, gid: options.rootGid, mode: 0o644,
      }),
    ]);
    if (parseJson(sourcePackage).version !== parseJson(targetPackage).version) {
      throw new Error('version mismatch');
    }
    report.version = 'PASS';
  } catch {
    fail(report, 'version', 'versionErrors');
  }

  try {
    for (const unit of options.units) {
      const [source, installed] = await Promise.all([
        safeFile(unit.source, {
          uid: options.sourceUid, gid: null, mode: options.sourceFileMode,
        }),
        safeFile(unit.installed, {
          uid: options.rootUid, gid: options.rootGid, mode: 0o644,
        }),
      ]);
      if (normalizedUnit(source) !== normalizedUnit(installed)) {
        throw new Error('unit mismatch');
      }
    }
    report.units = 'PASS';
  } catch {
    fail(report, 'units', 'unitErrors');
  }

  try {
    const [service, timer, timerEnabled] = await Promise.all([
      systemctlState(options.systemctl, 'is-active', options.serviceUnit),
      systemctlState(options.systemctl, 'is-active', options.timerUnit),
      systemctlState(options.systemctl, 'is-enabled', options.timerUnit),
    ]);
    if (service !== 'inactive' || !['active', 'inactive'].includes(timer) ||
        !['enabled', 'disabled'].includes(timerEnabled)) {
      throw new Error('unsafe systemd state');
    }
    report.timerQuiesceRequired = timer === 'active' ? 1 : 0;
    report.systemd = 'PASS';
  } catch {
    fail(report, 'systemd', 'systemdErrors');
  }

  try {
    const enableInfo = await lstat(options.enableFile).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (enableInfo !== null) throw new Error('enable file present');
  } catch {
    fail(report, 'config', 'configErrors');
  }

  try {
    const [installed, source] = await Promise.all([
      safeFile(options.credential, {
        uid: options.serviceUid, gid: options.serviceGid, mode: 0o600,
        maximum: 16 * 1024,
      }),
      safeFile(options.sourceCredential, {
        uid: options.credentialSourceUid, gid: null, mode: 0o600,
        maximum: 16 * 1024,
      }),
    ]);
    if (!sameCredential(installed, source)) {
      report.result = 'FAIL';
      report.credential = 'FAIL';
      report.identityErrors = 1;
    } else {
      report.credential = 'PASS';
    }
  } catch {
    fail(report, 'credential', 'credentialErrors');
  }
  return report;
}

export function renderAutonomyActivationPreflight(report) {
  return [
    `AUTONOMY_ACTIVATION_PREFLIGHT=${report.result}`,
    `PENDING_DECISION=${report.pending}`,
    `ACTIVATION_STRUCTURE=${report.structure}`,
    `ACTIVATION_VERSION=${report.version}`,
    `ACTIVATION_UNITS=${report.units}`,
    `ACTIVATION_CONFIG=${report.config}`,
    `CREDENTIAL_IDENTITY=${report.credential}`,
    `SYSTEMD_STATE=${report.systemd}`,
    `TIMER_QUIESCE_REQUIRED=${report.timerQuiesceRequired}`,
    `PREFLIGHT_STRUCTURE_ERROR=${report.structureErrors}`,
    `PREFLIGHT_VERSION_ERROR=${report.versionErrors}`,
    `PREFLIGHT_UNIT_ERROR=${report.unitErrors}`,
    `PREFLIGHT_CONFIG_ERROR=${report.configErrors}`,
    `PREFLIGHT_CREDENTIAL_ERROR=${report.credentialErrors}`,
    `PREFLIGHT_IDENTITY_ERROR=${report.identityErrors}`,
    `PREFLIGHT_SYSTEMD_ERROR=${report.systemdErrors}`,
    `PREFLIGHT_PENDING_ERROR=${report.pendingErrors}`,
  ].join('\n') + '\n';
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let report = initialReport();
  try {
    if (process.geteuid() !== 0 || process.argv.length !== 6 ||
        process.argv[2] !== '--production') throw new Error('invalid invocation');
    const serviceUid = Number(process.argv[3]);
    const serviceGid = Number(process.argv[4]);
    const credentialSourceUid = Number(process.argv[5]);
    if (![serviceUid, serviceGid, credentialSourceUid].every(Number.isSafeInteger)) {
      throw new Error('invalid uid');
    }
    report = await runAutonomyActivationPreflight({
      heartbeat: '/opt/aru-desire-heartbeat/config/default.json',
      delivery: '/opt/aru-desire-heartbeat/config/aru-delivery.json',
      state: '/var/lib/aru-desire-heartbeat/state.json',
      credential: '/var/lib/aru-desire-heartbeat/external-trigger.send-credential',
      sourceCredential: '/home/xinchao/private/ChengXiao/secrets/desire-heartbeat/external-trigger.send-credential',
      enableFile: '/etc/aru-desire-heartbeat/external-trigger.enable',
      sourcePackage: path.join(sourceRoot, 'package.json'),
      targetPackage: '/opt/aru-desire-heartbeat/package.json',
      units: ['aru-desire-heartbeat.service', 'aru-desire-heartbeat.timer'].map((unit) => ({
        source: path.join(sourceRoot, 'systemd', unit),
        installed: path.join('/etc/systemd/system', unit),
      })),
      rootUid: 0, rootGid: 0, sourceUid: credentialSourceUid,
      credentialSourceUid, serviceUid, serviceGid,
      sourceFileMode: 0o644, systemctl: '/usr/bin/systemctl',
      serviceUnit: 'aru-desire-heartbeat.service',
      timerUnit: 'aru-desire-heartbeat.timer',
    });
  } catch {
    fail(report, 'structure', 'structureErrors');
  }
  process.stdout.write(renderAutonomyActivationPreflight(report));
  process.exitCode = report.result === 'PASS' ? 0 : 1;
}
