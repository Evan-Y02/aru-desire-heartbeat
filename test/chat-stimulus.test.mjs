import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/engine.mjs';
import {
  createInteractionState,
  processPersistedMessage,
} from '../src/interaction-runtime.mjs';
import {
  initializeInteractionState,
  loadInteractionState,
} from '../src/interaction-storage.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const START = Date.parse('2026-09-25T00:00:00.000Z');
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

function message(content, id = 'm-1', at = START + 1, values = {}) {
  return {
    source: 'synthetic-test',
    conversationId: 'conversation-a',
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

function setup(config = enabledConfig()) {
  return {
    config,
    desireState: createInitialState(config, START),
    interactionState: createInteractionState(START),
  };
}

function process(state, content, id, at, values) {
  return processPersistedMessage({
    ...state,
    message: message(content, id, at, values),
  });
}

test('ordinary persisted message is a no-op without raw-text persistence', () => {
  const state = setup();
  const result = process(state, 'The package arrived safely.', 'ordinary', START + 1);
  assert.equal(result.status, 'no_op');
  assert.deepEqual(result.desireState.drives, state.desireState.drives);
  const serialized = JSON.stringify(result.interactionState);
  assert.doesNotMatch(serialized, /package arrived/u);
  assert.deepEqual(result.interpreted.types, ['neutral_discussion']);
  assert.equal(result.interpreted.sexualClass, 'neutral_discussion');
  assert.equal(result.interpreted.intensity, 0);
});

test('relationship and emotion events are applied only once', () => {
  const state = setup();
  const first = process(state, 'I love you and we are together.', 'affirmed', START + 1);
  assert.ok(first.desireState.drives.attachment > 0);
  const replay = processPersistedMessage({
    desireState: first.desireState,
    interactionState: first.interactionState,
    config: state.config,
    message: message('I love you and we are together.', 'affirmed', START + 1),
  });
  assert.deepEqual(replay.desireState, first.desireState);
  assert.deepEqual(replay.interactionState, first.interactionState);
});

test('a persisted assistant final can contribute, but only after finalization', () => {
  const state = setup();
  const result = process(state, 'I love you.', 'assistant-final', START + 1, {
    role: 'assistant', final: true,
  });
  assert.equal(result.status, 'applied');
  assert.ok(result.desireState.drives.attachment > 0);
});

test('affirmative complete action is routed to the independent body module', () => {
  const config = enabledConfig();
  config.arousalEnabled = true;
  const state = setup(config);
  const result = process(state, 'I am kissing you.', 'body-route', START + 1, {
    role: 'assistant', final: true,
  });
  assert.ok(result.interactionState.arousal.value > 0);
  assert.ok(result.desireState.drives.libido > 0);
});

test('stale interaction ledger is reconciled from the desire-side event ledger', () => {
  const state = setup();
  const first = process(state, 'I love you.', 'crash-window', START + 1);
  const replay = processPersistedMessage({
    desireState: first.desireState,
    interactionState: state.interactionState,
    config: state.config,
    message: message('I love you.', 'crash-window', START + 1),
  });
  assert.equal(replay.desireState.drives.attachment, first.desireState.drives.attachment);
  assert.equal(replay.interactionState.chat.processedEvents.length, 1);
  assert.equal(replay.interactionState.chat.processedEvents[0].labels[0], 'replay_reconciled');
});

test('questions, negation, plans, quotes, code, memories, and third person do not classify', () => {
  const samples = [
    'Could you kiss me?',
    "I don't want you touching me.",
    'If we kiss someday, that would be nice.',
    '> I love you',
    '```js\nconst example = "kiss me";\n```',
    'Remember when we kissed last time.',
    'She said she loves him.',
    'Tutorial example: say I love you.',
  ];
  let state = setup();
  for (let index = 0; index < samples.length; index += 1) {
    const result = process(
      state, samples[index], `excluded-${index}`, START + index + 1,
    );
    assert.deepEqual(result.desireState.drives, state.desireState.drives);
    assert.deepEqual(result.interpreted.types, ['neutral_discussion']);
    assert.equal(result.interpreted.sexualClass, 'neutral_discussion');
    assert.equal(result.interpreted.intensity, 0);
    assert.equal(result.status, 'no_op');
    state = {
      config: state.config,
      desireState: result.desireState,
      interactionState: result.interactionState,
    };
  }
});

test('high-frequency events obey the rolling window cap', () => {
  let state = setup();
  for (let index = 0; index < 20; index += 1) {
    const result = process(
      state, 'I love you.', `burst-${index}`, START + index * 1_000 + 1,
    );
    state = {
      config: state.config,
      desireState: result.desireState,
      interactionState: result.interactionState,
    };
  }
  assert.ok(state.desireState.drives.attachment <= state.config.chatStimulus.windowCaps.attachment);
  assert.ok(state.desireState.drives.attachment > 0);
});

test('incomplete or cancelled assistant output never becomes an event', () => {
  const state = setup();
  for (const values of [
    { role: 'assistant', status: 'streaming', final: false },
    { role: 'assistant', status: 'complete', final: false },
    { role: 'assistant', status: 'complete', final: true, cancelled: true },
  ]) {
    const result = process(state, 'I love you.', `partial-${values.status}`, START + 1, values);
    assert.equal(result.status, 'ignored_incomplete');
    assert.strictEqual(result.desireState, state.desireState);
    assert.strictEqual(result.interactionState, state.interactionState);
  }
});

test('hurt event changes bounded drives and creates only a qualitative flit', () => {
  const state = setup();
  const result = process(state, 'I am disappointed and you hurt me.', 'hurt', START + 1);
  assert.ok(result.desireState.drives.reflection > 0);
  assert.ok(result.desireState.drives.duty > 0);
  assert.ok(result.desireState.drives.stress > 0);
  assert.equal(result.desireState.thoughts.length, 1);
  assert.equal(result.desireState.thoughts[0].source, 'event');
  assert.doesNotMatch(JSON.stringify(result.desireState), /disappointed|hurt me/iu);
});

test('ambiguous events enter a bounded qualitative pending queue', () => {
  const state = setup();
  state.config.chatStimulus.pendingMaxCount = 3;
  let current = state;
  for (let index = 0; index < 6; index += 1) {
    const result = process(
      current, 'I have mixed feelings.', `vague-${index}`, START + index + 1,
    );
    current = {
      config: current.config,
      desireState: result.desireState,
      interactionState: result.interactionState,
    };
  }
  assert.equal(current.interactionState.chat.pending.length, 3);
  assert.equal(current.interactionState.chat.pending[0].labels[0], 'ambiguous_affect');
  assert.doesNotMatch(JSON.stringify(current.interactionState), /mixed feelings/iu);
});

test('chat influence naturally decays on later complete events', () => {
  const state = setup();
  const first = process(state, 'I love you.', 'first', START + 1);
  const before = first.desireState.drives.attachment;
  const later = processPersistedMessage({
    desireState: first.desireState,
    interactionState: first.interactionState,
    config: state.config,
    message: message('A neutral update.', 'later', START + 21_600_001),
  });
  assert.ok(later.desireState.drives.attachment < before);
  assert.ok(later.desireState.drives.attachment > 0);
});

test('all three feature flags disabled preserve exact object state', () => {
  const state = setup(structuredClone(baseConfig));
  const beforeDesire = structuredClone(state.desireState);
  const beforeInteraction = structuredClone(state.interactionState);
  const result = process(state, 'I love you.', 'disabled', START + 1);
  assert.equal(result.status, 'disabled');
  assert.strictEqual(result.desireState, state.desireState);
  assert.strictEqual(result.interactionState, state.interactionState);
  assert.deepEqual(result.desireState, beforeDesire);
  assert.deepEqual(result.interactionState, beforeInteraction);
  assert.equal(state.config.soloSessionsEnabled, false);
});

test('interaction state persists owner-only without conversation text', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'interaction-state-test-'));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  const state = createInteractionState(START);
  await initializeInteractionState(directory, state, baseConfig);
  const file = path.join(directory, 'interaction-state.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadInteractionState(directory, baseConfig), state);
  assert.doesNotMatch(await readFile(file, 'utf8'), /content|message|raw/iu);
});
