import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryEnableMagic } from '../delivery/aru-adapter.mjs';
import { createInitialState } from '../src/engine.mjs';
import {
  classifyDeliveryFailure,
  classifyHeartbeatTick,
  privacySafeCycleResult,
  runHeartbeatCycle,
} from '../src/runtime.mjs';
import { validateState } from '../src/schema.mjs';
import { appendTimeline } from '../src/timeline.mjs';
import { PROACTIVE_CATEGORIES } from '../src/constants.mjs';
import { initializeState, loadConfig, loadState } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
baseConfig.attemptWindowMinSeconds = baseConfig.heartbeatSeconds;
baseConfig.attemptWindowMaxSeconds = baseConfig.heartbeatSeconds;
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
  config.expression.baseWillingness = 1;
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
  state.nextAttemptAt = {
    epochMs: NOW + config.heartbeatSeconds * 1000,
    iso: new Date(NOW + config.heartbeatSeconds * 1000).toISOString(),
  };
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
  assert.deepEqual(result.categories, ['threshold_not_met']);
  assert.equal(result.attemptOpportunity, true);
  const saved = await loadState(directory, baseConfig);
  assert.equal(saved.lastTickAt.epochMs, NOW + 600_000);
  assert.equal(saved.timeline.length, 0);
});

test('disabled delivery holds a durable pending decision', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  heartbeatConfig.expression.baseWillingness = 1;
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  const result = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, false),
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'held_disabled');
  assert.deepEqual(result.categories, ['eligible', 'delivery_gate']);
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.pendingDecision.id, result.decisionId);
  assert.equal(saved.timeline[0].outcome, 'held_disabled');
  assert.equal(saved.timeline[0].reasons.includes('delivery-adapter-disabled'), true);
  assert.match(saved.pendingDecision.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(saved.timeline[0].decisionFingerprint, saved.pendingDecision.fingerprint);
  assert.equal(
    saved.pendingDecision.expiresAt.epochMs,
    saved.pendingDecision.createdAt.epochMs + heartbeatConfig.pendingDecisionTtlSeconds * 1000,
  );
});

test('same gated pending survives restart without duplicate timeline entries', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  heartbeatConfig.expression.baseWillingness = 1;
  await initial(directory, heartbeatConfig, { attachment: 0.80, fatigue: 0.1 });
  const blocked = deliveryConfig(directory, false);
  const first = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: blocked,
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  const afterFirst = await loadState(directory, heartbeatConfig);
  const firstDrive = afterFirst.drives.attachment;
  const firstFingerprint = afterFirst.pendingDecision.fingerprint;

  const second = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: blocked,
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 1_200_000,
  });
  const afterRestart = await loadState(directory, heartbeatConfig);
  assert.equal(first.status, 'held_disabled');
  assert.equal(second.status, 'held_disabled');
  assert.equal(afterRestart.pendingDecision.fingerprint, firstFingerprint);
  assert.equal(afterRestart.timeline.length, 1);
  assert.notEqual(afterRestart.drives.attachment, firstDrive);
  assert.equal(afterRestart.lastTickAt.epochMs, NOW + 1_200_000);
});

test('changed gate reason records once for the same pending fingerprint', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  heartbeatConfig.expression.baseWillingness = 1;
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, false),
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, true),
    submitEvent: async () => assert.fail('observe-only must not send'),
    nowMs: NOW + 1_200_000,
  });
  await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, true),
    submitEvent: async () => assert.fail('observe-only must not send'),
    nowMs: NOW + 1_800_000,
  });
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.timeline.length, 2);
  assert.equal(saved.timeline[0].decisionFingerprint, saved.timeline[1].decisionFingerprint);
  assert.equal(saved.timeline[0].reasons.includes('delivery-adapter-disabled'), false);
  assert.equal(saved.timeline[1].reasons.includes('delivery-adapter-disabled'), true);
});

test('gated pending expires without settlement, cools down, then gets a new identity', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  heartbeatConfig.expression.baseWillingness = 1;
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  const blocked = deliveryConfig(directory, false);
  const runAt = (nowMs) => runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: blocked,
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs,
  });

  await runAt(NOW + 600_000);
  const first = await loadState(directory, heartbeatConfig);
  const firstFingerprint = first.pendingDecision.fingerprint;
  await runAt(NOW + 1_200_000);
  await runAt(NOW + 1_800_000);
  const expired = await runAt(NOW + 2_400_000);
  const afterExpiry = await loadState(directory, heartbeatConfig);
  assert.equal(expired.status, 'pending_expired');
  assert.equal(afterExpiry.pendingDecision, null);
  assert.equal(afterExpiry.timeline.length, 2);
  assert.equal(afterExpiry.timeline[0].outcome, 'pending_expired');
  assert.equal(afterExpiry.timeline[0].decisionFingerprint, firstFingerprint);
  assert.ok(Object.values(afterExpiry.lastSatisfiedAt).every((value) => value === null));

  const cooling = await runAt(NOW + 3_000_000);
  const duringCooldown = await loadState(directory, heartbeatConfig);
  assert.equal(cooling.status, 'idle');
  assert.equal(duringCooldown.pendingDecision, null);
  assert.equal(duringCooldown.timeline.length, 2);

  const replacement = await runAt(NOW + 6_000_000);
  const afterReplacement = await loadState(directory, heartbeatConfig);
  assert.equal(replacement.status, 'held_disabled');
  assert.notEqual(afterReplacement.pendingDecision.fingerprint, firstFingerprint);
  assert.equal(afterReplacement.timeline.length, 3);
  assert.ok(Object.values(afterReplacement.lastSatisfiedAt).every((value) => value === null));
});

test('logical expiry survives restart and delayed heartbeat observation without extending cooldown', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  heartbeatConfig.expression.baseWillingness = 1;
  await initial(directory, heartbeatConfig, { attachment: 0.95, fatigue: 0.1 });
  const blocked = deliveryConfig(directory, false);
  const runAt = (nowMs) => runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: blocked,
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs,
  });

  await runAt(NOW + 600_000);
  const created = await loadState(directory, heartbeatConfig);
  const fingerprint = created.pendingDecision.fingerprint;
  const expiresAt = created.pendingDecision.expiresAt.epochMs;
  assert.equal(expiresAt, NOW + 2_400_000);

  const beforeBoundary = await runAt(expiresAt - 1);
  assert.equal(beforeBoundary.status, 'held_disabled');
  const persistedBeforeRestart = await loadState(directory, heartbeatConfig);
  assert.equal(persistedBeforeRestart.pendingDecision.fingerprint, fingerprint);
  assert.equal(persistedBeforeRestart.timeline.length, 1);

  // Loading the persisted state models a service restart. Observation may be
  // delayed by timer jitter, but the logical deadline and cooldown must not move.
  const reloaded = await loadState(directory, heartbeatConfig);
  assert.equal(reloaded.pendingDecision.expiresAt.epochMs, expiresAt);
  const observed = await runAt(expiresAt + 70_000);
  const afterObservation = await loadState(directory, heartbeatConfig);
  assert.equal(observed.status, 'pending_expired');
  assert.equal(afterObservation.pendingDecision, null);
  assert.equal(
    afterObservation.pendingCooldownUntil.epochMs,
    expiresAt + heartbeatConfig.pendingDecisionCooldownSeconds * 1000,
  );
  assert.equal(afterObservation.timeline.length, 2);
  assert.equal(afterObservation.timeline[0].decisionFingerprint, fingerprint);
  assert.ok(Object.values(afterObservation.lastSatisfiedAt).every((value) => value === null));

  const cooldownEnd = afterObservation.pendingCooldownUntil.epochMs;
  const stillCooling = await runAt(cooldownEnd - 1);
  assert.equal(stillCooling.status, 'idle');
  const beforeReplacement = await loadState(directory, heartbeatConfig);
  assert.equal(beforeReplacement.pendingDecision, null);
  const replacementAt = Math.max(
    cooldownEnd,
    beforeReplacement.nextAttemptAt.epochMs,
  );
  const replacement = await runAt(replacementAt);
  const final = await loadState(directory, heartbeatConfig);
  assert.equal(replacement.status, 'held_disabled');
  assert.notEqual(final.pendingDecision.fingerprint, fingerprint);
  assert.equal(final.timeline.length, 3);
  assert.ok(Object.values(final.lastSatisfiedAt).every((value) => value === null));
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
  assert.deepEqual(result.categories, ['eligible', 'delivered']);
  assert.equal(result.attemptOpportunity, true);
  assert.equal(calls, 1);
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.pendingDecision, null);
  assert.ok(saved.drives.attachment < 0.95);
  assert.ok(saved.drives.attachment > 0);
  assert.equal(saved.timeline[0].outcome, 'submitted');
  assert.equal(saved.timeline[0].reasons.includes('delivery-accepted'), true);
});

test('fixed proactive classifications separate scheduling, selection, and failures', async () => {
  assert.deepEqual(PROACTIVE_CATEGORIES, [
    'scheduled_not_due',
    'random_attempt_not_selected',
    'threshold_not_met',
    'cooldown_or_refractory',
    'fatigue_or_stress_suppression',
    'pending_decision',
    'duplicate_or_receipt',
    'minimum_interval_or_daily_limit',
    'delivery_gate',
    'receiver_unreachable',
    'timeout',
    'runtime_or_service_error',
    'eligible',
    'delivered',
    'unknown',
  ]);
  const directory = await tempDirectory();
  const heartbeatConfig = structuredClone(baseConfig);
  const legacyState = createInitialState(heartbeatConfig, NOW);
  legacyState.nextAttemptAt = {
    epochMs: NOW + 7_200_000,
    iso: new Date(NOW + 7_200_000).toISOString(),
  };
  await initializeState(directory, legacyState, heartbeatConfig);
  const heartbeat = await runHeartbeatCycle({
    dataDirectory: directory,
    heartbeatConfig,
    deliveryConfig: deliveryConfig(directory, false),
    submitEvent: async () => assert.fail('sender must not run'),
    nowMs: NOW + 600_000,
  });
  assert.equal(heartbeat.attemptOpportunity, true);
  assert.deepEqual(heartbeat.categories, ['threshold_not_met']);
  const state = await loadState(directory, heartbeatConfig);
  assert.equal(state.nextAttemptAt.epochMs, NOW + 1_200_000);

  assert.equal(classifyDeliveryFailure({ code: 'DELIVERY_TIMEOUT' }), 'timeout');
  assert.equal(
    classifyDeliveryFailure({ code: 'RECEIVER_UNREACHABLE' }),
    'receiver_unreachable',
  );
  assert.equal(
    classifyDeliveryFailure({ code: 'UNEXPECTED_SAFE_CODE' }),
    'runtime_or_service_error',
  );

  const baseTick = {
    expiredDecision: null,
    state: { pendingDecision: null },
    decision: null,
    decisionEntryExecuted: true,
    sentinel: { formationBlockers: [] },
    expression: null,
  };
  const cases = [
    [{ ...baseTick, decisionEntryExecuted: false }, 'scheduled_not_due'],
    [{ ...baseTick, sentinel: { formationBlockers: ['below-trigger-threshold'] } },
      'threshold_not_met'],
    [{ ...baseTick, sentinel: { formationBlockers: ['fatigue-gate'] } },
      'fatigue_or_stress_suppression'],
    [{ ...baseTick, sentinel: { formationBlockers: ['pending-cooldown'] } },
      'cooldown_or_refractory'],
    [{ ...baseTick, state: { pendingDecision: {} } }, 'pending_decision'],
    [{ ...baseTick, expression: {
      expressed: false, suppressedByFatigueOrStress: false,
    } }, 'random_attempt_not_selected'],
    [{ ...baseTick, expression: {
      expressed: false, suppressedByFatigueOrStress: true,
    } }, 'fatigue_or_stress_suppression'],
    [{ ...baseTick, decision: {} }, 'eligible'],
  ];
  for (const [tick, expected] of cases) {
    assert.deepEqual(classifyHeartbeatTick(tick), [expected]);
    assert.notEqual(expected, 'unknown');
  }
});

test('cycle journal result exposes only fixed proactive metadata', async () => {
  const privateMarker = 'private-token-marker-must-not-appear';
  const parsed = privacySafeCycleResult({
    status: 'idle',
    categories: ['threshold_not_met', privateMarker],
    attemptOpportunity: true,
    elapsedSeconds: 600,
    decisionId: privateMarker,
    intent: privateMarker,
    state: { privateMarker },
    message: privateMarker,
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    'attemptOpportunity', 'categories', 'elapsedSeconds', 'schema', 'status',
  ]);
  assert.deepEqual(parsed.categories, ['threshold_not_met']);
  assert.equal(parsed.attemptOpportunity, true);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, new RegExp(privateMarker, 'u'));
  assert.doesNotMatch(serialized, /drives|thought|message|prompt|https?:|credential|token/iu);
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

test('enabled Solo Sessions preserve selection without treating it as release', async () => {
  const directory = await tempDirectory();
  const heartbeatConfig = liveHeartbeat();
  heartbeatConfig.soloSessionsEnabled = true;
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
    submitEvent: async () => assert.fail('Solo selection must not call the sender'),
    nowMs: NOW + 600_000,
  });
  assert.equal(result.status, 'solo_selected');
  assert.equal(result.soloGenerationRequired, true);
  const saved = await loadState(directory, heartbeatConfig);
  assert.equal(saved.drives.libido, saved.timeline[0].drives.libido);
  assert.equal(saved.pendingDecision.intent, 'solo');
  assert.equal(saved.solo.count, 0);
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
