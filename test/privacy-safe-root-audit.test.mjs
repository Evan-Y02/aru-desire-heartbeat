import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  auditStateObjects,
  classifyJournalRows,
  compareFeatureGates,
  renderPrivacySafeReport,
  runPrivacySafeAudit,
  STATUS,
} from '../scripts/privacy-safe-root-audit-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = [];
const installedAt = '2026-09-28T22:30:43Z';
const flags = {
  observeOnly: true,
  deliveryEnabled: false,
  chatStimulusEnabled: true,
  arousalEnabled: true,
  arousalDriveSettlementEnabled: true,
  soloSessionsEnabled: false,
};

test.after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function file(file, value, mode) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, value, { mode });
  await chmod(file, mode);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'privacy-safe-root-audit-'));
  directories.push(root);
  const uid = process.getuid();
  const gid = process.getgid();
  const heartbeatRoot = path.join(root, 'heartbeat');
  const dataRoot = path.join(root, 'data');
  const backupRoot = path.join(root, 'backups', '20260928T223043Z');
  const previousRelease = path.join(root, 'releases', 'previous');
  const aruData = path.join(root, 'aru-data');
  await Promise.all([
    mkdir(heartbeatRoot, { recursive: true, mode: 0o755 }),
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(previousRelease, { recursive: true, mode: 0o755 }),
    mkdir(aruData, { recursive: true, mode: 0o700 }),
    mkdir(path.join(backupRoot, 'aru'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(backupRoot, 'desire'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(backupRoot, 'systemd'), { recursive: true, mode: 0o700 }),
  ]);
  for (const directory of [dataRoot, aruData, backupRoot,
    path.join(backupRoot, 'aru'), path.join(backupRoot, 'desire'),
    path.join(backupRoot, 'systemd')]) await chmod(directory, 0o700);

  const metadata = {
    schema: 'aru.desire-heartbeat.deployment.v1',
    expectedCurrent: path.join(root, 'releases', 'current'),
    previousRelease,
    backupRoot,
    installedAt,
  };
  const packageBytes = Buffer.from('{"version":"0.9.10"}\n');
  const oldEntry = {
    path: 'package.json',
    size: packageBytes.length,
    sha256: createHash('sha256').update(packageBytes).digest('hex'),
  };
  const combined = createHash('sha256');
  combined.update(oldEntry.path, 'utf8');
  combined.update('\0');
  combined.update(oldEntry.sha256, 'ascii');
  combined.update('\0');
  combined.update(String(oldEntry.size), 'ascii');
  combined.update('\0');
  const manifest = {
    schema: 'aru.desire-heartbeat.file-manifest.v1',
    version: '0.9.10',
    source: 'recursive-runtime-closure',
    fileCount: 1,
    digest: combined.digest('hex'),
    files: [oldEntry],
  };
  const metadataBytes = `${JSON.stringify(metadata)}\n`;
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  const state = {
    appliedChatEventIds: ['event-' + 'a'.repeat(64)],
    appliedEffectIds: ['effect-' + 'b'.repeat(64)],
    privateNote: 'DO_NOT_LEAK_STATE_BODY',
  };
  const interaction = {
    chat: { processedEvents: [], settlementFacts: [], pending: [], pendingReleaseReceipt: null },
    arousal: { processedEvents: [], pendingReleaseReceipt: null },
  };
  const secret = 'DO_NOT_LEAK_SECRET_MATERIAL_1234567890\n';

  const paths = {
    deploymentMetadataPath: path.join(heartbeatRoot, 'deployment-metadata.json'),
    releaseManifestPath: path.join(heartbeatRoot, 'release-manifest.json'),
    configPath: path.join(heartbeatRoot, 'config', 'default.json'),
    statePath: path.join(dataRoot, 'state.json'),
    interactionStatePath: path.join(dataRoot, 'interaction-state.json'),
    aruSecretPath: path.join(aruData, 'desire-turn-hook.secret'),
    desireSecretPath: path.join(dataRoot, 'turn-hook.secret'),
  };
  await Promise.all([
    file(paths.deploymentMetadataPath, metadataBytes, 0o644),
    file(paths.releaseManifestPath, manifestBytes, 0o644),
    file(paths.configPath, `${JSON.stringify(flags)}\n`, 0o644),
    file(paths.statePath, `${JSON.stringify(state)}\n`, 0o600),
    file(paths.interactionStatePath, `${JSON.stringify(interaction)}\n`, 0o600),
    file(paths.aruSecretPath, secret, 0o600),
    file(paths.desireSecretPath, secret, 0o600),
    file(path.join(previousRelease, 'server.mjs'), 'previous server\n', 0o755),
    file(path.join(backupRoot, 'feature-flags.json'), `${JSON.stringify(flags)}\n`, 0o600),
    file(path.join(backupRoot, 'runtime-release-manifest.new.json'), manifestBytes, 0o600),
    file(path.join(backupRoot, 'deployment-metadata.new.json'), metadataBytes, 0o600),
    file(path.join(backupRoot, 'aru', 'previous-release'), `${previousRelease}\n`, 0o600),
    file(path.join(backupRoot, 'aru', 'server.mjs'), 'previous server\n', 0o755),
    file(path.join(backupRoot, 'aru', 'turn-hook.secret'), secret, 0o600),
    file(path.join(backupRoot, 'desire-turn-hook.secret'), secret, 0o600),
    file(path.join(backupRoot, 'systemd', 'aru-desire-turn-receiver.service'), 'fixture\n', 0o644),
    file(path.join(backupRoot, 'systemd', 'desire-turn-hook.conf'), 'fixture\n', 0o644),
    file(path.join(backupRoot, 'desire', 'config', 'default.json'), '{}\n', 0o644),
    file(path.join(backupRoot, 'desire', 'package.json'), packageBytes, 0o644),
    file(path.join(backupRoot, 'desire', 'release-manifest.json'), manifestBytes, 0o644),
    file(path.join(backupRoot, 'desire', 'deployment-metadata.json'), '{}\n', 0o644),
  ]);

  const options = {
    expectedBackupRoot: backupRoot,
    expectedInstalledAt: installedAt,
    heartbeatRoot,
    dataRoot,
    aruDataRoot: aruData,
    ...paths,
    accounts: {
      root: { uid, gid }, desire: { uid, gid }, aru: { uid, gid },
    },
    journalUnits: ['fixture.service'],
    readJournal: async () => [],
  };
  options.protectedSnapshotPaths = Object.values(paths);
  return { root, backupRoot, paths, options, state, interaction };
}

async function fingerprints(root) {
  const result = [];
  async function walk(item) {
    const info = await stat(item, { bigint: true });
    if (info.isDirectory()) {
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(item));
      for (const entry of entries.sort()) await walk(path.join(item, entry));
    } else {
      result.push([path.relative(root, item), info.mode, info.size, info.mtimeNs,
        (await readFile(item)).toString('base64')]);
    }
  }
  await walk(root);
  return result;
}

test('normal fixture passes provable checks and preserves the honest limitation', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  const report = await runPrivacySafeAudit(f.options);
  assert.equal(report.protectedFiles, STATUS.PASS);
  assert.equal(report.backup, STATUS.PASS);
  assert.equal(report.featureGates, STATUS.PASS);
  assert.equal(report.synthetic, STATUS.PASS);
  assert.equal(report.duplicateLedgers, STATUS.PASS);
  assert.equal(report.journal, STATUS.PASS);
  assert.equal(report.sideEffects, STATUS.PASS);
  assert.equal(report.nonExpectedStateChange, STATUS.INCONCLUSIVE);
});

test('synthetic pollution is counted without returning identifiers', () => {
  const at = Date.parse(installedAt) + 1_000;
  const interaction = structuredClone({
    ...{}, chat: { processedEvents: [{
      eventId: 'event-' + 'c'.repeat(64), labels: ['no_op'], at: { epochMs: at },
    }] }, arousal: { processedEvents: [] },
  });
  interaction.private = 'hostconv_activation-20260928T223043Z-0123456789abcdef';
  const result = auditStateObjects({}, interaction, installedAt);
  assert.equal(result.synthetic, STATUS.FAIL);
  assert.equal(result.syntheticCount, 2);
});

test('duplicate ledger entries are counted across protected ledgers', () => {
  const id = 'event-' + 'd'.repeat(64);
  const effect = 'effect-' + 'e'.repeat(64);
  const result = auditStateObjects(
    { appliedChatEventIds: [id, id], appliedEffectIds: [effect, effect] },
    { chat: { processedEvents: [{ eventId: id }, { eventId: id }], settlementFacts: [] },
      arousal: { processedEvents: [id, id] } },
    installedAt,
  );
  assert.equal(result.duplicateLedgers, STATUS.FAIL);
  assert.equal(result.duplicateCount, 4);
});

test('feature gates expose only equality status', () => {
  assert.equal(compareFeatureGates(flags, flags), STATUS.PASS);
  assert.equal(compareFeatureGates({ ...flags, soloSessionsEnabled: true }, flags), STATUS.FAIL);
});

test('permission errors are classified without exception details', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  const error = new Error('DO_NOT_LEAK_PERMISSION_PATH');
  error.code = 'EACCES';
  f.options.readJournal = async () => { throw error; };
  const report = await runPrivacySafeAudit(f.options);
  const output = renderPrivacySafeReport(report);
  assert.equal(report.journal, STATUS.INCONCLUSIVE);
  assert.equal(report.auditErrorCounts.permission_error, 1);
  assert.doesNotMatch(output, /DO_NOT_LEAK/u);
});

test('damaged backup permissions fail backup validation', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  await chmod(f.backupRoot, 0o755);
  const report = await runPrivacySafeAudit(f.options);
  assert.equal(report.backup, STATUS.FAIL);
  assert.equal(report.auditErrorCounts.structure_error, 1);
});

test('journal messages are reduced to predefined categories and counts', () => {
  const counts = classifyJournalRows([
    { MESSAGE: 'SyntaxError and MODULE_NOT_FOUND' },
    { MESSAGE: 'permission denied' },
    { MESSAGE: 'delivery_failed' },
    { MESSAGE: 'private ordinary message DO_NOT_LEAK' },
  ]);
  assert.equal(counts.syntax_error, 1);
  assert.equal(counts.module_not_found, 1);
  assert.equal(counts.permission_error, 1);
  assert.equal(counts.delivery_failure, 1);
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 4);
});

test('journal error findings fail only by fixed category and count', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  f.options.readJournal = async () => [{
    MESSAGE: 'SyntaxError DO_NOT_LEAK_JOURNAL_BODY',
  }];
  const report = await runPrivacySafeAudit(f.options);
  const output = renderPrivacySafeReport(report);
  assert.equal(report.journal, STATUS.FAIL);
  assert.equal(report.journalCounts.syntax_error, 1);
  assert.match(output, /^SYSTEMD_JOURNAL=FAIL$/mu);
  assert.match(output, /^JOURNAL_SYNTAX_ERROR=1$/mu);
  assert.doesNotMatch(output, /DO_NOT_LEAK/u);
});

test('rendered output cannot leak fixture bodies, URLs, credentials, or identifiers', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  f.options.readJournal = async () => [{
    MESSAGE: 'ordinary https://private.invalid/path token=DO_NOT_LEAK_CREDENTIAL',
  }];
  const output = renderPrivacySafeReport(await runPrivacySafeAudit(f.options));
  assert.doesNotMatch(output, /DO_NOT_LEAK|https?:|event-[a-f0-9]|token=/iu);
  assert.match(output, /^PRIVACY_SAFE_ROOT_AUDIT=/u);
});

test('audit leaves fixture bytes and metadata unchanged', {
  timeout: 10_000,
}, async () => {
  const f = await fixture();
  const before = await fingerprints(f.root);
  await runPrivacySafeAudit(f.options);
  const after = await fingerprints(f.root);
  assert.deepEqual(after, before);
});

test('production entrypoints contain no filesystem write or service mutation APIs', async () => {
  const files = await Promise.all([
    readFile(path.join(ROOT, 'scripts/privacy-safe-root-audit-core.mjs'), 'utf8'),
    readFile(path.join(ROOT, 'scripts/audit-privacy-safe-root-readonly-once.mjs'), 'utf8'),
    readFile(path.join(ROOT, 'scripts/audit-privacy-safe-root-readonly-once.sh'), 'utf8'),
  ]);
  const source = files.join('\n');
  assert.doesNotMatch(source, /\b(writeFile|appendFile|rename|unlink|rm|mkdir|chmod|chown|symlink)\s*\(/u);
  assert.doesNotMatch(source, /systemctl\s+(start|stop|restart|reload|enable|disable)/u);
  assert.doesNotMatch(files.slice(0, 2).join('\n'), /\b(POST|PUT|PATCH|DELETE|CONNECT)\b/u);
  assert.doesNotMatch(source, /git\s+(add|commit|tag|push|reset|checkout|clean)/u);
});
