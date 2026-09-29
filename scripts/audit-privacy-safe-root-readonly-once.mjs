#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  renderPrivacySafeReport, runPrivacySafeAudit, STATUS,
} from './privacy-safe-root-audit-core.mjs';

const EXPECTED_BACKUP = '/var/backups/aru-desire-turn-hook/20260928T223043Z';
const EXPECTED_INSTALLED_AT = '2026-09-28T22:30:43Z';
const HEARTBEAT_ROOT = '/opt/aru-desire-heartbeat';
const DATA_ROOT = '/var/lib/aru-desire-heartbeat';

function blockedReport(kind) {
  return {
    protectedFiles: STATUS.INCONCLUSIVE,
    backup: STATUS.INCONCLUSIVE,
    featureGates: STATUS.INCONCLUSIVE,
    synthetic: STATUS.INCONCLUSIVE,
    duplicateLedgers: STATUS.INCONCLUSIVE,
    nonExpectedStateChange: STATUS.INCONCLUSIVE,
    journal: STATUS.INCONCLUSIVE,
    sideEffects: STATUS.INCONCLUSIVE,
    syntheticCount: 0,
    duplicateCount: 0,
    journalCounts: {
      module_not_found: 0, syntax_error: 0, permission_error: 0,
      request_rejected: 0, restart_loop: 0, delivery_failure: 0, process_failure: 0,
    },
    auditErrorCounts: {
      permission_error: kind === 'permission' ? 1 : 0,
      structure_error: kind === 'structure' ? 1 : 0,
      journal_access_error: 0,
    },
  };
}

async function accounts() {
  const [passwd, group] = await Promise.all([
    readFile('/etc/passwd', 'utf8'), readFile('/etc/group', 'utf8'),
  ]);
  const users = new Map(passwd.split(/\n/u).filter(Boolean).map((line) => {
    const fields = line.split(':');
    return [fields[0], { uid: Number(fields[2]), primaryGid: Number(fields[3]) }];
  }));
  const groups = new Map(group.split(/\n/u).filter(Boolean).map((line) => {
    const fields = line.split(':');
    return [fields[0], Number(fields[2])];
  }));
  const desire = users.get('aru-desire');
  const aru = users.get('aru-selfhost');
  if (!desire || !aru || !groups.has('aru-desire') || !groups.has('aru-selfhost')) {
    throw new Error('service accounts unavailable');
  }
  return {
    root: { uid: 0, gid: 0 },
    desire: { uid: desire.uid, gid: groups.get('aru-desire') },
    aru: { uid: aru.uid, gid: groups.get('aru-selfhost') },
  };
}

function readJournal(unit, installedAt) {
  const result = spawnSync('/usr/bin/journalctl', [
    '-u', unit, '--since', installedAt, '--no-pager', '--quiet', '-o', 'json',
  ], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error || result.status !== 0 || result.signal !== null || result.stderr.trim() !== '') {
    throw new Error('journal access failed');
  }
  return result.stdout.split(/\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

if (process.getuid?.() !== 0) {
  process.stdout.write(renderPrivacySafeReport(blockedReport('permission')));
  process.exitCode = 2;
} else if (process.argv.length !== 2) {
  process.stdout.write(renderPrivacySafeReport(blockedReport('structure')));
  process.exitCode = 2;
} else {
  try {
    const serviceAccounts = await accounts();
    const [schemaModule, interactionModule] = await Promise.all([
      import(pathToFileURL(path.join(HEARTBEAT_ROOT, 'src', 'schema.mjs'))),
      import(pathToFileURL(path.join(HEARTBEAT_ROOT, 'src', 'interaction-runtime.mjs'))),
    ]);
    const options = {
      expectedBackupRoot: EXPECTED_BACKUP,
      expectedInstalledAt: EXPECTED_INSTALLED_AT,
      heartbeatRoot: HEARTBEAT_ROOT,
      dataRoot: DATA_ROOT,
      aruDataRoot: '/var/lib/aru-selfhost',
      deploymentMetadataPath: path.join(HEARTBEAT_ROOT, 'deployment-metadata.json'),
      releaseManifestPath: path.join(HEARTBEAT_ROOT, 'release-manifest.json'),
      configPath: path.join(HEARTBEAT_ROOT, 'config', 'default.json'),
      statePath: path.join(DATA_ROOT, 'state.json'),
      interactionStatePath: path.join(DATA_ROOT, 'interaction-state.json'),
      aruSecretPath: '/var/lib/aru-selfhost/desire-turn-hook.secret',
      desireSecretPath: path.join(DATA_ROOT, 'turn-hook.secret'),
      accounts: serviceAccounts,
      journalUnits: [
        'aru-selfhost.service',
        'aru-desire-turn-receiver.service',
        'aru-desire-dashboard.service',
        'aru-desire-heartbeat.service',
        'aru-desire-heartbeat.timer',
      ],
      readJournal,
      validateStateObjects(config, state, interaction) {
        schemaModule.validateConfig(config);
        schemaModule.validateState(state, config);
        interactionModule.validateInteractionState(interaction, config);
      },
    };
    options.protectedSnapshotPaths = [
      options.deploymentMetadataPath,
      options.releaseManifestPath,
      options.configPath,
      options.statePath,
      options.interactionStatePath,
      options.aruSecretPath,
      options.desireSecretPath,
    ];
    const report = await runPrivacySafeAudit(options);
    process.stdout.write(renderPrivacySafeReport(report));
    if (renderPrivacySafeReport(report).startsWith('PRIVACY_SAFE_ROOT_AUDIT=FAIL')) {
      process.exitCode = 1;
    } else if (renderPrivacySafeReport(report).startsWith('PRIVACY_SAFE_ROOT_AUDIT=INCONCLUSIVE')) {
      process.exitCode = 2;
    }
  } catch {
    process.stdout.write(renderPrivacySafeReport(blockedReport('structure')));
    process.exitCode = 2;
  }
}
