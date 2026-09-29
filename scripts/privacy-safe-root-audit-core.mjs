import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

export const JOURNAL_CATEGORIES = Object.freeze({
  module_not_found: /MODULE_NOT_FOUND/iu,
  syntax_error: /SyntaxError/iu,
  permission_error: /(?:EACCES|EPERM|permission denied)/iu,
  request_rejected: /(?:unauthorized|forbidden|request rejected|HTTP 40[13])/iu,
  restart_loop: /(?:Scheduled restart job|restart counter|Start request repeated too quickly)/iu,
  delivery_failure: /(?:delivery_failed|delivery-failed)/iu,
  process_failure: /(?:Failed with result|failed to start|code=exited|status=[1-9][0-9]*\/)/iu,
});

const FLAGS = Object.freeze([
  'observeOnly',
  'deliveryEnabled',
  'chatStimulusEnabled',
  'arousalEnabled',
  'arousalDriveSettlementEnabled',
  'soloSessionsEnabled',
]);

const SYNTHETIC_LITERAL = /(?:activation-\d{8}T\d{6}Z-[a-f0-9]{16}|hostconv_activation-|hostmsg_activation-)/iu;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function combinedDigest(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path, 'utf8');
    digest.update('\0');
    digest.update(file.sha256, 'ascii');
    digest.update('\0');
    digest.update(String(file.size), 'ascii');
    digest.update('\0');
  }
  return digest.digest('hex');
}

function mode(info) {
  return info.mode & 0o777;
}

async function safeFile(file, expected) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe file');
  if (expected.uid !== undefined && info.uid !== expected.uid) throw new Error('owner mismatch');
  if (expected.gid !== undefined && info.gid !== expected.gid) throw new Error('group mismatch');
  if (expected.mode !== undefined && mode(info) !== expected.mode) throw new Error('mode mismatch');
  return { info, bytes: await readFile(file) };
}

async function safeDirectory(directory, expected) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory');
  if (expected.uid !== undefined && info.uid !== expected.uid) throw new Error('owner mismatch');
  if (expected.gid !== undefined && info.gid !== expected.gid) throw new Error('group mismatch');
  if (expected.mode !== undefined && mode(info) !== expected.mode) throw new Error('mode mismatch');
  return info;
}

function parseJson(bytes) {
  return JSON.parse(bytes.toString('utf8'));
}

function auditIssue(category) {
  const error = new Error('classified audit failure');
  error.auditCategory = category;
  return error;
}

function parseDeploymentBinding(bytes, options) {
  let metadata;
  try {
    metadata = parseJson(bytes);
  } catch {
    throw auditIssue('metadata_shape_error');
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(',') !==
        'backupRoot,expectedCurrent,installedAt,previousRelease,schema' ||
      metadata.schema !== 'aru.desire-heartbeat.deployment.v1' ||
      typeof metadata.backupRoot !== 'string' ||
      typeof metadata.expectedCurrent !== 'string' ||
      typeof metadata.previousRelease !== 'string' ||
      typeof metadata.installedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(metadata.installedAt) ||
      !Number.isFinite(Date.parse(metadata.installedAt))) {
    throw auditIssue('metadata_shape_error');
  }
  const backupParent = path.resolve(options.backupRootParent);
  const releasePrefix = `${path.resolve(options.releaseRootPrefix)}${path.sep}`;
  const stamp = metadata.installedAt.replace(/[-:]/gu, '');
  if (path.normalize(metadata.backupRoot) !== metadata.backupRoot ||
      path.dirname(metadata.backupRoot) !== backupParent ||
      path.basename(metadata.backupRoot) !== stamp ||
      path.normalize(metadata.expectedCurrent) !== metadata.expectedCurrent ||
      !metadata.expectedCurrent.startsWith(releasePrefix) ||
      !path.basename(metadata.expectedCurrent).endsWith(`-${stamp}`) ||
      path.normalize(metadata.previousRelease) !== metadata.previousRelease ||
      !metadata.previousRelease.startsWith(releasePrefix) ||
      metadata.previousRelease === metadata.expectedCurrent) {
    throw auditIssue('backup_binding_error');
  }
  return metadata;
}

function validateCurrentManifest(manifest, packageMetadata, packageBytes) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schema !== 'aru.desire-heartbeat.file-manifest.v1' ||
      manifest.source !== 'recursive-runtime-closure' ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
      !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount ||
      typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest) ||
      packageMetadata === null || typeof packageMetadata !== 'object' ||
      packageMetadata.version !== manifest.version) {
    throw auditIssue('manifest_binding_error');
  }
  let previous = null;
  for (const entry of manifest.files) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join(',') !== 'path,sha256,size' ||
        typeof entry.path !== 'string' || entry.path.length === 0 ||
        path.isAbsolute(entry.path) || entry.path.split('/').includes('..') ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
        (previous !== null && previous.localeCompare(entry.path) >= 0)) {
      throw auditIssue('manifest_binding_error');
    }
    previous = entry.path;
  }
  if (combinedDigest(manifest.files) !== manifest.digest) {
    throw auditIssue('manifest_binding_error');
  }
  const packageEntry = manifest.files.find((entry) => entry.path === 'package.json');
  if (!packageEntry || packageEntry.size !== packageBytes.length ||
      packageEntry.sha256 !== sha256(packageBytes)) {
    throw auditIssue('manifest_binding_error');
  }
}

async function verifyUniqueBackupBinding(options, metadata, metadataBytes, accounts) {
  let targetInfo;
  try {
    targetInfo = await lstat(metadata.backupRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') throw auditIssue('backup_missing_error');
    throw error;
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw auditIssue('backup_binding_error');
  }
  let targetMetadata;
  try {
    targetMetadata = await safeFile(
      path.join(metadata.backupRoot, 'deployment-metadata.new.json'),
      { ...accounts.root, mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') throw auditIssue('backup_binding_error');
    throw error;
  }
  if (!targetMetadata.bytes.equals(metadataBytes)) throw auditIssue('backup_binding_error');

  let exactBindings = 0;
  for (const name of await readdir(options.backupRootParent)) {
    if (!/^\d{8}T\d{6}Z$/u.test(name)) continue;
    const candidateRoot = path.join(options.backupRootParent, name);
    let rootInfo;
    try {
      rootInfo = await lstat(candidateRoot);
    } catch {
      continue;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
    try {
      const candidate = await safeFile(
        path.join(candidateRoot, 'deployment-metadata.new.json'), {},
      );
      if (candidate.bytes.equals(metadataBytes)) exactBindings += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT' && candidateRoot === metadata.backupRoot) throw error;
    }
  }
  if (exactBindings !== 1) throw auditIssue('binding_ambiguity_error');
}

function duplicateCount(values) {
  return values.length - new Set(values).size;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkStrings(item, visit);
  }
}

export function auditStateObjects(state, interaction, installedAt) {
  const desireChat = Array.isArray(state?.appliedChatEventIds) ? state.appliedChatEventIds : [];
  const effects = Array.isArray(state?.appliedEffectIds) ? state.appliedEffectIds : [];
  const chatRecords = Array.isArray(interaction?.chat?.processedEvents)
    ? interaction.chat.processedEvents : [];
  const chatIds = chatRecords.map((item) => item?.eventId).filter((item) => typeof item === 'string');
  const arousal = Array.isArray(interaction?.arousal?.processedEvents)
    ? interaction.arousal.processedEvents : [];
  const settlementEffects = Array.isArray(interaction?.chat?.settlementFacts)
    ? interaction.chat.settlementFacts.map((item) => item?.effectId)
      .filter((item) => typeof item === 'string')
    : [];

  const duplicates = duplicateCount(desireChat) + duplicateCount(effects) +
    duplicateCount(chatIds) + duplicateCount(arousal) + duplicateCount(settlementEffects);

  let literalSynthetic = 0;
  walkStrings({ state, interaction }, (value) => {
    if (SYNTHETIC_LITERAL.test(value)) literalSynthetic += 1;
  });
  const start = Date.parse(installedAt);
  const end = start + 180_000;
  const activationWindowCandidates = chatRecords.filter((record) => {
    const at = record?.at?.epochMs;
    return Number.isFinite(at) && at >= start && at <= end &&
      Array.isArray(record.labels) && record.labels.includes('no_op');
  }).length;
  const syntheticCount = literalSynthetic + activationWindowCandidates;
  return {
    syntheticCount,
    duplicateCount: duplicates,
    synthetic: syntheticCount === 0 ? STATUS.PASS : STATUS.FAIL,
    duplicateLedgers: duplicates === 0 ? STATUS.PASS : STATUS.FAIL,
  };
}

export function compareFeatureGates(config, snapshot) {
  if (!config || !snapshot || Object.keys(snapshot).sort().join(',') !== [...FLAGS].sort().join(',')) {
    return STATUS.FAIL;
  }
  for (const key of FLAGS) {
    if (typeof config[key] !== 'boolean' || typeof snapshot[key] !== 'boolean' ||
        config[key] !== snapshot[key]) return STATUS.FAIL;
  }
  return STATUS.PASS;
}

export function classifyJournalRows(rows) {
  const counts = Object.fromEntries(Object.keys(JOURNAL_CATEGORIES).map((key) => [key, 0]));
  for (const row of rows) {
    const message = String(row?.MESSAGE ?? '');
    for (const [name, pattern] of Object.entries(JOURNAL_CATEGORIES)) {
      if (pattern.test(message)) counts[name] += 1;
    }
  }
  return counts;
}

async function recursiveSnapshot(root) {
  const result = [];
  async function visit(item, relative = '') {
    const info = await lstat(item);
    const record = {
      relative,
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      uid: info.uid,
      gid: info.gid,
      mode: mode(info),
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: null,
    };
    if (info.isSymbolicLink()) record.type = 'symlink';
    if (info.isFile()) record.hash = sha256(await readFile(item));
    result.push(record);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const entries = await readdir(item);
      entries.sort();
      for (const entry of entries) await visit(path.join(item, entry), path.join(relative, entry));
    }
  }
  await visit(root);
  return result;
}

async function protectedSnapshot(paths) {
  const records = [];
  for (const item of paths) {
    const info = await lstat(item);
    records.push({
      item,
      uid: info.uid,
      gid: info.gid,
      mode: mode(info),
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash: info.isFile() ? sha256(await readFile(item)) : null,
    });
  }
  return records;
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function auditBackup(options, metadata, manifest, accounts) {
  const root = metadata.backupRoot;
  const rootAccount = accounts.root;
  const expectedStamp = metadata.installedAt.replace(/[-:]/gu, '').replace('.000Z', 'Z');
  if (path.basename(root) !== expectedStamp) throw new Error('backup timestamp mismatch');

  await safeDirectory(root, { ...rootAccount, mode: 0o700 });
  for (const directory of ['aru', 'desire', 'systemd']) {
    await safeDirectory(path.join(root, directory), { ...rootAccount, mode: 0o700 });
  }

  const feature = await safeFile(path.join(root, 'feature-flags.json'), {
    ...rootAccount, mode: 0o600,
  });
  const runtimeManifest = await safeFile(path.join(root, 'runtime-release-manifest.new.json'), {
    ...rootAccount, mode: 0o600,
  });
  const deployment = await safeFile(path.join(root, 'deployment-metadata.new.json'), {
    ...rootAccount, mode: 0o600,
  });
  const previousText = (await safeFile(path.join(root, 'aru', 'previous-release'), {
    ...rootAccount, mode: 0o600,
  })).bytes.toString('utf8').trim();
  if (previousText !== metadata.previousRelease || await realpath(previousText) !== previousText) {
    throw new Error('previous release mismatch');
  }
  const previousServer = await safeFile(path.join(previousText, 'server.mjs'), {});
  const backupServer = await safeFile(path.join(root, 'aru', 'server.mjs'), {
    uid: previousServer.info.uid, gid: previousServer.info.gid, mode: mode(previousServer.info),
  });
  if (!backupServer.bytes.equals(previousServer.bytes)) throw new Error('previous server mismatch');

  const aruSecret = await safeFile(path.join(root, 'aru', 'turn-hook.secret'), {
    uid: accounts.aru.uid, gid: accounts.aru.gid, mode: 0o600,
  });
  const desireSecret = await safeFile(path.join(root, 'desire-turn-hook.secret'), {
    uid: accounts.desire.uid, gid: accounts.desire.gid, mode: 0o600,
  });
  const currentAruSecret = await safeFile(options.aruSecretPath, {
    uid: accounts.aru.uid, gid: accounts.aru.gid, mode: 0o600,
  });
  const currentDesireSecret = await safeFile(options.desireSecretPath, {
    uid: accounts.desire.uid, gid: accounts.desire.gid, mode: 0o600,
  });
  if (!aruSecret.bytes.equals(currentAruSecret.bytes) ||
      !desireSecret.bytes.equals(currentDesireSecret.bytes) ||
      !currentAruSecret.bytes.equals(currentDesireSecret.bytes)) {
    throw new Error('secret channel mismatch');
  }

  for (const file of ['aru-desire-turn-receiver.service', 'desire-turn-hook.conf']) {
    await safeFile(path.join(root, 'systemd', file), { ...rootAccount, mode: 0o644 });
  }

  const productionMetadata = await safeFile(options.deploymentMetadataPath, {
    ...rootAccount, mode: 0o644,
  });
  const productionManifest = await safeFile(options.releaseManifestPath, {
    ...rootAccount, mode: 0o644,
  });
  if (!deployment.bytes.equals(productionMetadata.bytes)) {
    throw auditIssue('backup_binding_error');
  }
  if (!runtimeManifest.bytes.equals(productionManifest.bytes)) {
    throw auditIssue('manifest_binding_error');
  }

  const expectedDesire = new Set([
    'config/default.json',
    ...manifest.files.map((item) => item.path),
    'release-manifest.json',
    'deployment-metadata.json',
  ]);
  const missingPath = path.join(root, 'desire-missing-files');
  let missing = new Set();
  try {
    const file = await safeFile(missingPath, { ...rootAccount, mode: 0o600 });
    const names = file.bytes.toString('utf8').split(/\n/u).filter(Boolean);
    if (new Set(names).size !== names.length || names.some((name) =>
      path.isAbsolute(name) || path.normalize(name) !== name || name.startsWith('..') ||
      !expectedDesire.has(name))) throw new Error('unsafe missing inventory');
    missing = new Set(names);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const relative of expectedDesire) {
    if (missing.has(relative)) continue;
    const expectedMode = relative.startsWith('bin/') || relative.startsWith('scripts/')
      ? 0o755 : 0o644;
    await safeFile(path.join(root, 'desire', relative), {
      ...rootAccount, mode: expectedMode,
    });
  }
  if (missing.size + [...expectedDesire].filter((item) => !missing.has(item)).length !==
      expectedDesire.size) throw new Error('backup coverage mismatch');

  const oldManifestFile = await safeFile(
    path.join(root, 'desire', 'release-manifest.json'),
    { ...rootAccount, mode: 0o644 },
  );
  const oldManifest = parseJson(oldManifestFile.bytes);
  if (oldManifest?.schema !== 'aru.desire-heartbeat.file-manifest.v1' ||
      oldManifest?.source !== 'recursive-runtime-closure' ||
      !Array.isArray(oldManifest.files) || oldManifest.fileCount !== oldManifest.files.length ||
      typeof oldManifest.digest !== 'string' || combinedDigest(oldManifest.files) !== oldManifest.digest ||
      JSON.stringify(oldManifest.files.map((item) => item.path)) !==
        JSON.stringify(manifest.files.map((item) => item.path))) {
    throw auditIssue('manifest_binding_error');
  }
  for (const item of oldManifest.files) {
    const backedUp = await safeFile(path.join(root, 'desire', item.path), {
      ...rootAccount,
      mode: item.path.startsWith('bin/') || item.path.startsWith('scripts/') ? 0o755 : 0o644,
    });
    if (backedUp.info.size !== item.size || sha256(backedUp.bytes) !== item.sha256) {
      throw auditIssue('manifest_binding_error');
    }
  }

  const allowedFiles = new Set([
    'feature-flags.json',
    'runtime-release-manifest.new.json',
    'deployment-metadata.new.json',
    'aru/previous-release',
    'aru/server.mjs',
    'aru/turn-hook.secret',
    'desire-turn-hook.secret',
    'systemd/aru-desire-turn-receiver.service',
    'systemd/desire-turn-hook.conf',
    ...[...expectedDesire].filter((item) => !missing.has(item)).map((item) => `desire/${item}`),
  ]);
  if (missing.size > 0) allowedFiles.add('desire-missing-files');
  const allowedDirectories = new Set(['', 'aru', 'desire', 'systemd']);
  for (const file of allowedFiles) {
    let parent = path.dirname(file);
    while (parent !== '.') {
      allowedDirectories.add(parent);
      parent = path.dirname(parent);
    }
  }
  for (const entry of await recursiveSnapshot(root)) {
    if (entry.type === 'directory') {
      if (!allowedDirectories.has(entry.relative) || entry.uid !== rootAccount.uid ||
          entry.gid !== rootAccount.gid || entry.mode !== 0o700) {
        throw new Error('backup directory inventory invalid');
      }
    } else if (entry.type !== 'file' || !allowedFiles.has(entry.relative)) {
      throw new Error('backup file inventory invalid');
    }
  }

  return { featureSnapshot: parseJson(feature.bytes) };
}

function blankJournalCounts() {
  return Object.fromEntries(Object.keys(JOURNAL_CATEGORIES).map((key) => [key, 0]));
}

function mergeCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
}

export async function runPrivacySafeAudit(options) {
  const report = {
    installationBinding: STATUS.INCONCLUSIVE,
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
    journalCounts: blankJournalCounts(),
    auditErrorCounts: {
      permission_error: 0,
      structure_error: 0,
      journal_access_error: 0,
      metadata_shape_error: 0,
      backup_binding_error: 0,
      backup_missing_error: 0,
      binding_ambiguity_error: 0,
      manifest_binding_error: 0,
    },
  };
  let before = null;
  let metadata = null;
  let stage = 'binding';
  try {
    const metadataFile = await safeFile(options.deploymentMetadataPath, {
      ...options.accounts.root, mode: 0o644,
    });
    metadata = parseDeploymentBinding(metadataFile.bytes, options);
    let manifest;
    let packageMetadata;
    let packageBytes;
    try {
      manifest = parseJson((await safeFile(options.releaseManifestPath, {
        ...options.accounts.root, mode: 0o644,
      })).bytes);
      packageBytes = (await safeFile(options.packagePath, {
        ...options.accounts.root, mode: 0o644,
      })).bytes;
      packageMetadata = parseJson(packageBytes);
    } catch {
      throw auditIssue('manifest_binding_error');
    }
    validateCurrentManifest(manifest, packageMetadata, packageBytes);
    await verifyUniqueBackupBinding(options, metadata, metadataFile.bytes, options.accounts);
    report.installationBinding = STATUS.PASS;

    stage = 'snapshot';
    before = {
      protected: await protectedSnapshot(options.protectedSnapshotPaths),
      backup: await recursiveSnapshot(metadata.backupRoot),
    };
    stage = 'protected';
    await safeDirectory(options.aruDataRoot, {
      uid: options.accounts.aru.uid, gid: options.accounts.aru.gid, mode: 0o700,
    });
    await safeDirectory(options.dataRoot, {
      uid: options.accounts.desire.uid, gid: options.accounts.desire.gid, mode: 0o700,
    });
    await safeFile(options.aruSecretPath, {
      uid: options.accounts.aru.uid, gid: options.accounts.aru.gid, mode: 0o600,
    });
    await safeFile(options.desireSecretPath, {
      uid: options.accounts.desire.uid, gid: options.accounts.desire.gid, mode: 0o600,
    });
    const config = parseJson((await safeFile(options.configPath, {
      ...options.accounts.root, mode: 0o644,
    })).bytes);
    const stateFile = await safeFile(options.statePath, {
      uid: options.accounts.desire.uid, gid: options.accounts.desire.gid, mode: 0o600,
    });
    const interactionFile = await safeFile(options.interactionStatePath, {
      uid: options.accounts.desire.uid, gid: options.accounts.desire.gid, mode: 0o600,
    });
    report.protectedFiles = STATUS.PASS;
    const state = parseJson(stateFile.bytes);
    const interaction = parseJson(interactionFile.bytes);
    if (options.validateStateObjects) options.validateStateObjects(config, state, interaction);
    const ledger = auditStateObjects(state, interaction, metadata.installedAt);
    Object.assign(report, ledger);

    stage = 'backup';
    const backup = await auditBackup(options, metadata, manifest, options.accounts);
    report.backup = STATUS.PASS;
    stage = 'feature';
    report.featureGates = compareFeatureGates(config, backup.featureSnapshot);

    stage = 'journal';
    for (const unit of options.journalUnits) {
      const result = await options.readJournal(unit, metadata.installedAt);
      if (!Array.isArray(result)) throw new Error('journal access failed');
      mergeCounts(report.journalCounts, classifyJournalRows(result));
    }
    report.journal = Object.values(report.journalCounts).some((count) => count > 0)
      ? STATUS.FAIL : STATUS.PASS;

    // v0.9.10 intentionally did not snapshot production state. Legal heartbeat evolution
    // means absence of arbitrary non-test changes cannot be proven after the fact.
    report.nonExpectedStateChange = STATUS.INCONCLUSIVE;
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      report.auditErrorCounts.permission_error += 1;
    } else if (stage === 'journal' || String(error?.message ?? '').includes('journal')) {
      report.auditErrorCounts.journal_access_error += 1;
    } else {
      report.auditErrorCounts.structure_error += 1;
      if (Object.hasOwn(report.auditErrorCounts, error?.auditCategory)) {
        report.auditErrorCounts[error.auditCategory] += 1;
      }
    }
    if (stage === 'binding') report.installationBinding = STATUS.FAIL;
    if (stage === 'snapshot' || stage === 'protected') report.protectedFiles = STATUS.FAIL;
    if (stage === 'backup') report.backup = STATUS.FAIL;
    if (stage === 'feature') report.featureGates = STATUS.FAIL;
  } finally {
    if (before !== null) {
      try {
        const after = {
          protected: await protectedSnapshot(options.protectedSnapshotPaths),
          backup: await recursiveSnapshot(metadata.backupRoot),
        };
        report.sideEffects = sameSnapshot(before, after) ? STATUS.PASS : STATUS.INCONCLUSIVE;
      } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') {
          report.auditErrorCounts.permission_error += 1;
        } else {
          report.auditErrorCounts.structure_error += 1;
        }
      }
    }
  }
  return report;
}

export function renderPrivacySafeReport(report) {
  const statuses = [
    report.installationBinding, report.protectedFiles, report.backup, report.featureGates, report.synthetic,
    report.duplicateLedgers, report.nonExpectedStateChange, report.journal, report.sideEffects,
  ];
  const overall = statuses.includes(STATUS.FAIL)
    ? STATUS.FAIL : statuses.includes(STATUS.INCONCLUSIVE) ? STATUS.INCONCLUSIVE : STATUS.PASS;
  const lines = [
    `PRIVACY_SAFE_ROOT_AUDIT=${overall}`,
    `INSTALLATION_BINDING=${report.installationBinding}`,
    `PROTECTED_FILES=${report.protectedFiles}`,
    `ROLLBACK_BACKUP=${report.backup}`,
    `FEATURE_GATES=${report.featureGates}`,
    `SYNTHETIC_TEST_EVENTS=${report.synthetic}`,
    `SYNTHETIC_TEST_EVENT_COUNT=${report.syntheticCount}`,
    `DUPLICATE_LEDGERS=${report.duplicateLedgers}`,
    `DUPLICATE_LEDGER_ENTRY_COUNT=${report.duplicateCount}`,
    `NONEXPECTED_STATE_CHANGE=${report.nonExpectedStateChange}`,
    `SYSTEMD_JOURNAL=${report.journal}`,
    `AUDITOR_SIDE_EFFECTS=${report.sideEffects}`,
  ];
  for (const key of Object.keys(JOURNAL_CATEGORIES)) {
    lines.push(`JOURNAL_${key.toUpperCase()}=${report.journalCounts[key] ?? 0}`);
  }
  for (const [key, count] of Object.entries(report.auditErrorCounts)) {
    lines.push(`AUDIT_${key.toUpperCase()}=${count}`);
  }
  const output = `${lines.join('\n')}\n`;
  if (output.split(/\n/u).filter(Boolean).some((line) =>
    !/^[A-Z_]+=(?:PASS|FAIL|INCONCLUSIVE|[0-9]+)$/u.test(line))) {
    throw new Error('unsafe report value');
  }
  return output;
}
