import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  __test,
  createAruDesireTurnHook,
  wrapOnTurnSettled,
} from '../aru-hook/aru-desire-turn-hook.mjs';
import {
  CANONICAL_TURN_SCHEMA,
  canonicalEventId,
} from '../src/canonical-turn-event.mjs';

const NOW = Date.parse('2026-09-26T04:00:00.000Z');
const temporaryDirectories = [];
test.after(async () => Promise.all(temporaryDirectories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

function settled(values = {}) {
  const user = {
    messageId: 'hostmsg_user_synthetic', role: 'user', status: 'completed',
    content: 'Synthetic complete user message.', createdAt: NOW, updatedAt: NOW,
  };
  const assistant = {
    messageId: 'hostmsg_assistant_synthetic', role: 'assistant', status: 'completed',
    content: 'Synthetic complete assistant final.', createdAt: NOW, updatedAt: NOW + 1,
  };
  return {
    outcome: 'completed',
    conversation: { conversationId: 'hostconv_synthetic', messages: [user, assistant] },
    turn: {
      userMessageId: user.messageId, assistantMessageId: assistant.messageId,
      baseMessageId: 'hostmsg_parent_synthetic', completedAt: NOW + 1,
    },
    assistantMessage: assistant,
    ...values,
  };
}

async function secretFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-hook-secret-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const file = path.join(directory, 'secret');
  await writeFile(file, `${'s'.repeat(48)}\n`, { mode: 0o600 });
  return file;
}

test('canonical events contain only complete persisted user and assistant final identities', () => {
  const events = __test.canonicalEvents(settled());
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.role), ['user', 'assistant']);
  assert.equal(events[0].schema_version, CANONICAL_TURN_SCHEMA);
  assert.equal(events[0].source, 'aru_on_turn_settled');
  assert.equal(events[0].complete, true);
  assert.equal(events[0].event_id, canonicalEventId({
    conversationId: events[0].conversation_id,
    messageId: events[0].message_id,
    role: events[0].role,
  }));
  assert.deepEqual(__test.canonicalEvents(settled({ outcome: 'interrupted' })), []);
  assert.deepEqual(__test.canonicalEvents(settled({ outcome: 'cancelled' })), []);
});

test('disabled hook preserves the existing callback return and sends nothing', async () => {
  let existingCalls = 0;
  const hook = createAruDesireTurnHook({
    enabled: false, endpoint: 'malformed-disabled-endpoint', secretFile: '/not/read',
  });
  const wrapped = wrapOnTurnSettled(() => {
    existingCalls += 1;
    return 'existing-result';
  }, hook);
  assert.equal(wrapped(settled()), 'existing-result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existingCalls, 1);
  assert.equal(hook.diagnostics().sent_count, 0);
});

test('hook sends complete events, suppresses replay, and exposes text-free diagnostics', async () => {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'application/json' })
        .end('{"status":"applied"}\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const hook = createAruDesireTurnHook({
    enabled: true,
    endpoint: `http://127.0.0.1:${address.port}/v1/complete-message`,
    secretFile: await secretFile(),
    timeoutMs: 100,
  });
  await hook.deliver(settled());
  await hook.deliver(settled());
  server.close();
  assert.equal(received.length, 2);
  assert.equal(hook.diagnostics().sent_count, 2);
  assert.equal(hook.diagnostics().duplicate_count, 2);
  assert.equal(hook.diagnostics().receiver_completed_count, 2);
  assert.equal(hook.diagnostics().receiver_applied_count, 2);
  assert.equal(hook.diagnostics().receiver_duplicate_count, 0);
  assert.doesNotMatch(JSON.stringify(hook.diagnostics()), /Synthetic complete/u);
});

test('a fresh hook replay exposes receiver-side duplicate completion', async () => {
  const seen = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const status = seen.has(event.event_id) ? 'duplicate' : 'applied';
      seen.add(event.event_id);
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(`${JSON.stringify({ status })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const options = {
    enabled: true,
    endpoint: `http://127.0.0.1:${address.port}/v1/complete-message`,
    secretFile: await secretFile(),
    timeoutMs: 1_000,
  };
  const first = createAruDesireTurnHook(options);
  const replay = createAruDesireTurnHook(options);
  await first.deliver(settled());
  await replay.deliver(settled());
  server.close();
  assert.equal(first.diagnostics().receiver_applied_count, 2);
  assert.equal(replay.diagnostics().receiver_completed_count, 2);
  assert.equal(replay.diagnostics().receiver_duplicate_count, 2);
  assert.equal(replay.diagnostics().timeout_count, 0);
  assert.equal(replay.diagnostics().rejected_count, 0);
});

test('receiver outage and timeout resolve fail-open without changing existing callback result', async () => {
  const unavailable = createAruDesireTurnHook({
    enabled: true,
    endpoint: 'http://127.0.0.1:65534/v1/complete-message',
    secretFile: await secretFile(),
    timeoutMs: 50,
  });
  const result = wrapOnTurnSettled(() => 'delivered-as-before', unavailable)(settled());
  assert.equal(result, 'delivered-as-before');
  await unavailable.deliver(settled());
  assert.ok(unavailable.diagnostics().rejected_count > 0 ||
    unavailable.diagnostics().timeout_count > 0);

  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const slow = createAruDesireTurnHook({
    enabled: true,
    endpoint: `http://127.0.0.1:${address.port}/v1/complete-message`,
    secretFile: await secretFile(),
    timeoutMs: 50,
  });
  await slow.deliver(settled());
  server.closeAllConnections();
  server.close();
  assert.ok(slow.diagnostics().timeout_count > 0);
});
