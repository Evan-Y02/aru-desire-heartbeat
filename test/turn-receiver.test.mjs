import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAruDesireTurnHook } from '../aru-hook/aru-desire-turn-hook.mjs';
import { createArousalState, publicArousalStatus } from '../src/arousal.mjs';
import {
  CANONICAL_TURN_SCHEMA,
  canonicalEventId,
  canonicalToCompleteMessage,
  validateCanonicalTurnEvent,
} from '../src/canonical-turn-event.mjs';
import { createInitialState } from '../src/engine.mjs';
import { createInteractionState } from '../src/interaction-runtime.mjs';
import { initializeInteractionState, loadInteractionState } from '../src/interaction-storage.mjs';
import { processCanonicalTurn } from '../src/turn-receiver.mjs';
import { atomicSaveState, loadConfig, loadState } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const START = Date.parse('2026-09-26T05:00:00.000Z');
const directories = [];
test.after(async () => Promise.all(directories.map((directory) =>
  rm(directory, { recursive: true, force: true }))));

async function setup() {
  const source = JSON.parse(await readFile(path.join(ROOT, 'config/default.json'), 'utf8'));
  source.chatStimulusEnabled = true;
  source.arousalEnabled = true;
  source.arousalDriveSettlementEnabled = true;
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-receiver-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, `${JSON.stringify(source)}\n`, { mode: 0o600 });
  const config = await loadConfig(configPath);
  await atomicSaveState(directory, createInitialState(config, START), config, { mustCreate: true });
  await initializeInteractionState(directory, createInteractionState(START), config);
  return { directory, dataDirectory: directory, configPath, config };
}

function event(id, text, completedAt, role = 'user') {
  const identity = {
    conversationId: 'hostconv_synthetic_e2e',
    messageId: `hostmsg_${id}`,
    role,
  };
  return {
    schema_version: CANONICAL_TURN_SCHEMA,
    event_id: canonicalEventId(identity),
    conversation_id: identity.conversationId,
    message_id: identity.messageId,
    parent_message_id: role === 'assistant' ? 'hostmsg_synthetic_parent' : null,
    role,
    completed_at: completedAt,
    complete: true,
    text,
    source: 'aru_on_turn_settled',
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
    child.kill('SIGTERM');
  });
}

test('canonical validation rejects partial, unstable, and oversized messages', () => {
  const valid = event('valid', 'Synthetic complete message.', START + 1);
  assert.equal(canonicalToCompleteMessage(valid).persisted, true);
  assert.throws(() => validateCanonicalTurnEvent({ ...valid, complete: false }));
  assert.throws(() => validateCanonicalTurnEvent({ ...valid, event_id: 'event-bad' }));
  assert.throws(() => validateCanonicalTurnEvent({ ...valid, text: 'x'.repeat(20_001) }));
});

test('complete user and assistant events apply once without persisting source text', async () => {
  const fixture = await setup();
  const user = event('emotion', 'I am sad and need support from you.', START + 1);
  const assistant = event('assistant', 'A synthetic neutral final.', START + 2, 'assistant');
  await processCanonicalTurn({ event: user, ...fixture });
  await processCanonicalTurn({ event: user, ...fixture });
  await processCanonicalTurn({ event: assistant, ...fixture });
  await processCanonicalTurn({ event: assistant, ...fixture });
  const desire = await loadState(fixture.directory, fixture.config);
  const interaction = await loadInteractionState(fixture.directory, fixture.config);
  assert.equal(interaction.chat.processedEvents.length, 2);
  assert.equal(new Set(interaction.chat.processedEvents.map((item) => item.eventId)).size, 2);
  assert.ok(desire.drives.attachment > 0);
  const serialized = `${JSON.stringify(desire)}${JSON.stringify(interaction)}`;
  assert.doesNotMatch(serialized, /sad and need support|synthetic neutral final/iu);
});

test('affirmative stimulation changes Arousal while negation and questions do not', async () => {
  const fixture = await setup();
  await processCanonicalTurn({
    event: event('negated', "I don't stroke you.", START + 1), ...fixture,
  });
  await processCanonicalTurn({
    event: event('question', 'Could I stroke you?', START + 2), ...fixture,
  });
  let interaction = await loadInteractionState(fixture.directory, fixture.config);
  assert.equal(interaction.arousal.value, 0);
  await processCanonicalTurn({
    event: event('affirmative', 'I am stroking you.', START + 3), ...fixture,
  });
  interaction = await loadInteractionState(fixture.directory, fixture.config);
  assert.ok(interaction.arousal.value > 0);
});

test('interaction initialization is owner-only and public Arousal remains nine fields', async () => {
  const fixture = await setup();
  const directoryInfo = await stat(fixture.directory);
  const stateInfo = await stat(path.join(fixture.directory, 'interaction-state.json'));
  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(stateInfo.mode & 0o777, 0o600);
  const status = publicArousalStatus(createArousalState(START), fixture.config.arousal, START);
  assert.equal(Object.keys(status).length, 9);
  assert.doesNotMatch(JSON.stringify(status), /solo|text|message|receipt/iu);
});

test('temporary loopback hook and receiver deliver end to end without logging source text', async (t) => {
  const fixture = await setup();
  const secretPath = path.join(fixture.directory, 'turn-hook.secret');
  await writeFile(secretPath, `${'e'.repeat(48)}\n`, { mode: 0o600 });
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [path.join(ROOT, 'bin/desire-turn-receiver.mjs')], {
    env: {
      ...process.env,
      ARU_DESIRE_RECEIVER_HOST: '127.0.0.1',
      ARU_DESIRE_RECEIVER_PORT: String(port),
      ARU_DESIRE_CONFIG: fixture.configPath,
      ARU_DESIRE_DATA_DIR: fixture.directory,
      ARU_DESIRE_TURN_HOOK_SECRET_FILE: secretPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  t.after(() => stopChild(child));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${port}/healthz`)
      .then((response) => response.ok).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const user = {
    messageId: 'hostmsg_e2e_user', role: 'user', status: 'completed',
    content: 'I am sad and need support from you.', createdAt: START + 1, updatedAt: START + 1,
  };
  const assistant = {
    messageId: 'hostmsg_e2e_assistant', role: 'assistant', status: 'completed',
    content: 'Synthetic complete assistant final.', createdAt: START + 2, updatedAt: START + 2,
  };
  const turnEvent = {
    outcome: 'completed',
    conversation: {
      conversationId: 'hostconv_e2e_synthetic', messages: [user, assistant],
    },
    turn: {
      userMessageId: user.messageId,
      assistantMessageId: assistant.messageId,
      completedAt: START + 2,
    },
    assistantMessage: assistant,
  };
  const hookConfig = {
    enabled: true,
    endpoint: `http://127.0.0.1:${port}/v1/complete-message`,
    secretFile: secretPath,
    timeoutMs: 200,
  };
  await createAruDesireTurnHook(hookConfig).deliver(turnEvent);
  await createAruDesireTurnHook(hookConfig).deliver(turnEvent);

  const desire = await loadState(fixture.directory, fixture.config);
  const interaction = await loadInteractionState(fixture.directory, fixture.config);
  assert.equal(interaction.chat.processedEvents.length, 2);
  assert.equal(new Set(desire.appliedChatEventIds).size, 2);
  await stopChild(child);
  const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
  assert.doesNotMatch(output, /sad and need support|complete assistant final/iu);
});
