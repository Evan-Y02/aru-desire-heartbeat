import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptAruTurnSettled } from '../src/aru-host-turn-adapter.mjs';
import { stableMessageEventId } from '../src/chat-stimulus.mjs';

const NOW = Date.parse('2026-09-26T03:00:00.000Z');

function event(values = {}) {
  const user = {
    messageId: 'hostmsg_user_1', role: 'user', status: 'completed',
    content: 'Synthetic complete user turn.', createdAt: NOW, updatedAt: NOW,
  };
  const assistant = {
    messageId: 'hostmsg_assistant_1', role: 'assistant', status: 'completed',
    content: 'Synthetic complete assistant final.', createdAt: NOW, updatedAt: NOW + 1,
  };
  return {
    outcome: 'completed',
    conversation: {
      conversationId: 'hostconv_synthetic_1',
      messages: [user, assistant],
    },
    turn: {
      userMessageId: user.messageId,
      assistantMessageId: assistant.messageId,
      completedAt: NOW + 1,
    },
    assistantMessage: assistant,
    ...values,
  };
}

test('Aru onTurnSettled adapter emits one complete user and assistant final', () => {
  const messages = adaptAruTurnSettled(event());
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((item) => item.role), ['user', 'assistant']);
  assert.equal(messages[0].persisted, true);
  assert.equal(messages[1].final, true);
  assert.match(stableMessageEventId(messages[0]), /^event-[a-f0-9]{64}$/u);
  assert.match(stableMessageEventId(messages[1]), /^event-[a-f0-9]{64}$/u);
});

test('Aru adapter rejects failed, interrupted, streaming, and malformed turns', () => {
  assert.deepEqual(adaptAruTurnSettled(event({ outcome: 'failed' })), []);
  assert.deepEqual(adaptAruTurnSettled(event({ outcome: 'interrupted' })), []);
  const streaming = event();
  streaming.assistantMessage.status = 'streaming';
  assert.deepEqual(adaptAruTurnSettled(streaming), []);
  assert.deepEqual(adaptAruTurnSettled({ outcome: 'completed' }), []);
});
