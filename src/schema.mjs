import {
  ACTIVE_DRIVES,
  CONFIG_SCHEMA,
  DRIVES,
  intentMatchesDrive,
  STATE_SCHEMA,
  TIMELINE_MAX_COUNT,
  TIMELINE_OUTCOMES,
  TIMELINE_REASONS,
} from './constants.mjs';

export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
}

export function assertUnit(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`${label} must be between 0 and 1`);
  }
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ValidationError(`${label} must be an integer >= ${minimum}`);
  }
}

function assertTimePair(value, label, nullable = false) {
  if (nullable && value === null) return;
  assertPlainObject(value, label);
  if (!Number.isSafeInteger(value.epochMs) || value.epochMs < 0) {
    throw new ValidationError(`${label}.epochMs is invalid`);
  }
  if (typeof value.iso !== 'string' || Date.parse(value.iso) !== value.epochMs) {
    throw new ValidationError(`${label}.iso is inconsistent`);
  }
}

function assertDriveRecord(record, label, validator) {
  assertPlainObject(record, label);
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...DRIVES].sort().join(',')) {
    throw new ValidationError(`${label} must contain exactly the eight drives`);
  }
  for (const drive of DRIVES) validator(record[drive], `${label}.${drive}`);
}

export function validateConfig(config) {
  assertPlainObject(config, 'config');
  if (config.schema !== CONFIG_SCHEMA || config.version !== 2) {
    throw new ValidationError('unsupported config schema or version');
  }
  assertInteger(config.heartbeatSeconds, 'config.heartbeatSeconds', 1);
  if (typeof config.observeOnly !== 'boolean' || typeof config.deliveryEnabled !== 'boolean') {
    throw new ValidationError('observeOnly and deliveryEnabled must be booleans');
  }
  assertUnit(config.triggerThreshold, 'config.triggerThreshold');
  assertUnit(config.fatigueGate, 'config.fatigueGate');
  assertInteger(config.clockSkewToleranceSeconds, 'config.clockSkewToleranceSeconds');
  assertInteger(config.maxElapsedSeconds, 'config.maxElapsedSeconds', 1);
  assertUnit(config.selfDriveVariation, 'config.selfDriveVariation');
  assertPlainObject(config.solo, 'config.solo');
  if (typeof config.solo.enabled !== 'boolean') {
    throw new ValidationError('config.solo.enabled must be a boolean');
  }
  assertInteger(config.solo.cooldownSeconds, 'config.solo.cooldownSeconds', 1);
  for (const key of [
    'carryoverFactor', 'basePreference', 'libidoOverAttachmentWeight',
    'afterContactBonus', 'afterSoloPenalty', 'fatigueWeight',
  ]) assertUnit(config.solo[key], `config.solo.${key}`);
  assertUnit(config.satisfactionCarryoverFactor, 'config.satisfactionCarryoverFactor');
  assertPlainObject(config.thoughts, 'config.thoughts');
  for (const key of [
    'autoCreateAbove', 'autoFixationAbove', 'autoReinforcePerHeartbeat',
    'actionCarryoverFactor', 'flitDecay', 'fixationDecay', 'flitClearBelow',
  ]) assertUnit(config.thoughts[key], `config.thoughts.${key}`);
  if (config.thoughts.autoFixationAbove <= config.thoughts.autoCreateAbove) {
    throw new ValidationError('thought fixation threshold must exceed creation threshold');
  }
  if (config.thoughts.flitClearBelow >= config.thoughts.autoCreateAbove) {
    throw new ValidationError('thought clear threshold must remain below creation threshold');
  }
  assertInteger(config.thoughts.maxCount, 'config.thoughts.maxCount', 1);
  assertInteger(config.thoughts.maxTextLength, 'config.thoughts.maxTextLength', 1);
  assertDriveRecord(config.initialDrives, 'config.initialDrives', assertUnit);
  assertDriveRecord(config.driveGrowthPerHour, 'config.driveGrowthPerHour', (value, label) => {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ValidationError(`${label} must be between 0 and 1`);
    }
  });
  assertDriveRecord(config.driveHomeLevels, 'config.driveHomeLevels', assertUnit);
  assertDriveRecord(config.driveReturnPerHour, 'config.driveReturnPerHour', assertUnit);
  assertDriveRecord(config.satisfactionDrops, 'config.satisfactionDrops', assertUnit);
  return config;
}

function validateDecision(decision) {
  if (decision === null) return;
  assertPlainObject(decision, 'state.pendingDecision');
  if (typeof decision.id !== 'string' || !/^decision-[0-9]+-[0-9]+$/.test(decision.id)) {
    throw new ValidationError('pending decision id is invalid');
  }
  if (!ACTIVE_DRIVES.includes(decision.drive) || !intentMatchesDrive(decision.drive, decision.intent)) {
    throw new ValidationError('pending decision drive or intent is invalid');
  }
  assertUnit(decision.score, 'pending decision score');
  assertTimePair(decision.createdAt, 'pending decision createdAt');
  if (decision.status !== 'pending' || typeof decision.deliverySuppressed !== 'boolean' || decision.delivered !== false) {
    throw new ValidationError('pending decision safety flags are invalid');
  }
  assertPlainObject(decision.wantAction, 'pending decision wantAction');
  if (decision.wantAction.intent !== decision.intent || decision.wantAction.drive !== decision.drive) {
    throw new ValidationError('pending decision wantAction is inconsistent');
  }
  if (!Array.isArray(decision.deliveryBlockers) || decision.deliveryBlockers.some((item) => typeof item !== 'string')) {
    throw new ValidationError('pending decision deliveryBlockers is invalid');
  }
}

function validateTimeline(timeline) {
  if (timeline === undefined) return;
  if (!Array.isArray(timeline) || timeline.length > TIMELINE_MAX_COUNT) {
    throw new ValidationError('state.timeline is invalid');
  }
  for (const entry of timeline) {
    assertPlainObject(entry, 'timeline entry');
    const keys = Object.keys(entry).sort();
    const expectedKeys = [
      'at', 'drive', 'drives', 'intent', 'nextCheckAt',
      'outcome', 'reasons', 'score', 'willingness',
    ].sort();
    if (keys.join(',') !== expectedKeys.join(',')) {
      throw new ValidationError('timeline entry contains unexpected fields');
    }
    assertTimePair(entry.at, 'timeline entry at');
    assertTimePair(entry.nextCheckAt, 'timeline entry nextCheckAt');
    if (!TIMELINE_OUTCOMES.includes(entry.outcome)) {
      throw new ValidationError('timeline outcome is invalid');
    }
    if (entry.drive === null) {
      if (entry.intent !== null || entry.score !== null) {
        throw new ValidationError('timeline selection is inconsistent');
      }
    } else {
      if (!ACTIVE_DRIVES.includes(entry.drive) ||
          !intentMatchesDrive(entry.drive, entry.intent)) {
        throw new ValidationError('timeline selection is invalid');
      }
      assertUnit(entry.score, 'timeline score');
    }
    if (entry.willingness !== null) assertUnit(entry.willingness, 'timeline willingness');
    if (!Array.isArray(entry.reasons) || entry.reasons.length > 16 ||
        entry.reasons.some((reason) => !TIMELINE_REASONS.includes(reason)) ||
        new Set(entry.reasons).size !== entry.reasons.length) {
      throw new ValidationError('timeline reasons are invalid');
    }
    assertDriveRecord(entry.drives, 'timeline drives', assertUnit);
  }
}

function validateSolo(solo) {
  if (solo === undefined) return;
  assertPlainObject(solo, 'state.solo');
  assertInteger(solo.count, 'state.solo.count');
  assertTimePair(solo.lastSoloAt, 'state.solo.lastSoloAt', true);
  assertTimePair(solo.refractoryUntil, 'state.solo.refractoryUntil', true);
  if (![null, 'seek_closeness', 'solo'].includes(solo.lastLibidoChoice)) {
    throw new ValidationError('state.solo.lastLibidoChoice is invalid');
  }
}

export function validateState(state, config) {
  assertPlainObject(state, 'state');
  if (state.schema !== STATE_SCHEMA || state.version !== 2) {
    throw new ValidationError('unsupported state schema or version', 'STATE_CORRUPT');
  }
  assertInteger(state.sequence, 'state.sequence');
  assertTimePair(state.createdAt, 'state.createdAt');
  assertTimePair(state.updatedAt, 'state.updatedAt');
  assertTimePair(state.lastTickAt, 'state.lastTickAt');
  assertTimePair(state.lastDecisionAt, 'state.lastDecisionAt', true);
  assertDriveRecord(state.drives, 'state.drives', assertUnit);
  assertDriveRecord(state.lastSatisfiedAt, 'state.lastSatisfiedAt', (value, label) => assertTimePair(value, label, true));
  validateSolo(state.solo);
  if (!Array.isArray(state.thoughts) || state.thoughts.length > config.thoughts.maxCount) {
    throw new ValidationError('state.thoughts is invalid');
  }
  const ids = new Set();
  for (const thought of state.thoughts) {
    assertPlainObject(thought, 'thought');
    if (typeof thought.id !== 'string' || !/^thought-[0-9]+-[0-9]+$/.test(thought.id) || ids.has(thought.id)) {
      throw new ValidationError('thought id is invalid');
    }
    ids.add(thought.id);
    if (!DRIVES.includes(thought.drive) || !['flit', 'fixation'].includes(thought.type)) {
      throw new ValidationError('thought drive or type is invalid');
    }
    if (thought.source !== undefined && !['automatic', 'manual'].includes(thought.source)) {
      throw new ValidationError('thought source is invalid');
    }
    assertUnit(thought.intensity, 'thought intensity');
    assertInteger(thought.fedCount, 'thought fedCount');
    if (typeof thought.text !== 'string' || thought.text.length === 0 ||
        thought.text.length > config.thoughts.maxTextLength || /[\u0000-\u001f\u007f]/u.test(thought.text)) {
      throw new ValidationError('thought text is invalid');
    }
    assertTimePair(thought.createdAt, 'thought createdAt');
    assertTimePair(thought.updatedAt, 'thought updatedAt');
  }
  validateTimeline(state.timeline);
  validateDecision(state.pendingDecision);
  return state;
}