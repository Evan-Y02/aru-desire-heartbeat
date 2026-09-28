import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState,
  decideState,
  tickState,
} from '../src/engine.mjs';
import {
  createInteractionState,
  processPersistedMessage,
} from '../src/interaction-runtime.mjs';
import {
  initializeInteractionState,
  loadInteractionState,
} from '../src/interaction-storage.mjs';
import {
  initializeState,
  loadConfig,
  loadState,
} from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const START = Date.parse('2026-09-28T00:00:00.000Z');
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function enabledConfig() {
  const config = structuredClone(baseConfig);
  config.chatStimulusEnabled = true;
  return config;
}

function setup(config = enabledConfig()) {
  return {
    config,
    desireState: createInitialState(config, START),
    interactionState: createInteractionState(START),
  };
}

function message(content, id, at, values = {}) {
  return {
    source: 'synthetic-test',
    conversationId: 'cause-conversation',
    providerMessageId: id,
    role: 'user',
    status: 'complete',
    persisted: true,
    final: true,
    cancelled: false,
    content,
    completedAt: at,
    ...values,
  };
}

function process(state, content, id, at = START + 1, values = {}) {
  return processPersistedMessage({
    ...state,
    message: message(content, id, at, values),
  });
}

function continued(state, result) {
  return {
    config: state.config,
    desireState: result.desireState,
    interactionState: result.interactionState,
  };
}

function cause(result, index = 0) {
  return result.desireState.negativeCauses[index];
}

test('hurt creates one bounded, text-free relationship cause and raises matching drives', () => {
  const state = setup();
  const result = process(state, 'I am disappointed and you hurt me.', 'hurt');
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.interpreted.types.includes('hurt_anger'), true);
  assert.equal(result.desireState.negativeCauses.length, 1);
  assert.equal(cause(result).kind, 'relationship_conflict');
  assert.equal(cause(result).status, 'open');
  assert.ok(result.desireState.drives.reflection > 0);
  assert.ok(result.desireState.drives.duty > 0);
  assert.ok(result.desireState.drives.stress > 0);
  assert.equal(result.desireState.drives.fatigue, 0);
  assert.doesNotMatch(JSON.stringify(cause(result)), /disappointed|hurt me/iu);
});

test('a parent-linked affirmation proportionally eases only its hurt cause', () => {
  const state = setup();
  const hurt = process(state, 'I am disappointed and you hurt me.', 'hurt', START + 1);
  const before = structuredClone(cause(hurt).remaining);
  const reassured = process(
    continued(state, hurt),
    'I trust you.',
    'affirmation',
    START + 1,
    { role: 'assistant', parentMessageId: 'hurt' },
  );
  const after = cause(reassured).remaining;
  for (const drive of ['reflection', 'duty', 'stress']) {
    assert.ok(Math.abs(after[drive] - before[drive] * 0.80) < 1e-12);
    assert.ok(reassured.desireState.drives[drive] > 0);
  }
  assert.equal(after.fatigue, 0);
  assert.equal(cause(reassured).status, 'open');
});

test('explicit conflict resolution closes only the linked conflict cause', () => {
  const state = setup();
  const conflict = process(state, 'We had a conflict and argued.', 'conflict', START + 1);
  const task = process(
    continued(state, conflict), 'There is task pressure from a deadline.', 'task', START + 2,
  );
  const resolved = process(
    continued(state, task), 'The conflict resolved.', 'resolved', START + 2,
    { causeId: cause(conflict).causeId },
  );
  assert.equal(resolved.desireState.negativeCauses[0].status, 'resolved');
  assert.deepEqual(
    Object.values(resolved.desireState.negativeCauses[0].remaining), [0, 0, 0, 0],
  );
  assert.equal(resolved.desireState.negativeCauses[1].kind, 'task_pressure');
  assert.equal(resolved.desireState.negativeCauses[1].status, 'open');
});

test('task completion closes a linked task-pressure cause without touching conflict', () => {
  const state = setup();
  const conflict = process(state, 'We had a conflict.', 'conflict', START + 1);
  const task = process(
    continued(state, conflict), 'There is task pressure and a deadline.', 'task', START + 2,
  );
  const completed = process(
    continued(state, task), 'The task is done.', 'done', START + 2,
    { causeId: task.interpreted.eventId },
  );
  assert.equal(completed.desireState.negativeCauses[0].status, 'open');
  assert.equal(completed.desireState.negativeCauses[1].status, 'resolved');
});

test('rest lowers only a linked fatigue burden and never clears every negative drive', () => {
  const state = setup();
  const tired = process(state, 'I am exhausted by a heavy burden.', 'fatigue', START + 1);
  const before = structuredClone(cause(tired).remaining);
  const rested = process(
    continued(state, tired), 'I rested and recovered.', 'rest', START + 1,
    { causeId: tired.interpreted.eventId },
  );
  assert.equal(cause(rested).kind, 'fatigue_burden');
  assert.equal(cause(rested).status, 'open');
  assert.ok(cause(rested).remaining.fatigue < before.fatigue);
  assert.ok(cause(rested).remaining.fatigue > 0);
  assert.ok(rested.desireState.drives.fatigue > 0);
});

test('an unrelated affirmation cannot reduce task pressure', () => {
  const state = setup();
  const task = process(state, 'There is task pressure from a deadline.', 'task', START + 1);
  const beforeCause = structuredClone(cause(task));
  const beforeNegative = Object.fromEntries(
    ['reflection', 'duty', 'fatigue', 'stress'].map((drive) => [drive, task.desireState.drives[drive]]),
  );
  const affirmed = process(continued(state, task), 'I trust you.', 'unrelated', START + 1);
  assert.deepEqual(cause(affirmed), beforeCause);
  for (const [drive, value] of Object.entries(beforeNegative)) {
    assert.equal(affirmed.desireState.drives[drive], value);
  }
});

test('unlinked recovery reduces only the newest compatible cause and cannot close it', () => {
  const state = setup();
  const first = process(state, 'I am stressed and anxious.', 'stress-a', START + 1);
  const second = process(
    continued(state, first), 'I am stressed and anxious.', 'stress-b', START + 2,
  );
  const beforeFirst = structuredClone(second.desireState.negativeCauses[0]);
  const beforeSecond = structuredClone(second.desireState.negativeCauses[1]);
  const comforted = process(
    continued(state, second), 'I am here with you.', 'comfort', START + 2,
  );
  assert.deepEqual(comforted.desireState.negativeCauses[0], beforeFirst);
  assert.ok(
    comforted.desireState.negativeCauses[1].remaining.stress < beforeSecond.remaining.stress,
  );
  assert.equal(comforted.desireState.negativeCauses[1].status, 'open');
});

test('negative and recovery replays are exact no-ops while distinct events remain distinct', () => {
  const state = setup();
  const first = process(state, 'We had a conflict.', 'conflict-a', START + 1);
  const replay = process(
    continued(state, first), 'We had a conflict.', 'conflict-a', START + 1,
  );
  assert.deepEqual(replay.desireState, first.desireState);
  assert.deepEqual(replay.interactionState, first.interactionState);

  const second = process(
    continued(state, first), 'We had a conflict.', 'conflict-b', START + 2,
  );
  assert.equal(second.desireState.negativeCauses.length, 2);
  assert.notEqual(second.desireState.negativeCauses[0].causeId, second.desireState.negativeCauses[1].causeId);

  const recovered = process(
    continued(state, second), 'The conflict resolved.', 'resolved', START + 2,
    { causeId: second.desireState.negativeCauses[1].causeId },
  );
  const recoveryReplay = processPersistedMessage({
    desireState: recovered.desireState,
    interactionState: recovered.interactionState,
    config: state.config,
    message: message('The conflict resolved.', 'resolved', START + 2, {
      causeId: second.desireState.negativeCauses[1].causeId,
    }),
  });
  assert.deepEqual(recoveryReplay.desireState, recovered.desireState);
  assert.deepEqual(recoveryReplay.interactionState, recovered.interactionState);
});

test('heartbeat decays open causes without messages and never revives a resolved cause', () => {
  const config = enabledConfig();
  config.arousalEnabled = true;
  const state = setup(config);
  const hurt = process(state, 'I am disappointed and you hurt me.', 'hurt', START + 1);
  const before = cause(hurt).remaining.stress;
  const decayed = tickState(hurt.desireState, state.config, START + 3_600_001).state;
  assert.ok(decayed.negativeCauses[0].remaining.stress < before);
  assert.ok(decayed.negativeCauses[0].remaining.stress > 0);

  const resolved = process(
    {
      config: state.config,
      desireState: decayed,
      interactionState: hurt.interactionState,
    },
    'The issue resolved.',
    'resolved',
    START + 3_600_001,
    { causeId: hurt.interpreted.eventId },
  );
  const oldNegativeReplay = processPersistedMessage({
    desireState: resolved.desireState,
    interactionState: resolved.interactionState,
    config: state.config,
    message: message('I am disappointed and you hurt me.', 'hurt', START + 1),
  });
  assert.deepEqual(oldNegativeReplay.desireState, resolved.desireState);
  assert.deepEqual(oldNegativeReplay.interactionState, resolved.interactionState);
  const later = tickState(resolved.desireState, state.config, START + 7_200_001).state;
  assert.equal(later.negativeCauses[0].status, 'resolved');
  assert.deepEqual(Object.values(later.negativeCauses[0].remaining), [0, 0, 0, 0]);
});

test('recovery leaves pending, satisfaction, cooldown, timeline, and delivery gates untouched', () => {
  const config = enabledConfig();
  config.expression.baseWillingness = 1;
  const original = setup(config);
  original.desireState.drives.attachment = 0.95;
  const pendingState = decideState(original.desireState, config, START).state;
  pendingState.pendingCooldownUntil = {
    epochMs: START + 3_600_000,
    iso: new Date(START + 3_600_000).toISOString(),
  };
  const hurt = process({ ...original, desireState: pendingState },
    'I am disappointed and you hurt me.', 'hurt', START + 1);
  const before = {
    pending: structuredClone(hurt.desireState.pendingDecision),
    lastSatisfiedAt: structuredClone(hurt.desireState.lastSatisfiedAt),
    cooldown: structuredClone(hurt.desireState.pendingCooldownUntil),
    timeline: structuredClone(hurt.desireState.timeline),
    gates: [config.observeOnly, config.deliveryEnabled],
  };
  const recovered = process(
    continued(original, hurt), 'I trust you.', 'affirmed', START + 1,
    { causeId: hurt.interpreted.eventId },
  );
  assert.deepEqual(recovered.desireState.pendingDecision, before.pending);
  assert.deepEqual(recovered.desireState.lastSatisfiedAt, before.lastSatisfiedAt);
  assert.deepEqual(recovered.desireState.pendingCooldownUntil, before.cooldown);
  assert.deepEqual(recovered.desireState.timeline, before.timeline);
  assert.deepEqual([config.observeOnly, config.deliveryEnabled], before.gates);
});

test('cause state, idempotency, and decay survive isolated persistence and reload', async () => {
  const state = setup();
  const hurtMessage = message('I am disappointed and you hurt me.', 'hurt', START + 1);
  const hurt = processPersistedMessage({ ...state, message: hurtMessage });
  const comfortMessage = message('I am here with you.', 'comfort', START + 2, {
    causeId: hurt.interpreted.eventId,
  });
  const comforted = processPersistedMessage({
    desireState: hurt.desireState,
    interactionState: hurt.interactionState,
    config: state.config,
    message: comfortMessage,
  });
  const directory = await mkdtemp(path.join(tmpdir(), 'negative-cause-restart-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  await initializeState(directory, comforted.desireState, state.config);
  await initializeInteractionState(directory, comforted.interactionState, state.config);

  const reloadedDesire = await loadState(directory, state.config);
  const reloadedInteraction = await loadInteractionState(directory, state.config);
  const negativeReplay = processPersistedMessage({
    desireState: reloadedDesire,
    interactionState: reloadedInteraction,
    config: state.config,
    message: hurtMessage,
  });
  assert.deepEqual(negativeReplay.desireState, reloadedDesire);
  assert.deepEqual(negativeReplay.interactionState, reloadedInteraction);
  const recoveryReplay = processPersistedMessage({
    desireState: reloadedDesire,
    interactionState: reloadedInteraction,
    config: state.config,
    message: comfortMessage,
  });
  assert.deepEqual(recoveryReplay.desireState, reloadedDesire);
  assert.deepEqual(recoveryReplay.interactionState, reloadedInteraction);
  const later = tickState(reloadedDesire, state.config, START + 3_600_001).state;
  assert.ok(later.negativeCauses[0].remaining.stress < reloadedDesire.negativeCauses[0].remaining.stress);
});

test('legacy state without cause fields is migrated safely on load', async () => {
  const state = setup();
  const legacy = structuredClone(state.desireState);
  delete legacy.negativeCauseUpdatedAt;
  delete legacy.negativeCauses;
  const directory = await mkdtemp(path.join(tmpdir(), 'negative-cause-migration-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const migrated = await loadState(directory, state.config);
  assert.deepEqual(migrated.negativeCauses, []);
  assert.deepEqual(migrated.negativeCauseUpdatedAt, migrated.lastTickAt);
});
