import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDesireEvent,
  deliverPending,
  DeliveryError,
  deliveryEnableMagic,
  validateDeliveryConfig,
} from '../delivery/aru-adapter.mjs';
import { addThought, createInitialState, decideState } from '../src/engine.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseHeartbeat = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const NOW = Date.parse('2026-09-10T04:00:00.000Z');
const temporaryDirectories = [];

after(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'aru-external-trigger-test-'));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}
function heartbeatConfig() {
  const config = structuredClone(baseHeartbeat);
  config.observeOnly = false;
  config.deliveryEnabled = true;
  return config;
}

function pendingState(config) {
  let state = createInitialState(config, NOW);
  state = addThought(state, config, {
    drive: 'attachment',
    type: 'fixation',
    intensity: 0.88,
    text: '想靠近月，看看她现在在做什么',
  }, NOW + 1);
  state.drives.attachment = 0.95;
  state.drives.fatigue = 0.1;
  return decideState(state, config, NOW + 2).state;
}

function deliveryConfig(directory, values = {}) {
  return {
    schema: 'aru.desire-heartbeat.external-trigger.v1',
    version: 1,
    enabled: true,
    credentialPath: path.join(directory, 'send-credential'),
    enableFile: path.join(directory, 'external-trigger.enable'),
    timeoutMs: 1000,
    maxEventBytes: 32768,
    ...values,
  };
}

async function authorize(config) {
  const credential = {
    schema: 'aru.wake-bridge.sender-bundle.v2',
    triggerId: '00000000-0000-4000-8000-000000000001',
    submitURL: 'https://host.example/aru/v1/wake-bridge/endpoints/test/events',
    submitToken: Buffer.alloc(32, 3).toString('base64'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  };
  await writeFile(config.credentialPath, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  await writeFile(config.enableFile, `${deliveryEnableMagic}\n`, { mode: 0o600 });
}
test('config contains no initiative rule or collaborator routing', async () => {
  const directory = await tempDirectory();
  const config = deliveryConfig(directory);
  assert.equal(validateDeliveryConfig(config), config);
  assert.equal(Object.hasOwn(config, 'collaboratorId'), false);
  assert.equal(Object.hasOwn(config, 'rulesByIntent'), false);
  assert.equal(Object.hasOwn(config, 'baseUrl'), false);
});

test('disabled delivery stops before credential or sender access', async () => {
  const directory = await tempDirectory();
  const config = deliveryConfig(directory, { enabled: false });
  let called = false;
  await assert.rejects(deliverPending({
    state: pendingState(heartbeatConfig()),
    heartbeatConfig: heartbeatConfig(),
    deliveryConfig: config,
    dataDirectory: directory,
    submitEvent: async () => { called = true; },
    nowMs: NOW + 2,
  }), (error) => error.code === 'DELIVERY_NOT_ENABLED');
  assert.equal(called, false);
  assert.deepEqual(await readdir(directory), []);
});

test('solo decisions are rejected before any external access', async () => {
  const directory = await tempDirectory();
  const hb = heartbeatConfig();
  hb.solo.basePreference = 1;
  hb.solo.libidoOverAttachmentWeight = 0;
  hb.solo.afterContactBonus = 0;
  hb.solo.afterSoloPenalty = 0;
  hb.solo.fatigueWeight = 0;
  const state = createInitialState(hb, NOW);
  state.drives.libido = 0.95;
  state.drives.attachment = 0.20;
  state.drives.fatigue = 0.10;
  const solo = decideState(state, hb, NOW + 2).state;
  assert.equal(solo.pendingDecision.intent, 'solo');
  await assert.rejects(deliverPending({
    state: solo,
    heartbeatConfig: hb,
    deliveryConfig: deliveryConfig(directory),
    dataDirectory: directory,
    submitEvent: async () => assert.fail('solo must remain local'),
    nowMs: NOW + 2,
  }), (error) => error.code === 'SOLO_NOT_EXTERNAL');
  assert.deepEqual(await readdir(directory), []);
});

test('event identifies an internal automatic trigger, not user input', () => {
  const config = heartbeatConfig();
  const event = buildDesireEvent(pendingState(config), NOW + 3);
  assert.equal(event.eventType, 'desire_threshold_reached');
  assert.equal(event.userAuthored, false);
  assert.equal(event.purpose, 'automatic_trigger');
  assert.equal(event.decision.drive, 'attachment');
  assert.equal(event.relatedThoughts.length, 1);
  assert.match(event.guidance.join(' '), /不是用户发来的消息/);
});
test('exact enable file is required', async () => {
  const directory = await tempDirectory();
  const config = deliveryConfig(directory);
  await writeFile(config.enableFile, 'wrong\n', { mode: 0o600 });
  await assert.rejects(deliverPending({
    state: pendingState(heartbeatConfig()), heartbeatConfig: heartbeatConfig(),
    deliveryConfig: config, dataDirectory: directory,
    submitEvent: async () => ({ accepted: true }), nowMs: NOW + 2,
  }), (error) => error.code === 'DELIVERY_NOT_ENABLED');
});

test('missing sender fails before reading or claiming a credential', async () => {
  const directory = await tempDirectory();
  const config = deliveryConfig(directory);
  await writeFile(config.enableFile, `${deliveryEnableMagic}\n`, { mode: 0o600 });
  await assert.rejects(deliverPending({
    state: pendingState(heartbeatConfig()), heartbeatConfig: heartbeatConfig(),
    deliveryConfig: config, dataDirectory: directory, nowMs: NOW + 2,
  }), (error) => error.code === 'EXTERNAL_TRIGGER_SENDER_UNAVAILABLE');
  assert.equal((await readdir(directory)).includes('delivery-attempts'), false);
});

test('unsafe credential symlinks are rejected', async () => {
  const directory = await tempDirectory();
  const config = deliveryConfig(directory);
  await writeFile(config.enableFile, `${deliveryEnableMagic}\n`, { mode: 0o600 });
  const target = path.join(directory, 'real-credential');
  await writeFile(target, 'opaque\n', { mode: 0o600 });
  await symlink(target, config.credentialPath);
  await assert.rejects(deliverPending({
    state: pendingState(heartbeatConfig()), heartbeatConfig: heartbeatConfig(),
    deliveryConfig: config, dataDirectory: directory,
    submitEvent: async () => ({ accepted: true }), nowMs: NOW + 2,
  }), (error) => error.code === 'CREDENTIAL_UNSAFE');
});

test('safe sender receives one bounded desire event', async () => {
  const directory = await tempDirectory();
  const hb = heartbeatConfig();
  const config = deliveryConfig(directory);
  await authorize(config);
  const calls = [];
  const state = pendingState(hb);
  const result = await deliverPending({
    state, heartbeatConfig: hb, deliveryConfig: config, dataDirectory: directory,
    submitEvent: async (input) => {
      calls.push(input);
      return { accepted: true, eventId: input.event.eventId };
    },
    nowMs: NOW + 2,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.state.pendingDecision, null);
  assert.ok(result.state.drives.attachment < state.drives.attachment);
  assert.equal(Object.hasOwn(result.state, 'deliveryCounter'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credential.schema, 'aru.wake-bridge.sender-bundle.v2');
  assert.equal(calls[0].credential.triggerId, '00000000-0000-4000-8000-000000000001');
  assert.equal(calls[0].timeoutMs, 1000);
  const attempts = await readdir(path.join(directory, 'delivery-attempts'));
  assert.deepEqual(attempts.map((name) => name.endsWith('.accepted.json')), [true]);
});
test('a claimed decision is never retried automatically', async () => {
  const directory = await tempDirectory();
  const hb = heartbeatConfig();
  const config = deliveryConfig(directory);
  await authorize(config);
  const state = pendingState(hb);
  const submitEvent = async ({ event }) => ({ accepted: true, eventId: event.eventId });
  await deliverPending({
    state, heartbeatConfig: hb, deliveryConfig: config, dataDirectory: directory,
    submitEvent, nowMs: NOW + 2,
  });
  await assert.rejects(deliverPending({
    state, heartbeatConfig: hb, deliveryConfig: config, dataDirectory: directory,
    submitEvent, nowMs: NOW + 3,
  }), (error) => error.code === 'DELIVERY_ALREADY_CLAIMED');
});

test('ambiguous sender failure leaves an uncertain claim', async () => {
  const directory = await tempDirectory();
  const hb = heartbeatConfig();
  const config = deliveryConfig(directory);
  await authorize(config);
  await assert.rejects(deliverPending({
    state: pendingState(hb), heartbeatConfig: hb, deliveryConfig: config,
    dataDirectory: directory,
    submitEvent: async () => { throw new Error('socket closed'); },
    nowMs: NOW + 2,
  }), (error) => error instanceof DeliveryError &&
    error.code === 'EXTERNAL_TRIGGER_REQUEST_FAILED');
  const attempts = await readdir(path.join(directory, 'delivery-attempts'));
  assert.deepEqual(attempts.map((name) => name.endsWith('.uncertain.json')), [true]);
});
test('oversized desire event is rejected before an attempt claim', async () => {
  const directory = await tempDirectory();
  const hb = heartbeatConfig();
  const config = deliveryConfig(directory, { maxEventBytes: 1 });
  await authorize(config);
  await assert.rejects(deliverPending({
    state: pendingState(hb), heartbeatConfig: hb, deliveryConfig: config,
    dataDirectory: directory,
    submitEvent: async () => ({ accepted: true }), nowMs: NOW + 2,
  }), (error) => error.code === 'EVENT_TOO_LARGE');
  assert.equal((await readdir(directory)).includes('delivery-attempts'), false);
});