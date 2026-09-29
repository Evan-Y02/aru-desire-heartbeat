import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideState, createInitialState } from '../src/engine.mjs';
import { createInteractionState } from '../src/interaction-runtime.mjs';
import {
  applySoloGeneration,
  latestSoloPrivateView,
  prepareSoloGeneration,
  selectSoloSession,
  settleSoloSession,
  SOLO_GENERATION_SCHEMA,
} from '../src/solo-session.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const START = Date.parse('2026-09-26T00:00:00.000Z');

function enabledConfig() {
  const config = structuredClone(baseConfig);
  config.observeOnly = false;
  config.deliveryEnabled = true;
  config.arousalEnabled = true;
  config.arousalDriveSettlementEnabled = true;
  config.soloSessionsEnabled = true;
  config.expression.baseWillingness = 1;
  config.solo.basePreference = 1;
  config.solo.libidoOverAttachmentWeight = 0;
  config.solo.afterContactBonus = 0;
  config.solo.afterSoloPenalty = 0;
  config.solo.fatigueWeight = 0;
  return config;
}

function selectedSetup() {
  const config = enabledConfig();
  const initial = createInitialState(config, START);
  Object.assign(initial.drives, { libido: 0.95, attachment: 0.10, fatigue: 0.10 });
  const decision = decideState(initial, config, START + 1);
  assert.equal(decision.decision.intent, 'solo');
  const interaction = createInteractionState(START);
  const selected = selectSoloSession({
    desireState: decision.state,
    interactionState: interaction,
    config,
    decisionId: decision.decision.id,
    nowMs: START + 2,
  });
  return { config, decision, selected };
}

function prepare(setup) {
  return prepareSoloGeneration({
    desireState: setup.selected.desireState,
    interactionState: setup.selected.interactionState,
    config: setup.config,
    sessionId: setup.selected.session.sessionId,
    recentContext: ['synthetic recent context'],
    memories: ['synthetic allowlisted memory'],
    nowMs: START + 3,
  });
}

function narrative(values = {}) {
  return {
    triggerReason: 'The autonomous check found a clear private need.',
    thought: 'A private generated thought about closeness.',
    choiceReason: 'Choosing a private outlet fit this check better than contact.',
    processSummary: 'The pace built in several deliberate structured steps.',
    afterBody: 'Breathing slowed and the body gradually settled.',
    afterThought: 'Closeness still mattered after the physical tension eased.',
    ...values,
  };
}

function beat(stepId, values = {}) {
  return {
    stepId,
    action: 'thrust',
    bodyPart: 'genitals',
    intensity: 1,
    rhythm: 'steady',
    duration: 'short',
    posture: 'neutral',
    continuousContact: false,
    releaseIntent: false,
    ...values,
  };
}

function envelope(sessionId, outcome, beats, runId = 'run-primary', values = {}) {
  return {
    status: 'completed',
    final: true,
    runId,
    output: {
      schema: SOLO_GENERATION_SCHEMA,
      sessionId,
      outcome,
      paused: false,
      endured: false,
      actionBeats: beats,
      ...narrative(),
      ...values,
    },
  };
}

function releaseBeats() {
  return [
    beat('step-1'), beat('step-2'), beat('step-3'), beat('step-4'), beat('step-5'),
    beat('step-release', { action: 'release', releaseIntent: true }),
  ];
}

test('confirmed settlement defaults are stored behind disabled feature gates', () => {
  assert.equal(baseConfig.chatStimulus.intimacyNoReleaseCarryoverFactor, 0.80);
  assert.equal(baseConfig.arousal.releaseCarryoverFactor, 0.30);
  assert.equal(baseConfig.solo.carryoverFactor, 0.38);
  assert.equal(baseConfig.solo.outputMultiplier, 0.80);
  assert.equal(baseConfig.solo.reserveCostMultiplier, 0.80);
  assert.equal(baseConfig.solo.cooldownSeconds, 10800);
  assert.equal(baseConfig.soloSessionsEnabled, false);
  assert.equal(baseConfig.arousalEnabled, false);
  assert.equal(baseConfig.arousalDriveSettlementEnabled, false);
});

test('selecting Solo creates a selected session without implying release', () => {
  const setup = selectedSetup();
  assert.equal(setup.selected.status, 'selected');
  assert.equal(setup.selected.session.phase, 'selected');
  assert.equal(setup.selected.session.released, false);
  assert.equal(setup.selected.interactionState.arousal.pendingReleaseReceipt, null);
  assert.equal(setup.selected.desireState.drives.libido, 0.95);
});

test('preparation exposes only allowlisted model material and no body decimals', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  assert.deepEqual(Object.keys(prepared.request.driveSnapshot).sort(), [
    'attachment', 'fatigue', 'libido', 'stress',
  ]);
  assert.equal(typeof prepared.request.arousalPhase, 'string');
  assert.equal(prepared.request.outputSchema, SOLO_GENERATION_SCHEMA);
  assert.equal(prepared.interactionState.soloSessions.sessions[0].phase, 'preparing');
  assert.doesNotMatch(JSON.stringify(prepared.interactionState), /synthetic recent context/u);
});

test('valid structured action beats advance arousal beat by beat', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const result = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'no_release', [beat('step-only')]),
    nowMs: START + 4,
  });
  assert.ok(result.interactionState.arousal.value > 0);
  assert.equal(result.session.beats.length, 1);
});

test('invalid or interrupted final aborts without desire, reserve, or arousal effects', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const beforeDesire = structuredClone(prepared.desireState);
  const beforeArousal = structuredClone(prepared.interactionState.arousal);
  const result = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: { status: 'streaming', final: false, runId: 'run-bad', output: {} },
    nowMs: START + 4,
  });
  assert.equal(result.status, 'aborted');
  assert.deepEqual(result.desireState, beforeDesire);
  assert.deepEqual(result.interactionState.arousal, beforeArousal);
});

test('Solo without release retains 80 percent libido and consumes no reserve', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const generated = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'no_release', [beat('step-passive', {
      action: 'contact', intensity: 0.5, continuousContact: true,
    })]),
    nowMs: START + 4,
  });
  assert.equal(generated.session.phase, 'completed_no_release');
  assert.equal(generated.interactionState.arousal.pendingReleaseReceipt, null);
  assert.equal(generated.session.reserveBefore, generated.session.reserveAfter);
  const settled = settleSoloSession({
    desireState: generated.desireState,
    interactionState: generated.interactionState,
    config: setup.config,
    nowMs: START + 20_000,
  });
  assert.ok(Math.abs(settled.desireState.drives.libido - 0.95 * 0.80) < 1e-12);
  assert.equal(settled.session.phase, 'settled');
  assert.equal(settled.session.libidoBefore, 0.95);
  assert.equal(settled.session.libidoAfter, settled.desireState.drives.libido);
  assert.equal(settled.session.arousalBefore, prepared.interactionState.arousal.value);
  assert.equal(settled.session.arousalAfter, generated.interactionState.arousal.value);
  assert.equal(settled.session.receiptStatus, 'settled');
  assert.equal(settled.session.settled, true);
  assert.equal(settled.session.duplicateIgnored, false);
  assert.equal(settled.session.cooldownUntil, null);
});

test('legal Solo release retains 38 percent libido and settles only once', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const generated = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'release', releaseBeats()),
    nowMs: START + 4,
  });
  assert.equal(generated.session.phase, 'completed_release');
  assert.equal(generated.interactionState.arousal.pendingReleaseReceipt.cause, 'solo');
  const first = settleSoloSession({
    desireState: generated.desireState,
    interactionState: generated.interactionState,
    config: setup.config,
    nowMs: START + 90_000,
  });
  assert.ok(Math.abs(first.desireState.drives.libido - 0.95 * 0.38) < 1e-12);
  assert.equal(
    first.desireState.solo.refractoryUntil.epochMs,
    START + 90_000 + setup.config.solo.cooldownSeconds * 1000,
  );
  assert.ok(first.session.refractoryUntil.epochMs < first.desireState.solo.refractoryUntil.epochMs);
  assert.deepEqual(first.session.cooldownUntil, first.desireState.solo.refractoryUntil);
  assert.equal(first.session.settlementAt.epochMs, START + 90_000);
  assert.equal(first.session.receiptStatus, 'settled');
  assert.equal(first.session.settled, true);
  assert.equal(first.session.duplicateIgnored, false);
  assert.equal(typeof first.session.arousalBefore, 'number');
  assert.equal(typeof first.session.arousalAfter, 'number');
  const replay = settleSoloSession({
    desireState: first.desireState,
    interactionState: first.interactionState,
    config: setup.config,
    nowMs: START + 90_001,
  });
  assert.deepEqual(replay.desireState, first.desireState);
  assert.deepEqual(replay.interactionState, first.interactionState);
});

test('run and session replay are no-ops', () => {
  const setup = selectedSetup();
  const selectedReplay = selectSoloSession({
    desireState: setup.selected.desireState,
    interactionState: setup.selected.interactionState,
    config: setup.config,
    decisionId: setup.decision.decision.id,
    nowMs: START + 2,
  });
  assert.equal(selectedReplay.status, 'replayed');
  const prepared = prepare(setup);
  const generated = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'release', releaseBeats()),
    nowMs: START + 4,
  });
  const replay = applySoloGeneration({
    desireState: generated.desireState,
    interactionState: generated.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'release', releaseBeats()),
    nowMs: START + 4,
  });
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.interactionState, generated.interactionState);
});

test('step replay across a continued edge run is ignored', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const edgeBeats = [beat('step-e1'), beat('step-e2'), beat('step-e3'), beat('step-e4')];
  const edge = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'edge', edgeBeats, 'run-edge'),
    nowMs: START + 4,
  });
  assert.equal(edge.session.phase, 'edge');
  const continued = prepareSoloGeneration({
    desireState: edge.desireState,
    interactionState: edge.interactionState,
    config: setup.config,
    sessionId: edge.session.sessionId,
    nowMs: START + 50_000,
  });
  const completed = applySoloGeneration({
    desireState: continued.desireState,
    interactionState: continued.interactionState,
    config: setup.config,
    envelope: envelope(
      edge.session.sessionId,
      'release',
      [...edgeBeats, beat('step-edge-release', { action: 'release', releaseIntent: true })],
      'run-edge-continued',
    ),
    nowMs: START + 50_001,
  });
  assert.equal(completed.session.beats.length, 5);
  assert.equal(new Set(completed.session.beats.map((item) => item.stepId)).size, 5);
});

test('private Solo view contains generated record but no raw context or ledgers', () => {
  const setup = selectedSetup();
  const prepared = prepare(setup);
  const generated = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'no_release', [beat('step-private')]),
    nowMs: START + 4,
  });
  const view = latestSoloPrivateView(generated.interactionState);
  const serialized = JSON.stringify(view);
  assert.match(serialized, /private generated thought/u);
  assert.doesNotMatch(serialized, /synthetic recent context|processedRun|processedStep|digest|ledger|token/iu);
});

test('completed Solo leaves attachment and existing relationship thought untouched', () => {
  const setup = selectedSetup();
  setup.selected.desireState.thoughts.push({
    id: `thought-${START}-99`, drive: 'attachment', type: 'flit', intensity: 0.5,
    fedCount: 0, text: 'fixed synthetic relationship thought', source: 'manual',
    createdAt: { iso: new Date(START).toISOString(), epochMs: START },
    updatedAt: { iso: new Date(START).toISOString(), epochMs: START },
  });
  const prepared = prepare(setup);
  const generated = applySoloGeneration({
    desireState: prepared.desireState,
    interactionState: prepared.interactionState,
    config: setup.config,
    envelope: envelope(setup.selected.session.sessionId, 'no_release', [beat('step-retain')]),
    nowMs: START + 4,
  });
  const settled = settleSoloSession({
    desireState: generated.desireState,
    interactionState: generated.interactionState,
    config: setup.config,
    nowMs: START + 20_000,
  });
  assert.equal(settled.desireState.drives.attachment, 0.10);
  assert.equal(settled.desireState.thoughts[0].text, 'fixed synthetic relationship thought');
});
