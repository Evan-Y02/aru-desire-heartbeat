import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyArousalEvent,
  applyReleaseReceiptToDesire,
  createArousalState,
  publicArousalStatus,
  setReleaseGate,
} from '../src/arousal.mjs';
import { createInitialState } from '../src/engine.mjs';
import { createInteractionState, settlePartneredNoRelease } from '../src/interaction-runtime.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const START = Date.parse('2026-09-25T02:00:00.000Z');

const eventId = (value) => `event-${createHash('sha256').update(value).digest('hex')}`;
const stimulus = (values = {}) => ({
  action: 'stroke',
  bodyPart: 'genitals',
  posture: 'neutral',
  mode: 'active',
  direction: 'mutual',
  releaseSignal: false,
  ...values,
});
const apply = (state, id, stimuli, at, libido = 0.5) => applyArousalEvent(
  state, config.arousal, { eventId: eventId(id), stimuli }, libido, at,
);

test('legal affirmative stimulus raises independent arousal', () => {
  const state = createArousalState(START);
  const result = apply(state, 'rise', [stimulus()], START + 1);
  assert.equal(result.applied, true);
  assert.ok(result.state.value > 0);
  assert.equal(state.value, 0);
});

test('continuous passive contact cannot cross the passive cap', () => {
  let state = createArousalState(START);
  for (let index = 0; index < 100; index += 1) {
    state = apply(state, `passive-${index}`, [stimulus({
      action: 'contact', mode: 'passive',
    })], START + index + 1, 1).state;
  }
  assert.ok(state.value <= config.arousal.passiveContactCap);
});

test('a new active action can continue above the passive cap and edge', () => {
  let state = createArousalState(START);
  state.value = config.arousal.passiveContactCap;
  state = apply(state, 'active-one', [stimulus({ action: 'thrust' })], START + 1, 1).state;
  state = apply(state, 'active-two', [stimulus({ action: 'rub' })], START + 2, 1).state;
  assert.ok(state.value > config.arousal.edge);
});

test('repeating one action inside a message is counted only once', () => {
  const state = createArousalState(START);
  const one = apply(state, 'single', [stimulus()], START + 1).state;
  const repeated = apply(state, 'repeat', [stimulus(), stimulus(), stimulus()], START + 1).state;
  assert.equal(repeated.value, one.value);
});

test('locked gate blocks release and release_once permits exactly one', () => {
  const locked = createArousalState(START);
  locked.value = 0.99;
  const blocked = apply(locked, 'blocked', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1).state;
  assert.equal(blocked.pendingReleaseReceipt, null);

  let once = setReleaseGate(locked, 'release_once');
  const released = apply(once, 'once', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1);
  assert.equal(released.released, true);
  assert.equal(released.state.releaseGate, 'locked');
  once = structuredClone(released.state);
  once.pendingReleaseReceipt = null;
  once.value = 0.99;
  once.updatedAt = { iso: new Date(START + 200_000).toISOString(), epochMs: START + 200_000 };
  once.refractoryUntil = null;
  const second = apply(once, 'twice', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 200_001);
  assert.equal(second.released, false);
});

test('release words alone cannot bypass the physical threshold', () => {
  let state = setReleaseGate(createArousalState(START), 'unlock');
  const result = apply(state, 'words-only', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1);
  assert.equal(result.released, false);
  assert.equal(result.state.pendingReleaseReceipt, null);
});

test('refractory stimulation does not repeatedly extend recovery', () => {
  let state = createArousalState(START);
  state.value = 0.99;
  state = setReleaseGate(state, 'unlock');
  state = apply(state, 'release', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1).state;
  const until = state.refractoryUntil.epochMs;
  state = apply(state, 'during-one', [stimulus()], START + 2).state;
  state = apply(state, 'during-two', [stimulus()], START + 3).state;
  assert.equal(state.refractoryUntil.epochMs, until);
});

test('replaying one release event does not repeat reserve or refractory effects', () => {
  let state = setReleaseGate(Object.assign(createArousalState(START), { value: 0.99 }), 'unlock');
  const first = apply(state, 'release-replay', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1).state;
  const replay = apply(first, 'release-replay', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1).state;
  assert.deepEqual(replay, first);
});

test('low reserve still allows high-quality climax with low output', () => {
  let state = createArousalState(START);
  state.value = 0.99;
  state.reserve = 0.04;
  state = setReleaseGate(state, 'unlock');
  const result = apply(state, 'low-reserve', [
    stimulus({ action: 'thrust' }),
    stimulus({ action: 'climax', releaseSignal: true }),
  ], START + 1, 1);
  assert.equal(result.released, true);
  assert.ok(result.state.lastClimaxQuality >= 0.80);
  assert.ok(result.state.lastOutput < 0.10);
});

test('reserve recovers linearly over approximately three hours', () => {
  const state = createArousalState(START);
  state.reserve = 0.10;
  const result = apply(state, 'recovery', [], START + 10_800_000);
  assert.equal(result.state.reserve, 1);
});

test('release receipt crash replay changes downstream libido only once', () => {
  const rootConfig = structuredClone(config);
  rootConfig.arousalDriveSettlementEnabled = true;
  rootConfig.arousal.releaseCarryoverFactor = 0.5;
  let arousal = createArousalState(START);
  arousal.value = 0.99;
  arousal = setReleaseGate(arousal, 'unlock');
  arousal = applyArousalEvent(
    arousal,
    rootConfig.arousal,
    { eventId: eventId('receipt'), stimuli: [stimulus({ action: 'climax', releaseSignal: true })] },
    1,
    START + 1,
  ).state;
  const desire = createInitialState(rootConfig, START);
  desire.drives.libido = 0.8;
  const first = applyReleaseReceiptToDesire(arousal, desire, rootConfig);
  assert.equal(first.desire.drives.libido, 0.4);
  const replay = applyReleaseReceiptToDesire(arousal, first.desire, rootConfig);
  assert.equal(replay.desire.drives.libido, 0.4);
  assert.equal(replay.applied, false);
  assert.equal(replay.arousal.pendingReleaseReceipt, null);
});

test('malformed gate fails closed; NaN and clock rollback are rejected', () => {
  const malformed = createArousalState(START);
  malformed.value = 0.99;
  malformed.releaseGate = 'unknown';
  const result = apply(malformed, 'malformed-gate', [stimulus({
    action: 'climax', releaseSignal: true,
  })], START + 1);
  assert.equal(result.released, false);
  assert.equal(result.state.releaseGate, 'locked');

  const nan = createArousalState(START);
  nan.value = Number.NaN;
  assert.throws(() => apply(nan, 'nan', [stimulus()], START + 1), /between 0 and 1/u);
  assert.throws(
    () => apply(createArousalState(START), 'backward', [stimulus()], START - 1),
    /clock moved backwards/u,
  );
});

test('public arousal status is limited to exactly nine allowlisted fields', () => {
  const state = createArousalState(START);
  const status = publicArousalStatus(state, config.arousal, START);
  assert.deepEqual(Object.keys(status).sort(), [
    'last_climax_quality',
    'last_climax_quality_label',
    'last_output',
    'last_output_label',
    'phase',
    'phase_label',
    'refractory',
    'reserve',
    'reserve_label',
  ]);
  assert.equal(JSON.stringify(status).includes('releaseGate'), false);
  assert.equal(JSON.stringify(status).includes('processedEvents'), false);
});

test('Solo output and reserve cost use 0.80 while climax quality is unchanged', () => {
  const prepared = setReleaseGate(Object.assign(createArousalState(START), {
    value: 0.99,
  }), 'unlock');
  const partnered = applyArousalEvent(
    prepared,
    config.arousal,
    { eventId: eventId('partnered-multiplier'), cause: 'partnered', stimuli: [
      stimulus({ action: 'climax', releaseSignal: true }),
    ] },
    1,
    START + 1,
  ).state;
  const solo = applyArousalEvent(
    prepared,
    config.arousal,
    {
      eventId: eventId('solo-multiplier'), cause: 'solo',
      outputMultiplier: config.solo.outputMultiplier,
      reserveCostMultiplier: config.solo.reserveCostMultiplier,
      stimuli: [stimulus({ action: 'climax', releaseSignal: true })],
    },
    1,
    START + 1,
  ).state;
  assert.equal(solo.lastClimaxQuality, partnered.lastClimaxQuality);
  assert.ok(Math.abs(solo.lastOutput - partnered.lastOutput * 0.80) < 1e-12);
  assert.ok(Math.abs((1 - solo.reserve) - (1 - partnered.reserve) * 0.80) < 1e-12);
});

test('partnered no-release retains 0.80 without receipt or reserve cost', () => {
  const rootConfig = structuredClone(config);
  rootConfig.arousalDriveSettlementEnabled = true;
  const desire = createInitialState(rootConfig, START);
  desire.drives.libido = 0.80;
  const interaction = createInteractionState(START);
  const result = settlePartneredNoRelease({
    desireState: desire,
    interactionState: interaction,
    config: rootConfig,
    eventId: eventId('partnered-no-release'),
    nowMs: START + 1,
  });
  assert.ok(Math.abs(result.desireState.drives.libido - 0.64) < 1e-12);
  assert.equal(result.interactionState.arousal.reserve, 1);
  assert.equal(result.interactionState.arousal.pendingReleaseReceipt, null);
});

test('partnered release retains 0.30 while a Solo receipt uses only 0.38', () => {
  const rootConfig = structuredClone(config);
  rootConfig.arousalDriveSettlementEnabled = true;
  const desire = createInitialState(rootConfig, START);
  desire.drives.libido = 0.80;
  const body = setReleaseGate(Object.assign(createArousalState(START), { value: 0.99 }), 'unlock');
  const partneredBody = applyArousalEvent(
    body, rootConfig.arousal,
    { eventId: eventId('partnered-release'), cause: 'partnered', stimuli: [
      stimulus({ action: 'climax', releaseSignal: true }),
    ] }, 1, START + 1,
  ).state;
  const partnered = applyReleaseReceiptToDesire(partneredBody, desire, rootConfig);
  assert.ok(Math.abs(partnered.desire.drives.libido - 0.80 * 0.30) < 1e-12);

  const soloBody = applyArousalEvent(
    body, rootConfig.arousal,
    {
      eventId: eventId('solo-release-no-stack'), cause: 'solo',
      outputMultiplier: 0.80, reserveCostMultiplier: 0.80,
      stimuli: [stimulus({ action: 'climax', releaseSignal: true })],
    }, 1, START + 1,
  ).state;
  const solo = applyReleaseReceiptToDesire(soloBody, desire, rootConfig);
  assert.ok(Math.abs(solo.desire.drives.libido - 0.80 * 0.38) < 1e-12);
  const replay = applyReleaseReceiptToDesire(soloBody, solo.desire, rootConfig);
  assert.equal(replay.desire.drives.libido, solo.desire.drives.libido);
});

test('low reserve still permits Solo release with proportionally smaller output', () => {
  const high = setReleaseGate(Object.assign(createArousalState(START), {
    value: 0.99, reserve: 1,
  }), 'unlock');
  const low = setReleaseGate(Object.assign(createArousalState(START), {
    value: 0.99, reserve: 0.05,
  }), 'unlock');
  const make = (state, id) => applyArousalEvent(
    state, config.arousal,
    {
      eventId: eventId(id), cause: 'solo', outputMultiplier: 0.80,
      reserveCostMultiplier: 0.80,
      stimuli: [stimulus({ action: 'climax', releaseSignal: true })],
    }, 1, START + 1,
  ).state;
  const highResult = make(high, 'high-reserve-solo');
  const lowResult = make(low, 'low-reserve-solo');
  assert.ok(lowResult.lastOutput < highResult.lastOutput);
  assert.equal(lowResult.lastClimaxQuality, highResult.lastClimaxQuality);
  assert.ok(lowResult.pendingReleaseReceipt);
});
