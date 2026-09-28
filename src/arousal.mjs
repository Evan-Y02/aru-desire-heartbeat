import { createHash } from 'node:crypto';
import { ValidationError } from './schema.mjs';

export const AROUSAL_STATE_SCHEMA = 'aru.desire-heartbeat.arousal-state.v1';
const GATES = new Set(['locked', 'unlocked', 'release_once']);
const ACTION_MULTIPLIERS = Object.freeze({
  contact: 0.24,
  hold: 0.34,
  kiss: 0.55,
  stroke: 0.72,
  rub: 0.86,
  thrust: 1.00,
  climax: 0.18,
});
const BODY_MULTIPLIERS = Object.freeze({
  general: 0.55,
  lips: 0.70,
  chest: 0.78,
  inner_thigh: 0.85,
  genitals: 1.00,
});
const POSTURE_MULTIPLIERS = Object.freeze({
  neutral: 1.00,
  close: 1.04,
  pressed: 1.08,
});

const clamp = (value) => Math.min(1, Math.max(0, value));
const timePair = (epochMs) => ({ iso: new Date(epochMs).toISOString(), epochMs });
const digest = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex')}`;

function requireTime(nowMs, previousMs = 0) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < previousMs) {
    throw new ValidationError('arousal clock moved backwards or is invalid', 'CLOCK_ANOMALY');
  }
}

function requireUnit(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`${label} must be between 0 and 1`, 'AROUSAL_STATE_CORRUPT');
  }
}

export function createArousalState(epochMs = Date.now()) {
  requireTime(epochMs);
  const at = timePair(epochMs);
  return {
    schema: AROUSAL_STATE_SCHEMA,
    version: 1,
    value: 0,
    updatedAt: at,
    refractoryUntil: null,
    reserve: 1,
    reserveAt: at,
    releaseGate: 'locked',
    processedEvents: [],
    pendingReleaseReceipt: null,
    lastClimaxQuality: null,
    lastOutput: null,
  };
}

export function validateArousalState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
      state.schema !== AROUSAL_STATE_SCHEMA || state.version !== 1) {
    throw new ValidationError('unsupported arousal state', 'AROUSAL_STATE_CORRUPT');
  }
  requireUnit(state.value, 'arousal value');
  requireUnit(state.reserve, 'arousal reserve');
  for (const [label, pair, nullable] of [
    ['updatedAt', state.updatedAt, false],
    ['reserveAt', state.reserveAt, false],
    ['refractoryUntil', state.refractoryUntil, true],
  ]) {
    if (nullable && pair === null) continue;
    if (pair === null || typeof pair !== 'object' || !Number.isSafeInteger(pair.epochMs) ||
        pair.epochMs < 0 || typeof pair.iso !== 'string' || Date.parse(pair.iso) !== pair.epochMs) {
      throw new ValidationError(`arousal ${label} is invalid`, 'AROUSAL_STATE_CORRUPT');
    }
  }
  if (!Array.isArray(state.processedEvents) ||
      state.processedEvents.length > 4096 ||
      state.processedEvents.some((id) => typeof id !== 'string' || !/^event-[a-f0-9]{64}$/.test(id)) ||
      new Set(state.processedEvents).size !== state.processedEvents.length) {
    throw new ValidationError('arousal event ledger is invalid', 'AROUSAL_STATE_CORRUPT');
  }
  if (state.lastClimaxQuality !== null) requireUnit(state.lastClimaxQuality, 'last climax quality');
  if (state.lastOutput !== null) requireUnit(state.lastOutput, 'last output');
  if (state.pendingReleaseReceipt !== null) {
    const receipt = state.pendingReleaseReceipt;
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !==
          'cause,climaxQuality,createdAt,delivered,effectId,eventId,output,receiptId,reserveCost' ||
        typeof receipt.receiptId !== 'string' || !/^receipt-[a-f0-9]{64}$/.test(receipt.receiptId) ||
        typeof receipt.effectId !== 'string' || !/^effect-[a-f0-9]{64}$/.test(receipt.effectId) ||
        typeof receipt.eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(receipt.eventId) ||
        typeof receipt.delivered !== 'boolean' ||
        !['solo', 'partnered'].includes(receipt.cause)) {
      throw new ValidationError('release receipt is invalid', 'AROUSAL_STATE_CORRUPT');
    }
    requireUnit(receipt.climaxQuality, 'receipt climax quality');
    requireUnit(receipt.output, 'receipt output');
    requireUnit(receipt.reserveCost, 'receipt reserve cost');
    requireTime(receipt.createdAt?.epochMs);
    if (Date.parse(receipt.createdAt.iso) !== receipt.createdAt.epochMs) {
      throw new ValidationError('release receipt timestamp is invalid', 'AROUSAL_STATE_CORRUPT');
    }
  }
  return state;
}

function safeGate(gate) {
  return GATES.has(gate) ? gate : 'locked';
}

export function setReleaseGate(input, gate) {
  const state = structuredClone(validateArousalState(input));
  const commands = { lock: 'locked', unlock: 'unlocked', release_once: 'release_once' };
  const resolved = commands[gate] ?? gate;
  state.releaseGate = GATES.has(resolved) ? resolved : 'locked';
  return state;
}

function recoveredReserve(state, config, nowMs) {
  const elapsed = Math.max(0, nowMs - state.reserveAt.epochMs);
  return clamp(state.reserve + elapsed / (config.reserveRecoverySeconds * 1000));
}

function advanceBody(state, config, nowMs) {
  requireTime(nowMs, state.updatedAt.epochMs);
  const elapsedSeconds = (nowMs - state.updatedAt.epochMs) / 1000;
  state.value = clamp(state.value * Math.exp(-elapsedSeconds / config.tauSeconds));
  state.reserve = recoveredReserve(state, config, nowMs);
  state.updatedAt = timePair(nowMs);
  state.reserveAt = timePair(nowMs);
  if (state.refractoryUntil?.epochMs <= nowMs) state.refractoryUntil = null;
}

function deterministicRefractory(eventId, config) {
  const hex = createHash('sha256').update(`refractory:${eventId}`).digest('hex').slice(0, 8);
  const unit = Number.parseInt(hex, 16) / 0xffff_ffff;
  return Math.round(
    config.refractoryMinSeconds +
    unit * (config.refractoryMaxSeconds - config.refractoryMinSeconds),
  );
}

function normalizeStimuli(stimuli) {
  if (!Array.isArray(stimuli)) return [];
  const unique = new Map();
  for (const item of stimuli) {
    if (item === null || typeof item !== 'object') continue;
    const action = Object.hasOwn(ACTION_MULTIPLIERS, item.action) ? item.action : null;
    const bodyPart = Object.hasOwn(BODY_MULTIPLIERS, item.bodyPart) ? item.bodyPart : null;
    const posture = Object.hasOwn(POSTURE_MULTIPLIERS, item.posture) ? item.posture : null;
    if (!action || !bodyPart || !posture || !['active', 'passive'].includes(item.mode)) continue;
    const key = `${action}:${bodyPart}:${posture}:${item.direction ?? 'mutual'}`;
    const strength = Number.isFinite(item.strength) && item.strength >= 0 && item.strength <= 1
      ? item.strength
      : 1;
    unique.set(key, { ...item, action, bodyPart, posture, strength });
  }
  return [...unique.values()];
}

export function applyArousalEvent(input, config, event, libidoSensitivity = 0, nowMs) {
  const original = validateArousalState(input);
  const state = structuredClone(original);
  const eventId = event?.eventId;
  if (typeof eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(eventId)) {
    throw new ValidationError('arousal event id is invalid', 'AROUSAL_EVENT_INVALID');
  }
  requireUnit(libidoSensitivity, 'libido sensitivity');
  if (state.processedEvents.includes(eventId)) {
    return { state, applied: false, released: false, receipt: state.pendingReleaseReceipt };
  }
  requireTime(nowMs, state.updatedAt.epochMs);
  advanceBody(state, config, nowMs);
  const stimuli = normalizeStimuli(event.stimuli);
  const refractory = state.refractoryUntil !== null && nowMs < state.refractoryUntil.epochMs;
  const sensitivity = 0.80 + libidoSensitivity * 0.40;
  let activeCount = 0;
  let releaseSignal = false;
  for (const stimulus of stimuli) {
    const base = config.gain * ACTION_MULTIPLIERS[stimulus.action] *
      BODY_MULTIPLIERS[stimulus.bodyPart] * POSTURE_MULTIPLIERS[stimulus.posture] * sensitivity;
    const gain = base * stimulus.strength * (refractory ? 0.20 : 1);
    if (stimulus.mode === 'passive') {
      state.value = Math.min(config.passiveContactCap, state.value + gain * 0.35);
    } else {
      activeCount += 1;
      state.value = clamp(state.value + gain);
    }
    releaseSignal ||= stimulus.releaseSignal === true;
  }

  state.releaseGate = safeGate(state.releaseGate);
  let receipt = null;
  const canRelease = releaseSignal && !refractory && state.value >= config.ponr &&
    state.releaseGate !== 'locked' && state.pendingReleaseReceipt === null;
  if (canRelease) {
    const quality = clamp(0.70 + (state.value - config.ponr) * 4 + activeCount * 0.035);
    const baseOutput = clamp(state.reserve * (0.30 + quality * 0.70));
    const outputMultiplier = Number.isFinite(event.outputMultiplier) &&
      event.outputMultiplier >= 0 && event.outputMultiplier <= 1 ? event.outputMultiplier : 1;
    const reserveCostMultiplier = Number.isFinite(event.reserveCostMultiplier) &&
      event.reserveCostMultiplier >= 0 && event.reserveCostMultiplier <= 1
      ? event.reserveCostMultiplier
      : 1;
    const output = clamp(baseOutput * outputMultiplier);
    const reserveCost = clamp(baseOutput * reserveCostMultiplier);
    const refractorySeconds = deterministicRefractory(eventId, config);
    const receiptId = digest('receipt', eventId);
    receipt = {
      receiptId,
      effectId: digest('effect', receiptId),
      eventId,
      cause: event.cause === 'solo' ? 'solo' : 'partnered',
      createdAt: timePair(nowMs),
      climaxQuality: quality,
      output,
      reserveCost,
      delivered: false,
    };
    state.pendingReleaseReceipt = receipt;
    state.lastClimaxQuality = quality;
    state.lastOutput = output;
    state.reserve = clamp(state.reserve - reserveCost);
    state.reserveAt = timePair(nowMs);
    state.refractoryUntil = timePair(nowMs + refractorySeconds * 1000);
    state.value = clamp(0.10 + state.value * 0.08);
    if (state.releaseGate === 'release_once') state.releaseGate = 'locked';
  }

  state.processedEvents = [...state.processedEvents, eventId].slice(-config.ledgerMaxCount);
  return { state, applied: stimuli.length > 0, released: receipt !== null, receipt };
}

export function applyReleaseReceiptToDesire(arousalInput, desireInput, rootConfig) {
  const arousal = structuredClone(validateArousalState(arousalInput));
  const desire = structuredClone(desireInput);
  const receipt = arousal.pendingReleaseReceipt;
  const carryover = receipt?.cause === 'solo'
    ? rootConfig.solo.carryoverFactor
    : rootConfig.arousal.releaseCarryoverFactor;
  if (!receipt || rootConfig.arousalDriveSettlementEnabled !== true || carryover === null) {
    return { arousal, desire, applied: false };
  }
  const ledger = Array.isArray(desire.appliedEffectIds) ? desire.appliedEffectIds : [];
  if (!ledger.includes(receipt.effectId)) {
    desire.drives.libido = clamp(
      desire.drives.libido * carryover,
    );
    desire.appliedEffectIds = [...ledger, receipt.effectId].slice(-512);
    desire.lastSatisfiedAt.libido = structuredClone(receipt.createdAt);
    desire.updatedAt = structuredClone(receipt.createdAt);
  }
  receipt.delivered = true;
  arousal.pendingReleaseReceipt = null;
  return { arousal, desire, applied: !ledger.includes(receipt.effectId) };
}

export function applyNoReleaseSettlement(desireInput, rootConfig, {
  effectId, cause = 'partnered', nowMs = Date.now(),
}) {
  const desire = structuredClone(desireInput);
  if (rootConfig.arousalDriveSettlementEnabled !== true ||
      typeof effectId !== 'string' || !/^effect-[a-f0-9]{64}$/.test(effectId)) {
    return { desire, applied: false };
  }
  const ledger = Array.isArray(desire.appliedEffectIds) ? desire.appliedEffectIds : [];
  if (ledger.includes(effectId)) return { desire, applied: false };
  const carryover = rootConfig.chatStimulus.intimacyNoReleaseCarryoverFactor;
  if (!Number.isFinite(carryover)) return { desire, applied: false };
  desire.drives.libido = clamp(desire.drives.libido * carryover);
  desire.appliedEffectIds = [...ledger, effectId].slice(-512);
  desire.lastSatisfiedAt.libido = timePair(nowMs);
  if (cause === 'solo') desire.solo.lastLibidoChoice = 'solo';
  desire.updatedAt = timePair(nowMs);
  return { desire, applied: true };
}

function label(value, low, high) {
  if (value === null) return null;
  if (value >= high) return 'high';
  if (value >= low) return 'medium';
  return 'low';
}

export function qualitativeArousalPhase(state, config, nowMs = Date.now()) {
  validateArousalState(state);
  if (state.pendingReleaseReceipt) return 'pending';
  if (state.refractoryUntil?.epochMs > nowMs) return 'refractory';
  if (safeGate(state.releaseGate) === 'locked') return 'locked';
  if (state.value >= config.edge) return 'edge';
  if (state.value >= config.charged) return 'charged';
  return 'idle';
}

export function publicArousalStatus(state, config, nowMs = Date.now()) {
  const phase = qualitativeArousalPhase(state, config, nowMs);
  const phaseLabels = {
    idle: 'idle', charged: 'charged', edge: 'edge', locked: 'locked',
    pending: 'pending', refractory: 'refractory',
  };
  return {
    reserve: state.reserve,
    reserve_label: label(state.reserve, 0.34, 0.67),
    phase,
    phase_label: phaseLabels[phase],
    refractory: state.refractoryUntil?.epochMs > nowMs,
    last_climax_quality: state.lastClimaxQuality,
    last_climax_quality_label: label(state.lastClimaxQuality, 0.50, 0.80),
    last_output: state.lastOutput,
    last_output_label: label(state.lastOutput, 0.34, 0.67),
  };
}
