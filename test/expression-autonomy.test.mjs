import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInitialState,
  decideState,
  satisfyDecision,
  satisfySoloDecision,
} from '../src/engine.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseConfig = await loadConfig(path.join(ROOT, 'config', 'default.json'));
const NOW = Date.parse('2026-09-20T01:00:00.000Z');

function stateWith(config, values = {}) {
  const state = createInitialState(config, NOW);
  Object.assign(state.drives, values);
  return state;
}

function alwaysSilentConfig() {
  const config = structuredClone(baseConfig);
  for (const key of [
    'baseWillingness', 'scoreWeight', 'attachmentWeight', 'socialWeight',
    'fatiguePenalty', 'stressPenalty',
  ]) config.expression[key] = 0;
  return config;
}
test('78 percent opens a real choice and silence preserves desire', () => {
  const config = alwaysSilentConfig();
  const original = stateWith(config, {
    attachment: config.triggerThreshold,
    fatigue: 0.10,
  });
  const result = decideState(original, config, NOW);
  assert.equal(result.decision, null);
  assert.equal(result.expression.expressed, false);
  assert.equal(result.expression.withholdCount, 1);
  assert.equal(result.state.expression.consecutiveWithholds, 1);
  assert.equal(result.state.drives.attachment, config.triggerThreshold);
  assert.equal(original.expression.consecutiveWithholds, 0);
});

test('three autonomous silences are allowed and the fourth eligible cycle must contact', () => {
  const config = alwaysSilentConfig();
  let state = stateWith(config, {
    attachment: config.triggerThreshold,
    fatigue: 0.10,
  });
  for (let index = 1; index <= 3; index += 1) {
    const result = decideState(state, config, NOW + index * 600_000);
    assert.equal(result.decision, null);
    assert.equal(result.expression.expressed, false);
    assert.equal(result.expression.withholdCount, index);
    state = result.state;
  }
  const forced = decideState(state, config, NOW + 4 * 600_000);
  assert.ok(forced.decision);
  assert.equal(forced.decision.intent, 'reach_owner');
  assert.equal(forced.expression.forcedReason, 'forced-after-three-withholds');
  assert.equal(forced.state.expression.consecutiveWithholds, 3);
  const satisfied = satisfyDecision(
    forced.state, config, forced.decision.id, NOW + 4 * 600_000 + 1,
  );
  assert.equal(satisfied.expression.consecutiveWithholds, 0);
});
test('100 percent must contact and cannot be diverted to solo', () => {
  const config = alwaysSilentConfig();
  config.solo.basePreference = 1;
  config.solo.libidoOverAttachmentWeight = 0;
  config.solo.afterContactBonus = 0;
  config.solo.afterSoloPenalty = 0;
  config.solo.fatigueWeight = 0;
  const state = stateWith(config, {
    libido: 1,
    attachment: 0.10,
    fatigue: 0.90,
  });
  const result = decideState(state, config, NOW);
  assert.ok(result.decision);
  assert.equal(result.decision.drive, 'libido');
  assert.equal(result.decision.intent, 'seek_closeness');
  assert.equal(result.expression.forcedReason, 'forced-at-full');
});

test('a completed solo is autonomous and resets the silence streak', () => {
  const config = structuredClone(baseConfig);
  config.expression.baseWillingness = 1;
  config.solo.basePreference = 1;
  config.solo.libidoOverAttachmentWeight = 0;
  config.solo.afterContactBonus = 0;
  config.solo.afterSoloPenalty = 0;
  config.solo.fatigueWeight = 0;
  const state = stateWith(config, {
    libido: 0.95,
    attachment: 0.10,
    fatigue: 0.10,
  });
  state.expression.consecutiveWithholds = 2;
  const result = decideState(state, config, NOW);
  assert.equal(result.decision.intent, 'solo');
  const satisfied = satisfySoloDecision(
    result.state, config, result.decision.id, NOW + 1,
  );
  assert.equal(satisfied.expression.consecutiveWithholds, 0);
  assert.ok(Math.abs(satisfied.drives.libido - 0.95 * config.solo.carryoverFactor) < 1e-12);
});

test('dropping below 78 percent breaks a consecutive silence streak', () => {
  const config = alwaysSilentConfig();
  const state = stateWith(config, { attachment: 0.77, fatigue: 0.10 });
  state.expression.consecutiveWithholds = 3;
  const result = decideState(state, config, NOW);
  assert.equal(result.decision, null);
  assert.equal(result.expression, null);
  assert.equal(result.state.expression.consecutiveWithholds, 0);
});
