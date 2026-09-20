import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryEnableMagic } from '../delivery/aru-adapter.mjs';
import { createInitialState } from '../src/engine.mjs';
import { runHeartbeatCycle } from '../src/runtime.mjs';
import { validateState } from '../src/schema.mjs';
import { appendTimeline } from '../src/timeline.mjs';
import { initializeState, loadConfig, loadState } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const NOW = Date.parse('2026-09-10T04:00:00.000Z');
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function tempDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'desire-runtime-test-'));
  await chmod(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}
function liveHeartbeat() {
  const config = structuredClone(baseConfig);
  config.observeOnly = false;
  config.deliveryEnabled = true;
  return config;
}

function deliveryConfig(directory, enabled = true) {
  return {
    schema: 'aru.desire-heartbeat.external-trigger.v1',
    version: 1,
    enabled,
    credentialPath: path.join(directory, 'send-credential'),
    enableFile: path.join(directory, 'external-trigger.enable'),
    timeoutMs: 1000,
    maxEventBytes: 32768,
  };
}

async function authorize(config) {
  const credential = {
    schema: 'aru.wake-bridge.sender-bundle.v2',
    triggerId: '00000000-0000-4000-8000-000000000001',
    submitURL: 'https://host.example/events',
    submitToken: Buffer.alloc(32, 3).toString('base64'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  };
  await writeFile(config.credentialPath, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(config.enableFile, deliveryEnableMagic, { mode: 0o600 });
}
async function initial(directory, config, values = {}) {
  const state = createInitialState(config, NOW);
  Object.assign(state.drives, values);
  await initializeState(directory, state, config);
  return state;
}

test('an idle cycle only advances persisted state', async () => {
  const directory = await tempDirectory();
  await initial(directory, baseConfig);
  const result = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig: baseConfig,
    deliveryConfig: deliveryConfig(directory, false),
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'idle');
  const saved = await loadState(directory, baseConfig);
  assert.equal(saved.lastTickAt.epochMs, NOW + 600_000);
  assert.equal(saved.timeline.length, 1);
  assert.equal(saved.timeline[0].outcome, 'idle');
  assert.equal(saved.timeline[0].reasons.includes('below-trigger-threshold'), true);
});

test('disabled delivery holds a durable pending decision', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  const result = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, false),
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'held_disabled');
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.pendingDecision.id, result.decisionId);
  assert.equal(saved.timeline[0].outcome, 'held_disabled');
  assert.equal(saved.timeline[0].reasons.includes('delivery-adapter-disabled'), true);
});
test('enabled cycle submits once and satisfies the desire', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = liveHeartbeat();
  const outbound = deliveryConfig(directory);
  await authorize(outbound);
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  let calls = 0;
  const result = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: outbound,
    submitEvent: async ({ event }) => {
      calls += 1;
      return { accepted: true, eventId: event.eventId };
    },
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'submitted');
  assert.equal(calls, 1);
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.pendingDecision, null);
  assert.ok(saved.drives.attachment < 0.95);
  assert.ok(saved.drives.attachment > 0);
  assert.equal(saved.timeline[0].outcome, 'submitted');
  assert.equal(saved.timeline[0].reasons.includes('delivery-accepted'), true);
});

test('a solo cycle completes locally without calling the sender', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = liveHeartbeat();
  heartbeatConfig.solo.basePreference = 1;
  heartbeatConfig.solo.libidoOverAttachmentWeight = 0;
  heartbeatConfig.solo.afterContactBonus = 0;
  heartbeatConfig.solo.afterSoloPenalty = 0;
  heartbeatConfig.solo.fatigueWeight = 0;
  const outbound = deliveryConfig(directory);
  await initial(directory, heartbeatConfig, {
    libido: 0.95, attachment: 0.20, fatigue: 0.10,
  });
  const result = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: outbound,
    submitEvent: async () => assert.fail('solo must never call the external sender'),
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'solo_completed');
  assert.equal(result.intent, 'solo');
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.pendingDecision, null);
  assert.ok(Math.abs(
    saved.drives.libido - saved.timeline[0].drives.libido * 0.38
  ) < 1e-12);
  assert.equal(saved.solo.count, 1);
  assert.equal(saved.timeline[0].outcome, 'solo_completed');
  assert.ok(saved.timeline[0].reasons.includes('solo-completed'));
  assert.equal((await readdir(directory)).includes('delivery-attempts'), false);
});

test('an uncertain submission is persisted and never sent twice', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = liveHeartbeat();
  const outbound = deliveryConfig(directory);
  await authorize(outbound);
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  let calls = 0;
  await assert.rejects(runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: outbound,
    submitEvent: async () => { calls += 1; throw new Error('socket closed'); },
    nowMs: NOW + 600_000,
  }), (error) => error.code === 'EXTERNAL_TRIGGER_REQUEST_FAILED');
  const afterFailure = await loadState(directory, heartbeatConfig);
  assert.ok(afterFailure.pendingDecision);
  assert.equal(afterFailure.timeline[0].outcome, 'delivery_failed');
  assert.equal(afterFailure.timeline[0].reasons.includes('delivery-failed'), true);
  const attempts = await readdir(path.join(directory, 'delivery-attempts'));
  assert.equal(attempts.some((name) => name.endsWith('.uncertain.json')), true);

  const second = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: outbound,
    submitEvent: async () => { calls += 1; assert.fail('must not retry'); },
    nowMs: NOW + 1_200_000,
  });
  assert.equal(second.status, 'held_claimed');
  assert.equal(calls, 1);
  const afterSecond = await loadState(directory, heartbeatConfig);
  assert.equal(afterSecond.timeline[0].outcome, 'held_claimed');
  assert.equal(afterSecond.timeline[0].reasons.includes('delivery-already-claimed'), true);
});

test('timeline remains bounded, accepts legacy state, and forbids raw text fields', () => {
  const state = createInitialState(baseConfig, NOW);
  const legacy = structuredClone(state);
  delete legacy.timeline;
  assert.equal(validateState(legacy, baseConfig), legacy);

  const timePair = (epochMs) => ({ iso: new Date(epochMs).toISOString(), epochMs });
  for (let index = 0; index < 75; index += 1) {
    const at = NOW + index * 600_000;
    appendTimeline(state, {
      at: timePair(at),
      nextCheckAt: timePair(at + 600_000),
      outcome: 'idle',
      drive: null,
      intent: null,
      score: null,
      willingness: null,
      reasons: ['below-trigger-threshold'],
      drives: structuredClone(state.drives),
    });
  }
  assert.equal(state.timeline.length, 72);
  assert.equal(state.timeline[0].at.epochMs, NOW + 74 * 600_000);
  assert.equal(state.timeline.at(-1).at.epochMs, NOW + 3 * 600_000);
  assert.equal(validateState(state, baseConfig), state);

  state.timeline[0].text = 'private conversation must never enter timeline';
  assert.throws(
    () => validateState(state, baseConfig),
    /timeline entry contains unexpected fields/,
  );
});