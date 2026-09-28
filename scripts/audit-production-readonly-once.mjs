#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readDeploymentMetadata, verifiedManifestPathRecord, verifyFormalReleaseLayout,
} from './formal-release-layout.mjs';

const CURRENT_LINK = '/opt/aru-selfhost/current';
const BASE_RELEASE = '/opt/aru-selfhost/releases/v0.30.2-pairing-hotfix1';
const HEARTBEAT_ROOT = '/opt/aru-desire-heartbeat';
const DEPLOYMENT_METADATA_PATH = path.join(HEARTBEAT_ROOT, 'deployment-metadata.json');
const DATA_ROOT = '/var/lib/aru-desire-heartbeat';
const UNIT_ROOT = '/etc/systemd/system';
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVES = Object.freeze([
  'attachment', 'curiosity', 'reflection', 'duty',
  'social', 'fatigue', 'libido', 'stress',
]);
const EXPECTED_BASELINE_DIFFERENCES = Object.freeze([
  'conversation-desire-candidate.mjs',
  'conversation-desire-client.mjs',
  'conversation-desire-normalizer.mjs',
  'conversation-desire-openai-material.mjs',
  'conversation-response-format.mjs',
  'conversation-turn-relay.mjs',
  'run-node.sh',
]);
const ALLOWED_GENERATED = new Set([
  'aru-desire-turn-hook.mjs', 'aru-desire-relay-turn.mjs', 'synthetic-check.mjs',
  'server.mjs', 'release-manifest.json',
]);
const UNITS = Object.freeze([
  'aru-selfhost.service',
  'aru-desire-turn-receiver.service',
  'aru-desire-dashboard.service',
  'aru-desire-heartbeat.service',
  'aru-desire-heartbeat.timer',
]);
const SAFE_HEARTBEAT_STATUSES = new Set([
  'idle', 'withheld', 'held_disabled', 'held_claimed', 'solo_selected',
  'solo_completed', 'submitting', 'submitted', 'delivery_failed', 'pending_expired',
]);
const SAFE_INTENTS = new Set([
  'seek_closeness', 'explore', 'reflect', 'complete_task',
  'socialize', 'rest', 'solo', 'seek_relief',
]);
const SAFE_BLOCKERS = new Set([
  'observe-only', 'delivery-disabled', 'delivery-adapter-disabled',
]);
const SAFE_EVENT_LABELS = new Set([
  'intimacy_longing', 'neutral_discussion', 'flirt_tease', 'direct_desire',
  'sexual_explicit', 'concrete_intimate_action', 'partnered_no_release',
  'partnered_release', 'solo_no_release', 'solo_release', 'hurt_anger', 'needs_support',
  'affirmation', 'ambiguous_affect', 'no_op', 'replay_reconciled',
  'non_assertion', 'question', 'negated_or_stop', 'hypothetical_or_plan',
  'tutorial', 'memory', 'third_person',
]);
const SAFE_RECEIVER_ERRORS = new Set([
  'unauthorized', 'busy', 'processing_error', 'MESSAGE_EVENT_INVALID',
  'MESSAGE_EVENT_INCOMPLETE', 'CLOCK_ANOMALY',
]);

if (process.getuid?.() !== 0) throw new Error('root is required');
if (process.argv.length !== 2) throw new Error('this audit accepts no arguments');

const { metadata: DEPLOYMENT } = await readDeploymentMetadata(DEPLOYMENT_METADATA_PATH, {
  expectedUid: 0,
});
const START_ISO = DEPLOYMENT.installedAt;
const START_MS = Date.parse(START_ISO);
const EXPECTED_CURRENT = DEPLOYMENT.expectedCurrent;
const ROLLBACK_ROOT = DEPLOYMENT.backupRoot;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prefix(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/[a-f0-9]{8,64}/iu);
  return match ? match[0].slice(0, 8).toLowerCase() : sha256(value).slice(0, 8);
}

function iso(epochMs) {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
  return { info, bytes: await readFile(file) };
}

async function jsonFile(file, label) {
  const { bytes } = await regularFile(file, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function inventory(root) {
  const result = new Map();
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release contains symlink: ${rel}`);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(full);
        result.set(rel, { size: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`release contains unsupported entry: ${rel}`);
      }
    }
  }
  await walk(root);
  return result;
}

function replaceOnce(source, before, after, label, alreadySafe = null) {
  if (alreadySafe !== null && source.includes(alreadySafe)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label} patch anchor is missing or ambiguous`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function expectedPatchedServer(original) {
  let source = original;
  source = replaceOnce(source, `  const pairingPayload = {
    schema: "aru.selfhost.pairing-envelope.v1",
    canonicalUrl: config.baseUrl,
    manifestUrl: manifestURL,
    serverId: state.serverId,
    pairingToken: state.pairing.token,
    installSessionLabel: "stub-boot",
  };
  const pairingURL =
    \`aru://pair?canonicalUrl=\${encodeURIComponent(config.baseUrl)}\` +
    \`&serverId=\${encodeURIComponent(state.serverId)}\` +
    \`&pairingToken=\${encodeURIComponent(state.pairing.token)}\` +
    \`&manifestUrl=\${encodeURIComponent(manifestURL)}\`;
`, '', 'pairing construction', 'startup logs never include credentials');
  source = replaceOnce(source, `  console.log("Pairing payload (paste into Aru, or encode as QR). Single use,");
  console.log(\`expires in 10 minutes:\`);
  console.log("");
  console.log(JSON.stringify(pairingPayload, null, 2));
  console.log("");
  console.log(pairingURL);
  console.log("");
  console.log("No secrets are logged past this point.");
`, `  console.log("Pairing bootstrap is active; startup logs never include credentials.");
  console.log("Use the explicit owner-only pairing command when a new device is intended.");
`, 'pairing logging', 'startup logs never include credentials');
  source = replaceOnce(
    source,
    'import { createWakeBridge } from "./wake-bridge.mjs";\n',
    'import { createWakeBridge } from "./wake-bridge.mjs";\n' +
      'import { createAruDesireTurnHook, wrapOnTurnSettled } from "./aru-desire-turn-hook.mjs";\n',
    'hook import',
    'import { createAruDesireTurnHook, wrapOnTurnSettled } from "./aru-desire-turn-hook.mjs";',
  );
  source = replaceOnce(
    source,
    'const collaboratorHost = createCollaboratorHost({\n',
    'const desireTurnHook = createAruDesireTurnHook();\n' +
      'const collaboratorHost = createCollaboratorHost({\n',
    'hook construction',
    'const desireTurnHook = createAruDesireTurnHook();',
  );
  source = replaceOnce(
    source,
    '  onTurnSettled: remotePush.deliverHostedCollaboratorTurn,\n',
    '  onTurnSettled: wrapOnTurnSettled(remotePush.deliverHostedCollaboratorTurn, desireTurnHook),\n',
    'turn callback',
    'onTurnSettled: wrapOnTurnSettled(remotePush.deliverHostedCollaboratorTurn, desireTurnHook)',
  );
  source = replaceOnce(
    source,
    '    deviceCount: state.devices.filter((d) => !d.revokedAt).length,\n',
    '    deviceCount: state.devices.filter((d) => !d.revokedAt).length,\n' +
      '    desireTurnHook: desireTurnHook.diagnostics(),\n',
    'diagnostics',
    'desireTurnHook: desireTurnHook.diagnostics()',
  );
  return source;
}

function parseUnit(text) {
  const sections = {};
  let section = null;
  for (const original of text.split(/\r?\n/u)) {
    const line = original.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([^\]]+)\]$/u);
    if (header) {
      section = header[1];
      sections[section] ??= {};
      continue;
    }
    const index = line.indexOf('=');
    if (!section || index < 1) throw new Error('unit contains an invalid directive');
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim().replace(/\s+/gu, ' ');
    sections[section][key] ??= [];
    sections[section][key].push(value);
  }
  return sections;
}

function unitDifferences(left, right) {
  const result = [];
  for (const section of sortedUnique([...Object.keys(left), ...Object.keys(right)])) {
    const a = left[section] ?? {};
    const b = right[section] ?? {};
    for (const key of sortedUnique([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[key] ?? []) !== JSON.stringify(b[key] ?? [])) {
        result.push(`${section}.${key}`);
      }
    }
  }
  return result;
}

function runReadOnly(program, args) {
  const allowed = new Map([
    ['/usr/bin/systemctl', new Set(['show', 'is-active', 'is-enabled'])],
    ['/usr/bin/journalctl', new Set(['-u'])],
  ]);
  if (!allowed.has(program) || !allowed.get(program).has(args[0])) {
    throw new Error('unapproved subprocess requested');
  }
  try {
    return execFileSync(program, args, {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
  } catch {
    throw new Error('approved read-only subprocess failed');
  }
}

function systemctlShow(unit) {
  const text = runReadOnly('/usr/bin/systemctl', [
    'show', unit,
    '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState',
    '-p', 'Result', '-p', 'NRestarts', '-p', 'ActiveEnterTimestamp', '-p', 'ExecStart',
  ]);
  return Object.fromEntries(text.trim().split(/\n/u).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: 2000,
      headers: { accept: 'application/json' },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) request.destroy(new Error('health response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let value = null;
        try { value = JSON.parse(body); } catch { value = null; }
        resolve({ code: response.statusCode, value });
      });
    });
    request.on('timeout', () => request.destroy(new Error('health request timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function releaseAudit() {
  const formalLayout = await verifyFormalReleaseLayout({
    currentLink: CURRENT_LINK,
    heartbeatRoot: HEARTBEAT_ROOT,
    metadataPath: DEPLOYMENT_METADATA_PATH,
    expectedUid: 0,
  });
  const manifestPaths = verifiedManifestPathRecord(formalLayout);
  const current = await realpath(CURRENT_LINK);
  const previousText = (await regularFile(
    path.join(ROLLBACK_ROOT, 'aru', 'previous-release'), 'previous release metadata',
  )).bytes.toString('utf8').trim();
  if (!previousText.startsWith('/opt/aru-selfhost/releases/') || previousText.includes('\n')) {
    throw new Error('previous release metadata is unsafe');
  }
  const previous = await realpath(previousText);
  if (previous !== DEPLOYMENT.previousRelease) {
    throw new Error('deployment metadata previous release does not match rollback metadata');
  }
  const [currentFiles, previousFiles, baseFiles] = await Promise.all([
    inventory(current), inventory(previous), inventory(BASE_RELEASE),
  ]);
  const sourceHook = await regularFile(
    path.join(SOURCE_ROOT, 'aru-hook', 'aru-desire-turn-hook.mjs'), 'source hook',
  );
  const sourceSynthetic = await regularFile(
    path.join(SOURCE_ROOT, 'aru-hook', 'synthetic-check.mjs'), 'source synthetic check',
  );
  const previousServer = await regularFile(path.join(previous, 'server.mjs'), 'previous server');
  const currentServer = await regularFile(path.join(current, 'server.mjs'), 'current server');
  const patchedServer = Buffer.from(expectedPatchedServer(previousServer.bytes.toString('utf8')));
  const generatedChecks = {
    'aru-desire-turn-hook.mjs': currentFiles.get('aru-desire-turn-hook.mjs')?.sha256 ===
      sha256(sourceHook.bytes),
    'synthetic-check.mjs': currentFiles.get('synthetic-check.mjs')?.sha256 ===
      sha256(sourceSynthetic.bytes),
    'server.mjs': currentServer.bytes.equals(patchedServer),
    'release-manifest.json': formalLayout.current === current && formalLayout.fileCount === 31,
  };
  const inherited = [];
  const generated = [];
  const unexpectedExtra = [];
  const unexpectedChanged = [];
  const missing = [];
  for (const [relative, record] of currentFiles) {
    if (ALLOWED_GENERATED.has(relative)) {
      generated.push({ path: relative, source: 'installer-generated', normal: generatedChecks[relative] });
    } else if (!previousFiles.has(relative)) {
      unexpectedExtra.push(relative);
    } else if (previousFiles.get(relative).sha256 === record.sha256) {
      inherited.push(relative);
    } else {
      unexpectedChanged.push(relative);
    }
  }
  for (const relative of previousFiles.keys()) {
    if (!currentFiles.has(relative) && !ALLOWED_GENERATED.has(relative)) missing.push(relative);
  }
  const baselineDifferences = EXPECTED_BASELINE_DIFFERENCES.map((relative) => {
    const currentRecord = currentFiles.get(relative);
    const previousRecord = previousFiles.get(relative);
    const baseRecord = baseFiles.get(relative);
    let source = 'unexplained';
    let normal = false;
    if (currentRecord && previousRecord && currentRecord.sha256 === previousRecord.sha256) {
      source = 'inherited-from-actual-previous-release';
      normal = true;
    } else if (ALLOWED_GENERATED.has(relative) && generatedChecks[relative] === true) {
      source = 'installer-generated-from-reviewed-source';
      normal = true;
    }
    return {
      path: relative,
      differenceFromBase: !baseRecord || !currentRecord || baseRecord.sha256 !== currentRecord.sha256,
      source,
      normal,
      hash: currentRecord?.sha256.slice(0, 8) ?? null,
    };
  });
  return {
    current: {
      expected: current === EXPECTED_CURRENT,
      release: path.basename(current),
      expectedRelease: path.basename(EXPECTED_CURRENT),
    },
    rollback: {
      root: path.basename(ROLLBACK_ROOT),
      previousRelease: path.basename(previous),
      metadataPresent: true,
    },
    networkManifest: null,
    fileManifest: {
      present: true,
      currentReleasePath: manifestPaths.currentRelease,
      independentRuntimePath: manifestPaths.independentRuntime,
      heartbeatCopyPresent: true,
      copiesEqual: true,
      verified: true,
      schema: formalLayout.schema,
      version: formalLayout.version,
      entryCount: formalLayout.fileCount,
      digest: formalLayout.digest.slice(0, 8),
    },
    inventory: {
      currentFileCount: currentFiles.size,
      previousFormalFileCount: previousFiles.size,
      inheritedFormalCount: inherited.length,
      generated,
      unexpectedExtra,
      unexpectedChanged,
      missing,
      closurePassed: generated.every((item) => item.normal) &&
        unexpectedExtra.length === 0 && unexpectedChanged.length === 0 && missing.length === 0,
    },
    sevenPreviouslyObservedDifferences: baselineDifferences,
  };
}

async function runtimeAudit() {
  const verifier = await import(pathToFileURL(
    path.join(SOURCE_ROOT, 'scripts', 'verify-runtime-release.mjs'),
  ));
  const result = await verifier.verifyRuntimeRelease(SOURCE_ROOT, HEARTBEAT_ROOT);
  const keyModules = [];
  for (const relative of [
    'src/engine.mjs', 'src/runtime.mjs', 'src/timeline.mjs', 'src/pending-decision.mjs',
  ]) {
    const [source, target] = await Promise.all([
      regularFile(path.join(SOURCE_ROOT, relative), `source ${relative}`),
      regularFile(path.join(HEARTBEAT_ROOT, relative), `target ${relative}`),
    ]);
    keyModules.push({
      path: relative,
      match: source.bytes.equals(target.bytes),
      hash: sha256(target.bytes).slice(0, 8),
    });
  }
  return {
    schema: result.schema,
    version: result.version,
    fileCount: result.fileCount,
    digest: result.digest.slice(0, 8),
    keyModules,
  };
}

async function serviceAudit() {
  const installedPath = path.join(UNIT_ROOT, 'aru-desire-heartbeat.service');
  const sourcePath = path.join(SOURCE_ROOT, 'systemd', 'aru-desire-heartbeat.service');
  const [installedFile, sourceFile, installedPackage, sourcePackage] = await Promise.all([
    regularFile(installedPath, 'installed heartbeat service'),
    regularFile(sourcePath, 'source heartbeat service'),
    jsonFile(path.join(HEARTBEAT_ROOT, 'package.json'), 'installed heartbeat package'),
    jsonFile(path.join(SOURCE_ROOT, 'package.json'), 'source heartbeat package'),
  ]);
  const installed = parseUnit(installedFile.bytes.toString('utf8'));
  const source = parseUnit(sourceFile.bytes.toString('utf8'));
  const differences = unitDifferences(installed, source);
  const execStart = installed.Service?.ExecStart?.[0] ?? null;
  const entry = execStart?.split(/\s+/u).find((item) => item.endsWith('/bin/desire-cycle.mjs')) ?? null;
  const entryInfo = entry ? await lstat(entry).catch(() => null) : null;
  const serviceShows = new Map(UNITS.map((unit) => [unit, systemctlShow(unit)]));
  const services = UNITS.map((unit) => {
    const show = serviceShows.get(unit);
    return {
      unit,
      active: show.ActiveState,
      sub: show.SubState,
      enabled: show.UnitFileState,
      result: show.Result,
      restarts: Number(show.NRestarts || 0),
      activeSince: show.ActiveEnterTimestamp || null,
    };
  });
  const loadedHeartbeat = serviceShows.get('aru-desire-heartbeat.service')?.ExecStart ?? '';
  const loadedEntry = loadedHeartbeat.match(/\/?[^ ;]+\/bin\/desire-cycle\.mjs/u)?.[0] ?? null;
  return {
    byteHashEqual: installedFile.bytes.equals(sourceFile.bytes),
    semanticEqual: differences.length === 0,
    semanticDifferences: differences,
    hashDifferenceClassification: differences.length === 0
      ? 'whitespace-only-normal' : 'semantic-difference',
    execStart: {
      entry: entry ? path.relative(HEARTBEAT_ROOT, entry) : null,
      underDeployedRuntime: entry?.startsWith(`${HEARTBEAT_ROOT}/`) ?? false,
      regularFile: entryInfo?.isFile() === true && !entryInfo.isSymbolicLink(),
      installedVersion: installedPackage.version,
      sourceVersion: sourcePackage.version,
      sameVersion: installedPackage.version === sourcePackage.version,
      loadedEntry: loadedEntry ? path.relative(HEARTBEAT_ROOT, loadedEntry) : null,
      loadedEntryUnderDeployedRuntime: loadedEntry?.startsWith(`${HEARTBEAT_ROOT}/`) ?? false,
      loadedExecStartMatchesUnit: loadedEntry !== null && loadedEntry === entry,
    },
    services,
  };
}

function timelineAudit(state, config) {
  const timeline = (Array.isArray(state.timeline) ? state.timeline : [])
    .filter((entry) => entry?.at?.epochMs >= START_MS)
    .sort((left, right) => left.at.epochMs - right.at.epochMs);
  const byFingerprint = new Map();
  for (const entry of timeline) {
    if (typeof entry.decisionFingerprint !== 'string') continue;
    const list = byFingerprint.get(entry.decisionFingerprint) ?? [];
    list.push(entry);
    byFingerprint.set(entry.decisionFingerprint, list);
  }
  const repeatedSignatures = [];
  let tenMinuteIdenticalRepeats = 0;
  for (const [fingerprint, entries] of byFingerprint) {
    const signatures = new Map();
    for (const entry of entries) {
      const blockers = (entry.reasons ?? []).filter((reason) =>
        ['observe-only', 'delivery-disabled', 'delivery-adapter-disabled'].includes(reason)).sort();
      const signature = `${entry.outcome}|${blockers.join(',')}`;
      signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
    }
    for (const [signature, count] of signatures) {
      if (count > 1) repeatedSignatures.push({ fingerprint: prefix(fingerprint), signature, count });
    }
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      const same = previous.outcome === current.outcome &&
        JSON.stringify([...(previous.reasons ?? [])].sort()) ===
          JSON.stringify([...(current.reasons ?? [])].sort());
      const seconds = (current.at.epochMs - previous.at.epochMs) / 1000;
      if (same && seconds >= 540 && seconds <= 660) tenMinuteIdenticalRepeats += 1;
    }
  }
  const expiryCases = [];
  const cooldownCases = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (entry.outcome !== 'pending_expired' || !entry.decisionFingerprint) continue;
    const prior = timeline.filter((item) =>
      item.decisionFingerprint === entry.decisionFingerprint && item.at.epochMs <= entry.at.epochMs);
    const firstAt = prior.length ? prior[0].at.epochMs : null;
    const elapsedSeconds = firstAt === null ? null : (entry.at.epochMs - firstAt) / 1000;
    const logicalExpiryMs = firstAt === null ? null :
      firstAt + config.pendingDecisionTtlSeconds * 1000;
    const observationDelaySeconds = logicalExpiryMs === null ? null :
      (entry.at.epochMs - logicalExpiryMs) / 1000;
    expiryCases.push({
      fingerprint: prefix(entry.decisionFingerprint),
      firstAt: iso(firstAt),
      logicalExpiresAt: iso(logicalExpiryMs),
      expiredAt: entry.at.iso,
      elapsedSeconds,
      ttlSeconds: config.pendingDecisionTtlSeconds,
      logicalTtlIsThirtyMinutes: config.pendingDecisionTtlSeconds === 1800,
      observationDelaySeconds,
      observedByNextHeartbeat: observationDelaySeconds !== null &&
        observationDelaySeconds >= 0 &&
        observationDelaySeconds <= config.heartbeatSeconds + 90,
    });
    const next = timeline.slice(index + 1).find((item) =>
      typeof item.decisionFingerprint === 'string' &&
      item.decisionFingerprint !== entry.decisionFingerprint);
    const cooldownStartMs = logicalExpiryMs ?? entry.at.epochMs;
    const waitSeconds = next ? (next.at.epochMs - cooldownStartMs) / 1000 : null;
    cooldownCases.push({
      fingerprint: prefix(entry.decisionFingerprint),
      logicalCooldownStartedAt: iso(cooldownStartMs),
      observedExpiredAt: entry.at.iso,
      nextDecisionAt: next?.at?.iso ?? null,
      waitSeconds,
      respectedSixtyMinutes: next === undefined ||
        waitSeconds >= config.pendingDecisionCooldownSeconds - 35,
    });
  }
  const snapshots = timeline.filter((entry) => entry.drives &&
    DRIVES.every((drive) => Number.isFinite(entry.drives[drive])));
  const driveEvolution = Object.fromEntries(DRIVES.map((drive) => {
    const values = snapshots.map((entry) => entry.drives[drive]);
    if (Number.isFinite(state.drives?.[drive])) values.push(state.drives[drive]);
    return [drive, {
      observations: values.length,
      distinct: new Set(values.map((value) => value.toFixed(6))).size,
      first: values[0] ?? null,
      last: values.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      evolved: values.length > 1 && new Set(values.map((value) => value.toFixed(6))).size > 1,
    }];
  }));
  const mechanicalBoundarySnapshots = snapshots.filter((entry) => {
    const values = DRIVES.map((drive) => entry.drives[drive]);
    return values.filter((value) => value === 0).length === 4 &&
      values.filter((value) => value === 1).length === 4;
  }).length;
  const cooldownWindows = expiryCases.map((item) => ({
    start: Date.parse(item.logicalExpiresAt),
    end: Date.parse(item.logicalExpiresAt) + config.pendingDecisionCooldownSeconds * 1000,
  }));
  const forbiddenDuringCooldown = timeline.filter((entry) =>
    cooldownWindows.some((window) => entry.at.epochMs > window.start && entry.at.epochMs < window.end) &&
    ['submitted', 'solo_completed', 'delivery_failed'].includes(entry.outcome));
  return {
    entriesSinceStart: timeline.length,
    fingerprints: byFingerprint.size,
    repeatedBlockedSignatures: repeatedSignatures,
    identicalTenMinuteRepeats: tenMinuteIdenticalRepeats,
    expiryCases,
    cooldownCases,
    forbiddenOutcomesDuringCooldown: forbiddenDuringCooldown.map((entry) => ({
      at: entry.at.iso, outcome: entry.outcome, fingerprint: prefix(entry.decisionFingerprint),
    })),
    submittedCount: timeline.filter((entry) => entry.outcome === 'submitted').length,
    deliveryFailedCount: timeline.filter((entry) => entry.outcome === 'delivery_failed').length,
    mechanicalFourZeroFourOneSnapshots: mechanicalBoundarySnapshots,
    driveEvolution,
  };
}

function ledgerAudit(state, interaction) {
  const desireChat = Array.isArray(state.appliedChatEventIds) ? state.appliedChatEventIds : [];
  const effects = Array.isArray(state.appliedEffectIds) ? state.appliedEffectIds : [];
  const chatRecords = Array.isArray(interaction?.chat?.processedEvents)
    ? interaction.chat.processedEvents : [];
  const arousalEvents = Array.isArray(interaction?.arousal?.processedEvents)
    ? interaction.arousal.processedEvents : [];
  const chatIds = chatRecords.map((record) => record.eventId);
  const allIds = sortedUnique([...desireChat, ...chatIds, ...arousalEvents]);
  const events = allIds.map((eventId) => {
    const record = chatRecords.find((item) => item.eventId === eventId);
    const labels = Array.isArray(record?.labels) ? record.labels : [];
    return {
      fingerprint: prefix(eventId),
      at: record?.at?.iso ?? null,
      statusTypes: Array.isArray(record?.types) ? record.types : [],
      classifications: labels.filter((item) => SAFE_EVENT_LABELS.has(item)),
      unknownClassificationCount: labels.filter((item) => !SAFE_EVENT_LABELS.has(item)).length,
      desireLedgerCount: desireChat.filter((item) => item === eventId).length,
      chatLedgerCount: chatIds.filter((item) => item === eventId).length,
      arousalLedgerCount: arousalEvents.filter((item) => item === eventId).length,
    };
  });
  const activationEnd = START_MS + 180_000;
  const activationLike = events.filter((event) => {
    const at = Date.parse(event.at ?? '');
    return Number.isFinite(at) && at >= START_MS && at <= activationEnd &&
      event.classifications.includes('no_op');
  });
  const duplicateCount = (values) => values.length - new Set(values).size;
  const pendingReceipt = interaction?.arousal?.pendingReleaseReceipt ?? null;
  return {
    counts: {
      desireChat: desireChat.length,
      effects: effects.length,
      chat: chatIds.length,
      arousal: arousalEvents.length,
      chatPending: interaction?.chat?.pending?.length ?? null,
    },
    duplicateEntries: {
      desireChat: duplicateCount(desireChat),
      effects: duplicateCount(effects),
      chat: duplicateCount(chatIds),
      arousal: duplicateCount(arousalEvents),
    },
    events,
    activationWindow: {
      start: START_ISO,
      end: iso(activationEnd),
      eventCount: activationLike.length,
      fingerprints: activationLike.map((event) => event.fingerprint),
      exactlyTwoDistinctEventsAppliedOnce: activationLike.length === 2 &&
        activationLike.every((event) => event.desireLedgerCount === 1 &&
          event.chatLedgerCount === 1 && event.arousalLedgerCount === 1),
    },
    pendingReleaseReceipt: pendingReceipt === null ? null : {
      receipt: prefix(pendingReceipt.receiptId),
      event: prefix(pendingReceipt.eventId),
      effect: prefix(pendingReceipt.effectId),
      delivered: pendingReceipt.delivered === true,
      createdAt: pendingReceipt.createdAt?.iso ?? null,
    },
  };
}

function journalAudit() {
  const categories = [
    ['module_not_found', /MODULE_NOT_FOUND/iu],
    ['syntax_error', /SyntaxError/iu],
    ['permission_error', /(?:EACCES|EPERM|permission denied)/iu],
    ['request_rejected', /(?:unauthorized|forbidden|request rejected|HTTP 40[13])/iu],
    ['restart_loop', /(?:Scheduled restart job|restart counter|Start request repeated too quickly)/iu],
    ['delivery_failure', /(?:delivery_failed|delivery-failed)/iu],
  ];
  const result = {};
  for (const unit of UNITS) {
    const raw = runReadOnly('/usr/bin/journalctl', [
      '-u', unit, '--since', '2026-09-26 21:51:00', '--no-pager', '-o', 'json',
    ]);
    const rows = raw.split(/\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const errors = Object.fromEntries(categories.map(([name, pattern]) => {
      const matches = rows.filter((row) => pattern.test(String(row.MESSAGE ?? '')));
      return [name, {
        count: matches.length,
        firstAt: matches[0] ? iso(Number(matches[0].__REALTIME_TIMESTAMP) / 1000) : null,
        lastAt: matches.at(-1) ? iso(Number(matches.at(-1).__REALTIME_TIMESTAMP) / 1000) : null,
      }];
    }));
    const cycles = [];
    for (const row of rows) {
      try {
        const value = JSON.parse(String(row.MESSAGE ?? ''));
        if (value.schema !== 'aru.desire-heartbeat.cycle-result.v1') continue;
        cycles.push({
          at: iso(Number(row.__REALTIME_TIMESTAMP) / 1000),
          status: SAFE_HEARTBEAT_STATUSES.has(value.status) ? value.status : 'unknown',
          intent: value.intent === null || SAFE_INTENTS.has(value.intent) ? value.intent : 'unknown',
          decision: value.decisionId === null ? null : prefix(value.decisionId),
          elapsedSeconds: Number.isFinite(value.elapsedSeconds) ? value.elapsedSeconds : null,
        });
      } catch {
        // Non-JSON service messages are counted only by fixed error classifiers.
      }
    }
    result[unit] = {
      entryCount: rows.length,
      errors,
      heartbeatCycles: cycles,
      cycleStatusCounts: Object.fromEntries(sortedUnique(cycles.map((item) => item.status))
        .map((status) => [status, cycles.filter((item) => item.status === status).length])),
      unexpectedSubmittedCycles: cycles.filter((item) => item.status === 'submitted').length,
    };
  }
  return result;
}

async function stateAudit() {
  const [config, state, interaction] = await Promise.all([
    jsonFile(path.join(HEARTBEAT_ROOT, 'config', 'default.json'), 'production config'),
    jsonFile(path.join(DATA_ROOT, 'state.json'), 'production state'),
    jsonFile(path.join(DATA_ROOT, 'interaction-state.json'), 'interaction state'),
  ]);
  const schemaModule = await import(pathToFileURL(path.join(HEARTBEAT_ROOT, 'src', 'schema.mjs')));
  const interactionModule = await import(pathToFileURL(
    path.join(HEARTBEAT_ROOT, 'src', 'interaction-runtime.mjs'),
  ));
  schemaModule.validateConfig(config);
  schemaModule.validateState(state, config);
  interactionModule.validateInteractionState(interaction, config);
  return {
    config: {
      schema: config.schema,
      version: config.version,
      heartbeatSeconds: config.heartbeatSeconds,
      gates: {
        observeOnly: config.observeOnly,
        deliveryEnabled: config.deliveryEnabled,
        chatStimulusEnabled: config.chatStimulusEnabled,
        arousalEnabled: config.arousalEnabled,
        arousalDriveSettlementEnabled: config.arousalDriveSettlementEnabled,
        soloSessionsEnabled: config.soloSessionsEnabled,
      },
      pendingDecisionTtlSeconds: config.pendingDecisionTtlSeconds,
      pendingDecisionCooldownSeconds: config.pendingDecisionCooldownSeconds,
    },
    state: {
      schema: state.schema,
      version: state.version,
      sequence: state.sequence,
      updatedAt: state.updatedAt?.iso ?? null,
      lastTickAt: state.lastTickAt?.iso ?? null,
      pending: state.pendingDecision === null ? null : {
        fingerprint: prefix(state.pendingDecision.fingerprint),
        drive: state.pendingDecision.drive,
        intent: state.pendingDecision.intent,
        createdAt: state.pendingDecision.createdAt?.iso ?? null,
        expiresAt: state.pendingDecision.expiresAt?.iso ?? null,
        status: state.pendingDecision.status,
        blockers: state.pendingDecision.deliveryBlockers.filter((item) => SAFE_BLOCKERS.has(item)),
        unknownBlockerCount: state.pendingDecision.deliveryBlockers.filter(
          (item) => !SAFE_BLOCKERS.has(item),
        ).length,
      },
      pendingCooldownUntil: state.pendingCooldownUntil?.iso ?? null,
      lastSatisfiedAt: Object.fromEntries(DRIVES.map((drive) => [
        drive, state.lastSatisfiedAt?.[drive]?.iso ?? null,
      ])),
      drives: state.drives,
    },
    timeline: timelineAudit(state, config),
    ledger: ledgerAudit(state, interaction),
  };
}

async function healthAudit() {
  const [manifest, diagnostics, bridge, dashboard, receiver] = await Promise.all([
    getJson(8788, '/.well-known/aru.json'),
    getJson(8788, '/aru/v1/diagnostics'),
    getJson(18110, '/health'),
    getJson(18760, '/healthz'),
    getJson(18761, '/healthz'),
  ]);
  return {
    aruManifest: {
      code: manifest.code,
      schema: typeof manifest.value?.schema === 'string' &&
        /^[a-z0-9._-]{1,80}$/iu.test(manifest.value.schema) ? manifest.value.schema : null,
      serverVersion: typeof manifest.value?.serverVersion === 'string' &&
        /^[a-z0-9._-]{1,40}$/iu.test(manifest.value.serverVersion)
        ? manifest.value.serverVersion : null,
      transportKinds: Array.isArray(manifest.value?.transports)
        ? manifest.value.transports.map((item) => item.kind).filter((item) =>
          typeof item === 'string' && /^[a-z0-9._-]{1,40}$/iu.test(item))
        : [],
    },
    aruDiagnostics: {
      code: diagnostics.code,
      deviceCount: diagnostics.value?.deviceCount ?? null,
      readyAgentDriverCount: diagnostics.value?.readyAgentDriverCount ?? null,
      serverVersion: typeof diagnostics.value?.serverVersion === 'string' &&
        /^[a-z0-9._-]{1,40}$/iu.test(diagnostics.value.serverVersion)
        ? diagnostics.value.serverVersion : null,
      hook: diagnostics.value?.desireTurnHook ? {
        sent: diagnostics.value.desireTurnHook.sent_count ?? null,
        duplicates: diagnostics.value.desireTurnHook.duplicate_count ?? null,
        rejected: diagnostics.value.desireTurnHook.rejected_count ?? null,
        timeouts: diagnostics.value.desireTurnHook.timeout_count ?? null,
      } : null,
    },
    bridge: {
      code: bridge.code,
      status: ['ok', 'healthy', 'ready'].includes(bridge.value?.status)
        ? bridge.value.status : bridge.code === 200 ? 'ok' : 'unknown',
    },
    dashboard: {
      code: dashboard.code,
      status: ['ok', 'healthy', 'ready'].includes(dashboard.value?.status)
        ? dashboard.value.status : dashboard.code === 200 ? 'ok' : 'unknown',
    },
    receiver: {
      code: receiver.code,
      status: ['ok', 'healthy', 'ready'].includes(receiver.value?.status)
        ? receiver.value.status : receiver.code === 200 ? 'ok' : 'unknown',
      accepted: receiver.value?.accepted_count ?? null,
      duplicates: receiver.value?.duplicate_count ?? null,
      rejected: receiver.value?.rejected_count ?? null,
      lastSuccessAt: Number.isFinite(receiver.value?.last_success_at)
        ? iso(receiver.value.last_success_at) : null,
      lastErrorCategory: receiver.value?.last_error_category === null
        ? null : SAFE_RECEIVER_ERRORS.has(receiver.value?.last_error_category)
          ? receiver.value.last_error_category : 'unknown',
    },
  };
}

function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    /Bearer\s+[A-Za-z0-9._~-]+/iu,
    /aru:\/\/pair/iu,
    /Authorization/iu,
    /pairingToken/iu,
    /(?:token|password|private[_ -]?key|cookie|credential|secret)["'=:\s]+[A-Za-z0-9_./+~-]{12,}/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error('sanitization guard blocked audit output');
  }
}

try {
  const [release, runtime, service, state, journal, health] = await Promise.all([
    releaseAudit(), runtimeAudit(), serviceAudit(), stateAudit(),
    Promise.resolve().then(journalAudit), healthAudit(),
  ]);
  release.networkManifest = health.aruManifest;
  const report = {
    schema: 'aru.production-readonly-audit.v1',
    generatedAt: new Date().toISOString(),
    auditStart: START_ISO,
    strictlyReadOnly: true,
    release,
    runtime,
    service,
    health,
    state,
    journal,
  };
  assertSanitized(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('AUDIT_BLOCKED: read-only audit could not complete safely\n');
  process.exitCode = 1;
}
