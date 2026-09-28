import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAruDesireRelayTurn } from '../aru-hook/aru-desire-relay-turn.mjs';
import { __test } from '../aru-hook/aru-desire-turn-hook.mjs';
import { canonicalToCompleteMessage } from '../src/canonical-turn-event.mjs';
import { createInitialState } from '../src/engine.mjs';
import { createInteractionState, processPersistedMessage } from '../src/interaction-runtime.mjs';
import { loadConfig } from '../src/storage.mjs';

const NOW = Date.parse('2026-09-28T09:00:00.000Z');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_CONFIG = await loadConfig(path.join(ROOT, 'config/default.json'));

function relayFixture() {
  return {
    turn: {
      state: 'succeeded',
      protocolId: 'openai-compatible',
      providerContentType: 'text/event-stream',
      turnId: 'turn_synthetic_v099',
      conversationId: 'conversation_shared_v099',
      createdAt: NOW,
      completedAt: NOW + 1,
    },
    providerBody: Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Synthetic relay user final.' }],
    })),
    responseBody: Buffer.from(
      'data: {"choices":[{"delta":{"content":"Synthetic relay assistant final."}}]}\n\n' +
      'data: [DONE]\n\n',
    ),
  };
}

test('conversationTurnRelay material becomes the same canonical two-message flow', () => {
  const complete = buildAruDesireRelayTurn(relayFixture());
  assert.equal(complete.outcome, 'completed');
  assert.equal(complete.conversation.messages.length, 2);
  const events = __test.canonicalEvents(complete);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.role), ['user', 'assistant']);
});

test('relay replay keeps canonical identities stable for shared receiver deduplication', () => {
  const first = __test.canonicalEvents(buildAruDesireRelayTurn(relayFixture()));
  const second = __test.canonicalEvents(buildAruDesireRelayTurn(relayFixture()));
  assert.equal(first.length, 2);
  assert.deepEqual(
    second.map((event) => event.event_id),
    first.map((event) => event.event_id),
  );
  assert.equal(new Set(first.map((event) => event.event_id)).size, 2);
});

test('conversationTurnRelay entry reaches the shared stimulus receiver path', () => {
  const fixture = relayFixture();
  fixture.providerBody = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: '老婆，我现在想要你，身体已经有反应了。' }],
  }));
  const [event] = __test.canonicalEvents(buildAruDesireRelayTurn(fixture));
  const config = structuredClone(BASE_CONFIG);
  config.chatStimulusEnabled = true;
  config.arousalEnabled = true;
  const result = processPersistedMessage({
    desireState: createInitialState(config, NOW),
    interactionState: createInteractionState(NOW),
    config,
    message: canonicalToCompleteMessage(event),
  });
  assert.equal(result.interpreted.sexualClass, 'direct_desire');
  assert.ok(result.desireState.drives.libido > 0);
  assert.ok(result.interactionState.arousal.value > 0);
});

test('relay adapter rejects failed, unsupported, malformed, and incomplete turns', () => {
  const failed = relayFixture();
  failed.turn.state = 'failed';
  assert.equal(buildAruDesireRelayTurn(failed), null);
  const unsupported = relayFixture();
  unsupported.turn.protocolId = 'anthropic-messages';
  assert.equal(buildAruDesireRelayTurn(unsupported), null);
  const malformed = relayFixture();
  malformed.providerBody = Buffer.from('{');
  assert.equal(buildAruDesireRelayTurn(malformed), null);
});
