import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addThought,
  adjustDrive,
  chooseLibidoIntent,
  createInitialState,
  decideState,
  feedDrive,
  pickIntent,
  rebaseClock,
  satisfyDecision,
  satisfySoloDecision,
  sentinel,
  selfDriveFactor,
  simulateAutonomy,
  simulateState,
  setDrive,
  tickState,
  timePair,
} from '../src/engine.mjs';
import { DRIVES } from '../src/constants.mjs';
import { run as runCli } from '../src/cli.mjs';
import { acquireLock, ensureSecureDirectory, releaseLock } from '../src/security.mjs';
import { atomicSaveState, initializeState, loadConfig, loadState } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'default.json');
const NOW = Date.parse('2026-09-10T04:00:00.000Z');
const config = await loadConfig(CONFIG_PATH);
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function secureTemp() {
  const directory = await mkdtemp(path.join(tmpdir(), 'desire-heartbeat-test-'));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function stateWith(values = {}) {
  const state = createInitialState(config, NOW);
  Object.assign(state.drives, values);
  return state;
}

function thought(state, values) {
  const at = timePair(NOW);
  state.thoughts.push({
    id: `thought-${NOW}-${state.thoughts.length + 1}`,
    drive: 'curiosity', type: 'flit', intensity: 0.5, fedCount: 0,
    text: 'safe thought', createdAt: at, updatedAt: at, ...values,
  });
  return state;
}

test('self-drive variation is bounded and reproducible', () => {
  const first = selfDriveFactor(NOW, config.heartbeatSeconds, 'attachment', config.selfDriveVariation);
  const replay = selfDriveFactor(NOW, config.heartbeatSeconds, 'attachment', config.selfDriveVariation);
  assert.equal(first, replay);
  assert.ok(first >= 1 - config.selfDriveVariation);
  assert.ok(first <= 1 + config.selfDriveVariation);
});

test('reaching the threshold permits an autonomous action decision', () => {
  const expressive = structuredClone(config);
  expressive.expression.baseWillingness = 1;
  const atThreshold = stateWith({ attachment: config.triggerThreshold, fatigue: 0.10 });
  const result = decideState(atThreshold, expressive, NOW);
  assert.ok(result.decision);
  assert.equal(result.decision.drive, 'attachment');
  assert.equal(result.decision.intent, 'reach_owner');
  assert.equal(result.expression.expressed, true);
  assert.equal(result.state.drives.attachment, config.triggerThreshold);
});

test('remaining below threshold does not form a decision', () => {
  const state = stateWith({ attachment: config.triggerThreshold - 0.01, fatigue: 0.10 });
  const result = decideState(state, config, NOW);
  assert.equal(result.decision, null);
  assert.ok(result.sentinel.formationBlockers.includes('below-trigger-threshold'));
});

test('libido deterministically chooses exactly one real outlet', () => {
  const soloConfig = structuredClone(config);
  soloConfig.expression.baseWillingness = 1;
  soloConfig.solo.basePreference = 1;
  soloConfig.solo.libidoOverAttachmentWeight = 0;
  soloConfig.solo.afterContactBonus = 0;
  soloConfig.solo.afterSoloPenalty = 0;
  soloConfig.solo.fatigueWeight = 0;
  const state = stateWith({ libido: 0.95, attachment: 0.20, fatigue: 0.10 });
  const first = chooseLibidoIntent(state, soloConfig, NOW);
  const replay = chooseLibidoIntent(state, soloConfig, NOW);
  assert.deepEqual(first, replay);
  assert.equal(first.intent, 'solo');
  const result = decideState(state, soloConfig, NOW);
  assert.equal(result.decision.intent, 'solo');
  assert.equal(result.decision.deliveryBlockers.length, 0);
});

test('solo satisfaction is proportional, counted, and cooled down', () => {
  const soloConfig = structuredClone(config);
  soloConfig.expression.baseWillingness = 1;
  soloConfig.solo.basePreference = 1;
  soloConfig.solo.libidoOverAttachmentWeight = 0;
  soloConfig.solo.afterContactBonus = 0;
  soloConfig.solo.afterSoloPenalty = 0;
  soloConfig.solo.fatigueWeight = 0;
  const result = tickState(
    stateWith({ libido: 0.95, attachment: 0.20, fatigue: 0.10 }),
    soloConfig,
    NOW,
  );
  assert.equal(result.state.thoughts[0].source, 'automatic');
  const thoughtBefore = result.state.thoughts[0].intensity;
  const satisfied = satisfySoloDecision(
    result.state, soloConfig, result.decision.id, NOW + 1,
  );
  assert.ok(Math.abs(satisfied.drives.libido - 0.95 * 0.38) < 1e-12);
  assert.equal(satisfied.thoughts[0].type, 'flit');
  assert.ok(Math.abs(
    satisfied.thoughts[0].intensity -
      thoughtBefore * soloConfig.thoughts.actionCarryoverFactor,
  ) < 1e-12);
  assert.equal(satisfied.drives.attachment, 0.20);
  assert.equal(satisfied.solo.count, 1);
  assert.equal(satisfied.solo.lastLibidoChoice, 'solo');
  assert.equal(satisfied.solo.refractoryUntil.epochMs, NOW + 1 + 10_800_000);
  assert.equal(satisfied.pendingDecision, null);
  const cooled = chooseLibidoIntent(satisfied, soloConfig, NOW + 2);
  assert.equal(cooled.intent, 'seek_closeness');
  assert.equal(cooled.soloEligible, false);
});

test('only self-driven needs rise without an event', () => {
  const state = stateWith({
    reflection: 0.50,
    duty: 0.40,
    fatigue: 0.40,
    stress: 0.60,
  });
  const next = tickState(state, config, NOW + 3_600_000).state;
  for (const drive of ['attachment', 'curiosity', 'social', 'libido']) {
    assert.ok(next.drives[drive] > state.drives[drive], `${drive} should self-drive`);
  }
  for (const drive of ['reflection', 'duty', 'fatigue', 'stress']) {
    assert.ok(next.drives[drive] < state.drives[drive], `${drive} should settle`);
    assert.ok(next.drives[drive] >= 0);
  }
  for (const drive of DRIVES) assert.equal(config.driveHomeLevels[drive], 0);
  assert.equal(config.driveGrowthPerHour.reflection, 0);
  assert.equal(config.driveGrowthPerHour.duty, 0);
  assert.equal(config.driveGrowthPerHour.stress, 0);
});

test('event-driven needs do not rise from rest without an event', () => {
  const state = stateWith({ reflection: 0, duty: 0, stress: 0 });
  const next = tickState(state, config, NOW + 3_600_000).state;
  assert.equal(next.drives.reflection, 0);
  assert.equal(next.drives.duty, 0);
  assert.equal(next.drives.stress, 0);
  const fed = feedDrive(next, config, 'reflection', 0.40, NOW + 3_600_001);
  const settled = tickState(fed, config, NOW + 7_200_001).state;
  assert.ok(settled.drives.reflection > 0);
  assert.ok(settled.drives.reflection < fed.drives.reflection);
});

test('all eight drives are clamped to 0..1', () => {
  let state = stateWith(Object.fromEntries(DRIVES.map((drive) => [drive, 0.99])));
  state = tickState(state, config, NOW + 86_400_000).state;
  state = feedDrive(state, config, 'attachment', 1, NOW + 86_400_001);
  for (const drive of DRIVES) assert.ok(state.drives[drive] >= 0 && state.drives[drive] <= 1);
});

test('a drive at 55% creates one allowlisted automatic flit', () => {
  const state = stateWith({ curiosity: config.thoughts.autoCreateAbove });
  const next = tickState(state, config, NOW).state;
  assert.equal(next.thoughts.length, 1);
  assert.equal(next.thoughts[0].drive, 'curiosity');
  assert.equal(next.thoughts[0].type, 'flit');
  assert.equal(next.thoughts[0].source, 'automatic');
  assert.equal(next.thoughts[0].text, '想看看新的东西，再来与你分享');
  assert.equal(next.thoughts[0].intensity, config.thoughts.autoCreateAbove);
});

test('automatic thoughts reinforce without duplication and become fixations at 80%', () => {
  const state = stateWith({ attachment: 0.60 });
  const formed = tickState(state, config, NOW).state;
  const id = formed.thoughts[0].id;
  formed.drives.attachment = 0.70;
  const reinforced = tickState(formed, config, NOW + 1).state;
  assert.equal(reinforced.thoughts.length, 1);
  assert.equal(reinforced.thoughts[0].id, id);
  assert.ok(reinforced.thoughts[0].intensity >= 0.72);
  assert.ok(reinforced.thoughts[0].intensity < 0.721);
  reinforced.drives.attachment = 0.80;
  const fixed = tickState(reinforced, config, NOW + 2).state;
  assert.equal(fixed.thoughts.length, 1);
  assert.equal(fixed.thoughts[0].id, id);
  assert.equal(fixed.thoughts[0].type, 'fixation');
  assert.ok(fixed.thoughts[0].intensity >= 0.80);
});

test('thoughts decay when their drive falls and never feed the drive', () => {
  const state = stateWith({ curiosity: 0.20 });
  thought(state, { type: 'fixation', intensity: 0.90, fedCount: 2 });
  state.thoughts[0].source = 'automatic';
  const next = tickState(state, config, NOW).state;
  assert.equal(next.drives.curiosity, 0.20);
  assert.equal(next.thoughts[0].type, 'fixation');
  assert.ok(Math.abs(next.thoughts[0].intensity - 0.828) < 1e-12);
  next.drives.curiosity = 0;
  let settled = next;
  for (let index = 1; index <= 20; index += 1) {
    settled = tickState(settled, config, NOW + index).state;
  }
  assert.ok(settled.drives.curiosity < 0.001);
  assert.equal(settled.thoughts.length, 0);
});

test('successful expression proportionally weakens its automatic thought', () => {
  const expressive = structuredClone(config);
  expressive.expression.baseWillingness = 1;
  const formed = tickState(
    stateWith({ attachment: 0.80, fatigue: 0.10 }),
    expressive,
    NOW,
  );
  assert.equal(formed.state.thoughts[0].type, 'fixation');
  const before = formed.state.thoughts[0].intensity;
  const satisfied = satisfyDecision(formed.state, expressive, formed.decision.id, NOW + 1);
  assert.equal(satisfied.thoughts.length, 1);
  assert.equal(satisfied.thoughts[0].type, 'flit');
  assert.ok(Math.abs(
    satisfied.thoughts[0].intensity - before * config.thoughts.actionCarryoverFactor,
  ) < 1e-12);
});

test('fatigue gate blocks decision formation', () => {
  const state = stateWith({ attachment: 0.95, fatigue: config.fatigueGate });
  const result = decideState(state, config, NOW);
  assert.equal(result.decision, null);
  assert.ok(result.sentinel.formationBlockers.includes('fatigue-gate'));
});

test('pending decision prevents duplicates', () => {
  const first = decideState(stateWith({ attachment: 0.95, fatigue: 0.1 }), config, NOW);
  const second = decideState(first.state, config, NOW + 1);
  assert.ok(first.decision);
  assert.equal(second.decision, null);
  assert.ok(second.sentinel.formationBlockers.includes('pending-decision'));
});

test('pickIntent selects the highest mapped non-fatigue drive', () => {
  const drives = stateWith({ fatigue: 1, social: 0.8, libido: 0.9 }).drives;
  assert.deepEqual(pickIntent(drives), { drive: 'libido', intent: 'seek_closeness', score: 0.9 });
});

test('satisfy lowers desire proportionally without resetting it', () => {
  const decided = decideState(stateWith({ attachment: 0.95, curiosity: 0.20, fatigue: 0.1 }), config, NOW);
  assert.throws(() => satisfyDecision(decided.state, config, 'decision-0-0', NOW + 1), /does not match/);
  const satisfied = satisfyDecision(decided.state, config, decided.decision.id, NOW + 1);
  assert.equal(satisfied.pendingDecision, null);
  assert.ok(Math.abs(satisfied.drives.attachment - 0.5225) < 1e-12);
  assert.ok(Math.abs(satisfied.drives.curiosity - 0.14) < 1e-12);
  assert.ok(satisfied.drives.attachment > 0);
  assert.equal(satisfied.lastSatisfiedAt.attachment.epochMs, NOW + 1);
});

test('thought-add stores text as data and validates controls', () => {
  const state = addThought(stateWith(), config, {
    drive: 'reflection', type: 'flit', intensity: 0.4, text: '$(touch /tmp/never-run); `id`',
  }, NOW + 1);
  assert.equal(state.thoughts[0].text, '$(touch /tmp/never-run); `id`');
  assert.equal(state.thoughts[0].source, 'manual');
  assert.throws(() => addThought(state, config, {
    drive: 'reflection', type: 'flit', intensity: 0.4, text: 'bad\ntext',
  }, NOW + 2));
});

test('clock rebase changes only time and sequence and rejects pending decisions', () => {
  const state = stateWith({ attachment: 0.42, libido: 0.61 });
  thought(state, {
    id: `thought-${NOW}-1`,
    drive: 'libido',
    text: 'private thought remains unchanged',
  });
  state.timeline.push({
    at: timePair(NOW),
    nextCheckAt: timePair(NOW + 600_000),
    outcome: 'idle',
    drive: null,
    intent: null,
    score: null,
    willingness: null,
    reasons: ['below-trigger-threshold'],
    drives: structuredClone(state.drives),
  });
  const before = structuredClone(state);
  const rebased = rebaseClock(state, config, NOW + 43_200_000);
  assert.deepEqual(rebased.drives, before.drives);
  assert.deepEqual(rebased.thoughts, before.thoughts);
  assert.deepEqual(rebased.timeline, before.timeline);
  assert.deepEqual(rebased.lastSatisfiedAt, before.lastSatisfiedAt);
  assert.equal(rebased.sequence, before.sequence + 1);
  assert.equal(rebased.lastTickAt.epochMs, NOW + 43_200_000);
  assert.equal(rebased.updatedAt.epochMs, NOW + 43_200_000);
  assert.deepEqual(state, before);

  const decided = decideState(
    stateWith({ attachment: 0.95, fatigue: 0.1 }),
    config,
    NOW,
  );
  assert.throws(
    () => rebaseClock(decided.state, config, NOW + 1),
    (error) => error.code === 'PENDING_DECISION',
  );
});

test('single-drive management changes only the requested drive', () => {
  const original = stateWith({ attachment: 0.20, libido: 0.30 });
  const set = setDrive(original, config, 'attachment', 0.65, NOW + 1);
  assert.equal(set.drives.attachment, 0.65);
  assert.equal(set.drives.libido, 0.30);
  assert.equal(original.drives.attachment, 0.20);

  const raised = adjustDrive(set, config, 'libido', 0.15, NOW + 2);
  assert.equal(raised.drives.libido, 0.45);
  assert.equal(raised.drives.attachment, 0.65);

  const clamped = adjustDrive(raised, config, 'libido', -1, NOW + 3);
  assert.equal(clamped.drives.libido, 0);
  assert.throws(() => setDrive(original, config, 'attachment', 1.01, NOW + 1));
  assert.throws(() => adjustDrive(original, config, 'attachment', 0, NOW + 1));
});

test('drive management refuses to rewrite state with a pending decision', () => {
  const decided = decideState(stateWith({ attachment: 0.95, fatigue: 0.1 }), config, NOW);
  assert.ok(decided.state.pendingDecision);
  assert.throws(
    () => setDrive(decided.state, config, 'attachment', 0.2, NOW + 1),
    (error) => error.code === 'PENDING_DECISION',
  );
});

test('CLI accepts user-facing percentages and saves atomically', async () => {
  const directory = await secureTemp();
  await initializeState(directory, createInitialState(config, NOW), config);
  const output = [];
  const io = { log: (line) => output.push(JSON.parse(line)) };
  await runCli([
    'set-drive', '--config', CONFIG_PATH, '--data-dir', directory,
    '--drive', 'attachment', '--value', '65',
  ], io);
  await runCli([
    'adjust-drive', '--config', CONFIG_PATH, '--data-dir', directory,
    '--drive', 'attachment', '--delta', '-15',
  ], io);
  const saved = await loadState(directory, config);
  assert.equal(saved.drives.attachment, 0.50);
  assert.equal(saved.drives.curiosity, config.initialDrives.curiosity);
  assert.equal(output[0].previousPercent, config.initialDrives.attachment * 100);
  assert.equal(output[0].currentPercent, 65);
  assert.equal(output[1].requestedDeltaPercent, -15);
  assert.equal(output[1].currentPercent, 50);
  await assert.rejects(runCli([
    'set-drive', '--config', CONFIG_PATH, '--data-dir', directory,
    '--drive', 'attachment', '--value', '101',
  ], io));
});

test('loading a legacy state adds empty solo and expression state in memory', async () => {
  const directory = await secureTemp();
  const legacy = createInitialState(config, NOW);
  delete legacy.solo;
  delete legacy.expression;
  await writeFile(
    path.join(directory, 'state.json'),
    JSON.stringify(legacy) + '\n',
    { mode: 0o600 },
  );
  const loaded = await loadState(directory, config);
  assert.deepEqual(loaded.solo, {
    count: 0,
    lastSoloAt: null,
    refractoryUntil: null,
    lastLibidoChoice: null,
  });
  assert.deepEqual(loaded.expression, { consecutiveWithholds: 0 });
  assert.deepEqual(loaded.drives, legacy.drives);
  assert.equal(loaded.sequence, legacy.sequence);
});

test('atomic save produces a 0600 state and leaves no temporary file', async () => {
  const directory = await secureTemp();
  const state = createInitialState(config, NOW);
  await initializeState(directory, state, config);
  const next = feedDrive(state, config, 'duty', 0.1, NOW + 1);
  await atomicSaveState(directory, next, config);
  const info = await import('node:fs/promises').then(({ stat }) => stat(path.join(directory, 'state.json')));
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual(await loadState(directory, config), next);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.tmp')), []);
});

test('explicit initialization never overwrites an existing state', async () => {
  const directory = await secureTemp();
  const state = createInitialState(config, NOW);
  await initializeState(directory, state, config);
  const statePath = path.join(directory, 'state.json');
  const before = await readFile(statePath);
  await assert.rejects(initializeState(directory, createInitialState(config, NOW + 1), config),
    (error) => error.code === 'ALREADY_INITIALIZED');
  assert.deepEqual(await readFile(statePath), before);
});

test('corrupt state is rejected without replacement', async () => {
  const directory = await secureTemp();
  const statePath = path.join(directory, 'state.json');
  await writeFile(statePath, '{broken', { mode: 0o600 });
  const before = await readFile(statePath, 'utf8');
  await assert.rejects(loadState(directory, config), (error) => error.code === 'STATE_CORRUPT');
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('symbolic-link data directories and state files are rejected', async () => {
  const parent = await secureTemp();
  const real = path.join(parent, 'real');
  const linked = path.join(parent, 'linked');
  await mkdir(real, { mode: 0o700 });
  await symlink(real, linked);
  await assert.rejects(ensureSecureDirectory(linked), (error) => error.code === 'UNSAFE_DATA_DIRECTORY');
  await symlink(path.join(parent, 'missing-target'), path.join(real, 'state.json'));
  await assert.rejects(loadState(real, config), (error) => error.code === 'UNSAFE_STATE_FILE');
});

test('exclusive lock rejects a concurrent holder', async () => {
  const directory = await secureTemp();
  const lock = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), (error) => error.code === 'LOCKED');
  await releaseLock(lock);
});

test('a secure lock owned by a dead process is recovered once', async () => {
  const directory = await secureTemp();
  const lockPath = path.join(directory, 'heartbeat.lock');
  await writeFile(lockPath, `${JSON.stringify({ pid: 2147483647, acquiredAt: NOW })}\n`, { mode: 0o600 });
  const lock = await acquireLock(directory);
  assert.equal(lock.lockPath, lockPath);
  await releaseLock(lock);
  assert.equal((await readdir(directory)).includes('heartbeat.lock'), false);
});

test('simulate is repeatable and does not modify persistent state', async () => {
  const directory = await secureTemp();
  const state = stateWith({ curiosity: 0.7 });
  await initializeState(directory, state, config);
  const statePath = path.join(directory, 'state.json');
  const before = await readFile(statePath);
  const first = simulateState(await loadState(directory, config), config, 4);
  const second = simulateState(await loadState(directory, config), config, 4);
  assert.deepEqual(first, second);
  assert.deepEqual(await readFile(statePath), before);
});

test('autonomy simulation satisfies contacts and keeps evolving', () => {
  const result = simulateAutonomy(stateWith(), config, 14 * 24 * 6);
  assert.ok(result.contacts.length > 0);
  assert.equal(result.state.pendingDecision, null);
  for (const contact of result.contacts) {
    assert.ok(['reach_owner', 'seek_closeness', 'share', 'confide'].includes(contact.intent));
  }
});

test('observe-only decisions are pending and can never deliver', () => {
  const result = decideState(stateWith({ libido: 0.95, fatigue: 0.1 }), config, NOW);
  assert.equal(config.observeOnly, true);
  assert.equal(config.deliveryEnabled, false);
  assert.equal(result.sentinel.canDeliver, false);
  assert.equal(result.decision.status, 'pending');
  assert.equal(result.decision.deliverySuppressed, true);
  assert.equal(result.decision.delivered, false);
});

test('explicit live flags permit a pending decision to be delivered', () => {
  const liveConfig = structuredClone(config);
  liveConfig.observeOnly = false;
  liveConfig.deliveryEnabled = true;
  const result = decideState(stateWith({ libido: 0.95, fatigue: 0.1 }), liveConfig, NOW);
  assert.equal(result.sentinel.canDeliver, true);
  assert.deepEqual(result.sentinel.deliveryBlockers, []);
  assert.equal(result.decision.deliverySuppressed, false);
});

test('backwards clock movement fails closed without mutating input', () => {
  const state = stateWith({ attachment: 0.95 });
  const before = structuredClone(state);
  assert.throws(() => tickState(state, config, NOW - 60_000),
    (error) => error.code === 'CLOCK_ANOMALY');
  assert.deepEqual(state, before);
});

test('installer makes the staged application root traversable by the service account', async () => {
  const installer = await readFile(path.join(ROOT, 'scripts', 'install-once.sh'), 'utf8');
  assert.match(installer,
    /STAGE="\$\(mktemp[^\n]+\)"\nchown root:root "\$STAGE"\nchmod 0755 "\$STAGE"/u);
});

test('upgrade scripts fail closed and preserve the production data boundary', async () => {
  const upgrade = await readFile(path.join(ROOT, 'scripts', 'upgrade-once.sh'), 'utf8');
  const rollback = await readFile(path.join(ROOT, 'scripts', 'rollback-upgrade.sh'), 'utf8');
  assert.match(upgrade, /timer must be disabled/u);
  assert.match(upgrade, /service must be inactive/u);
  assert.match(upgrade, /production state changed during upgrade/u);
  assert.match(upgrade, /production credential changed during upgrade/u);
  assert.match(upgrade, /systemd service changed during upgrade/u);
  assert.match(upgrade, /systemd timer changed during upgrade/u);
  assert.match(upgrade, /systemctl daemon-reload/u);
  assert.match(upgrade, /trap restore_failed_upgrade EXIT ERR INT TERM/u);
  assert.match(rollback, /trap restore_failed_rollback EXIT ERR INT TERM/u);
  assert.match(rollback, /original-service/u);
  assert.match(rollback, /original-timer/u);
  assert.match(rollback, /systemctl daemon-reload/u);
  assert.doesNotMatch(upgrade, /systemctl\s+(?:enable|start|restart)\b/u);
  assert.doesNotMatch(rollback, /systemctl\s+(?:enable|start|restart)\b/u);
});

test('runtime source contains no process launch, Codex call, or network client', async () => {
  const sourceDirectory = path.join(ROOT, 'src');
  const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith('.mjs'));
  const sources = await Promise.all(files.map((name) => readFile(path.join(sourceDirectory, name), 'utf8')));
  sources.push(await readFile(path.join(ROOT, 'bin', 'desire-heartbeat.mjs'), 'utf8'));
  const source = sources.join('\n');
  assert.doesNotMatch(source, /node:child_process|\bexec(File|Sync)?\s*\(|\bspawn(Sync)?\s*\(/u);
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|\bcurl\b|\bwget\b/u);
  assert.doesNotMatch(source, /\/var\/lib\/aru-selfhost|\.codex\/auth|state\.json.*aru-selfhost/u);
});
