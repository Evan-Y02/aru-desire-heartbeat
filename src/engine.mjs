import {
  ACTIVE_DRIVES,
  DRIVES,
  INTENT_BY_DRIVE,
  SOLO_INTENT,
  STATE_SCHEMA,
} from './constants.mjs';
import { assertUnit, validateState, ValidationError } from './schema.mjs';

export const clamp = (value) => Math.min(1, Math.max(0, value));
export const timePair = (epochMs) => ({ iso: new Date(epochMs).toISOString(), epochMs });

const AUTOMATIC_THOUGHT_TEXT = Object.freeze({
  attachment: '想靠近你',
  curiosity: '想看看新的东西，再来与你分享',
  reflection: '想安静整理最近的感受',
  duty: '还有事情挂在心上',
  social: '想和熟悉的人说说话',
  fatigue: '想停下来休息',
  libido: '想与你亲密',
  stress: '想缓一缓、寻求安定',
});

function clone(value) {
  return structuredClone(value);
}

function requireSafeClock(state, config, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 ||
      nowMs + config.clockSkewToleranceSeconds * 1000 < state.updatedAt.epochMs) {
    throw new ValidationError('clock moved backwards or is invalid', 'CLOCK_ANOMALY');
  }
}

export function createInitialState(config, epochMs = Date.now()) {
  const at = timePair(epochMs);
  const lastSatisfiedAt = Object.fromEntries(DRIVES.map((drive) => [drive, null]));
  return {
    schema: STATE_SCHEMA,
    version: 2,
    sequence: 0,
    createdAt: at,
    updatedAt: at,
    lastTickAt: at,
    lastDecisionAt: null,
    drives: clone(config.initialDrives),
    lastSatisfiedAt,
    thoughts: [],
    timeline: [],
    pendingDecision: null,
    solo: {
      count: 0,
      lastSoloAt: null,
      refractoryUntil: null,
      lastLibidoChoice: null,
    },
  };
}

function nextSequence(state) {
  state.sequence += 1;
  return state.sequence;
}

function deterministicUnit(seed) {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0xffff_ffff;
}

export function selfDriveFactor(nowMs, heartbeatSeconds, drive, variation) {
  const bucket = Math.floor(nowMs / (heartbeatSeconds * 1000));
  const unit = deterministicUnit(`${bucket}:${drive}`);
  return 1 + (unit * 2 - 1) * variation;
}

export function chooseLibidoIntent(state, config, nowMs) {
  const refractoryUntil = state.solo.refractoryUntil?.epochMs ?? 0;
  if (!config.solo.enabled || nowMs < refractoryUntil) {
    return { intent: 'seek_closeness', soloEligible: false, soloPreference: 0, draw: null };
  }
  const previousBias = state.solo.lastLibidoChoice === 'seek_closeness'
    ? config.solo.afterContactBonus
    : state.solo.lastLibidoChoice === SOLO_INTENT
      ? -config.solo.afterSoloPenalty
      : 0;
  const soloPreference = clamp(
    config.solo.basePreference
      + (state.drives.libido - state.drives.attachment) *
        config.solo.libidoOverAttachmentWeight
      + previousBias
      - state.drives.fatigue * config.solo.fatigueWeight,
  );
  const bucket = Math.floor(nowMs / (config.heartbeatSeconds * 1000));
  const draw = deterministicUnit(`${bucket}:libido:solo-route`);
  return {
    intent: draw < soloPreference ? SOLO_INTENT : 'seek_closeness',
    soloEligible: true,
    soloPreference,
    draw,
  };
}

function routeCandidate(state, config, nowMs, candidate) {
  if (candidate?.drive !== 'libido') return candidate;
  return { ...candidate, intent: chooseLibidoIntent(state, config, nowMs).intent };
}

function moveToward(current, target, maximumChange) {
  if (maximumChange <= 0 || current === target) return current;
  if (current < target) return Math.min(target, current + maximumChange);
  return Math.max(target, current - maximumChange);
}

function updateDrivesForElapsed(state, config, elapsedMs, nowMs) {
  const hours = elapsedMs / 3_600_000;
  for (const drive of DRIVES) {
    const factor = selfDriveFactor(
      nowMs, config.heartbeatSeconds, drive, config.selfDriveVariation,
    );
    const grown = clamp(
      state.drives[drive] + config.driveGrowthPerHour[drive] * hours * factor,
    );
    state.drives[drive] = clamp(moveToward(
      grown,
      config.driveHomeLevels[drive],
      config.driveReturnPerHour[drive] * hours,
    ));
  }
}

export function synchronizeThoughts(state, config, nowMs) {
  const retained = [];
  const automaticDrives = new Set();
  for (const original of state.thoughts) {
    const thought = clone(original);
    const automatic = thought.source === 'automatic';
    const driveValue = state.drives[thought.drive];
    if (automatic) {
      if (automaticDrives.has(thought.drive)) continue;
      automaticDrives.add(thought.drive);
      if (driveValue >= config.thoughts.autoCreateAbove) {
        thought.intensity = clamp(
          Math.max(thought.intensity, driveValue) + config.thoughts.autoReinforcePerHeartbeat,
        );
        thought.type = thought.intensity >= config.thoughts.autoFixationAbove
          ? 'fixation'
          : 'flit';
      } else {
        const decay = thought.type === 'fixation'
          ? config.thoughts.fixationDecay
          : config.thoughts.flitDecay;
        thought.intensity = clamp(thought.intensity * decay);
        if (thought.intensity < config.thoughts.flitClearBelow) continue;
        if (thought.intensity < config.thoughts.autoFixationAbove) thought.type = 'flit';
      }
    } else {
      const decay = thought.type === 'fixation'
        ? config.thoughts.fixationDecay
        : config.thoughts.flitDecay;
      thought.intensity = clamp(thought.intensity * decay);
      if (thought.intensity < config.thoughts.flitClearBelow) continue;
      if (thought.intensity >= config.thoughts.autoFixationAbove) thought.type = 'fixation';
    }
    thought.updatedAt = timePair(nowMs);
    retained.push(thought);
  }

  for (const drive of DRIVES) {
    if (automaticDrives.has(drive) ||
        state.drives[drive] < config.thoughts.autoCreateAbove ||
        retained.length >= config.thoughts.maxCount) continue;
    const sequence = nextSequence(state);
    const at = timePair(nowMs);
    retained.push({
      id: `thought-${nowMs}-${sequence}`,
      drive,
      type: state.drives[drive] >= config.thoughts.autoFixationAbove ? 'fixation' : 'flit',
      intensity: state.drives[drive],
      fedCount: 0,
      text: AUTOMATIC_THOUGHT_TEXT[drive],
      source: 'automatic',
      createdAt: at,
      updatedAt: at,
    });
  }
  state.thoughts = retained;
}

export function pickIntent(drives) {
  let selected = null;
  for (const drive of ACTIVE_DRIVES) {
    const score = drives[drive];
    if (selected === null || score > selected.score) {
      selected = { drive, intent: INTENT_BY_DRIVE[drive], score };
    }
  }
  return selected;
}

export function sentinel(state, config, nowMs, candidate, { clockValid = true } = {}) {
  const formationBlockers = [];
  if (!clockValid) formationBlockers.push('clock-anomaly');
  if (state.pendingDecision !== null) formationBlockers.push('pending-decision');
  if (state.drives.fatigue >= config.fatigueGate) formationBlockers.push('fatigue-gate');
  if (candidate === null || candidate.score < config.triggerThreshold) formationBlockers.push('below-trigger-threshold');

  const deliveryBlockers = [];
  if (config.observeOnly) deliveryBlockers.push('observe-only');
  if (!config.deliveryEnabled) deliveryBlockers.push('delivery-disabled');
  return {
    canFormDecision: formationBlockers.length === 0,
    canDeliver: deliveryBlockers.length === 0,
    formationBlockers,
    deliveryBlockers,
  };
}

export function formDecision(state, config, nowMs, { clockValid = true } = {}) {
  let candidate = pickIntent(state.drives);
  const guard = sentinel(state, config, nowMs, candidate, { clockValid });
  if (!guard.canFormDecision) {
    return { decision: null, candidate, sentinel: guard, expression: null };
  }
  candidate = routeCandidate(state, config, nowMs, candidate);
  const sequence = nextSequence(state);
  const isSolo = candidate.intent === SOLO_INTENT;
  const deliveryBlockers = isSolo ? [] : guard.deliveryBlockers;
  const decision = {
    id: `decision-${nowMs}-${sequence}`,
    drive: candidate.drive,
    intent: candidate.intent,
    score: candidate.score,
    wantAction: { intent: candidate.intent, drive: candidate.drive },
    createdAt: timePair(nowMs),
    status: 'pending',
    deliverySuppressed: isSolo ? config.observeOnly : !guard.canDeliver,
    delivered: false,
    deliveryBlockers,
  };
  state.pendingDecision = decision;
  state.lastDecisionAt = timePair(nowMs);
  return { decision, candidate, sentinel: guard, expression: null };
}

export function tickState(input, config, nowMs = Date.now()) {
  validateState(input, config);
  const state = clone(input);
  const backwardsMs = state.lastTickAt.epochMs - nowMs;
  if (backwardsMs > config.clockSkewToleranceSeconds * 1000) {
    throw new ValidationError('clock moved backwards', 'CLOCK_ANOMALY');
  }
  const elapsedMs = Math.max(0, nowMs - state.lastTickAt.epochMs);
  if (elapsedMs > config.maxElapsedSeconds * 1000) {
    throw new ValidationError('elapsed time exceeds configured safety limit', 'CLOCK_ANOMALY');
  }
  updateDrivesForElapsed(state, config, elapsedMs, nowMs);
  synchronizeThoughts(state, config, nowMs);
  const result = formDecision(state, config, nowMs);
  state.lastTickAt = timePair(nowMs);
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return { state, elapsedSeconds: elapsedMs / 1000, ...result };
}

export function decideState(input, config, nowMs = Date.now()) {
  validateState(input, config);
  const state = clone(input);
  requireSafeClock(state, config, nowMs);
  const result = formDecision(state, config, nowMs);
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return { state, ...result };
}

export function rebaseClock(input, config, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  if (input.pendingDecision !== null) {
    throw new ValidationError(
      'clock rebase is blocked while a decision is pending',
      'PENDING_DECISION',
    );
  }
  const state = clone(input);
  const at = timePair(nowMs);
  nextSequence(state);
  state.lastTickAt = at;
  state.updatedAt = at;
  validateState(state, config);
  return state;
}

function requireManageableDrive(input, drive) {
  if (!DRIVES.includes(drive)) throw new ValidationError('unknown drive');
  if (input.pendingDecision !== null) {
    throw new ValidationError(
      'drive management is blocked while a decision is pending',
      'PENDING_DECISION',
    );
  }
}

export function setDrive(input, config, drive, value, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  requireManageableDrive(input, drive);
  assertUnit(value, 'drive value');
  const state = clone(input);
  state.drives[drive] = value;
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return state;
}

export function adjustDrive(input, config, drive, delta, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  requireManageableDrive(input, drive);
  if (!Number.isFinite(delta) || delta < -1 || delta > 1 || delta === 0) {
    throw new ValidationError('drive delta must be non-zero and between -1 and 1');
  }
  const state = clone(input);
  state.drives[drive] = clamp(Number((state.drives[drive] + delta).toFixed(12)));
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return state;
}

export function feedDrive(input, config, drive, amount, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  if (!DRIVES.includes(drive)) throw new ValidationError('unknown drive');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1) throw new ValidationError('feed amount must be > 0 and <= 1');
  const state = clone(input);
  state.drives[drive] = clamp(state.drives[drive] + amount);
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return state;
}

export function addThought(input, config, { drive, type, intensity, text }, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  if (!DRIVES.includes(drive)) throw new ValidationError('unknown thought drive');
  if (!['flit', 'fixation'].includes(type)) throw new ValidationError('thought type must be flit or fixation');
  assertUnit(intensity, 'thought intensity');
  if (typeof text !== 'string' || text.length === 0 || text.length > config.thoughts.maxTextLength ||
      /[\u0000-\u001f\u007f]/u.test(text)) throw new ValidationError('thought text is invalid');
  if (input.thoughts.length >= config.thoughts.maxCount) throw new ValidationError('thought pool is full');
  const state = clone(input);
  const sequence = nextSequence(state);
  const at = timePair(nowMs);
  state.thoughts.push({
    id: `thought-${nowMs}-${sequence}`,
    drive,
    type,
    intensity,
    fedCount: 0,
    text,
    source: 'manual',
    createdAt: at,
    updatedAt: at,
  });
  state.updatedAt = at;
  validateState(state, config);
  return state;
}

function requireMatchingDecision(input, decisionId) {
  if (typeof decisionId !== 'string' || decisionId.length === 0) {
    throw new ValidationError('decision id is required');
  }
  if (input.pendingDecision === null || input.pendingDecision.id !== decisionId) {
    throw new ValidationError('decision id does not match the pending decision', 'DECISION_MISMATCH');
  }
}

function settleAutomaticThought(state, config, drive, nowMs) {
  const retained = [];
  for (const original of state.thoughts) {
    if (original.drive !== drive || original.source !== 'automatic') {
      retained.push(original);
      continue;
    }
    const thought = clone(original);
    thought.intensity = clamp(
      thought.intensity * config.thoughts.actionCarryoverFactor,
    );
    if (thought.intensity < config.thoughts.flitClearBelow) continue;
    thought.type = 'flit';
    thought.updatedAt = timePair(nowMs);
    retained.push(thought);
  }
  state.thoughts = retained;
}

export function satisfySoloDecision(input, config, decisionId, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  requireMatchingDecision(input, decisionId);
  if (input.pendingDecision.drive !== 'libido' || input.pendingDecision.intent !== SOLO_INTENT) {
    throw new ValidationError('pending decision is not a solo decision', 'DECISION_MISMATCH');
  }
  const state = clone(input);
  state.drives.libido = clamp(state.drives.libido * config.solo.carryoverFactor);
  state.lastSatisfiedAt.libido = timePair(nowMs);
  state.solo.count += 1;
  state.solo.lastSoloAt = timePair(nowMs);
  state.solo.refractoryUntil = timePair(nowMs + config.solo.cooldownSeconds * 1000);
  state.solo.lastLibidoChoice = SOLO_INTENT;
  settleAutomaticThought(state, config, 'libido', nowMs);
  state.pendingDecision = null;
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return state;
}

export function satisfyDecision(input, config, decisionId, nowMs = Date.now()) {
  validateState(input, config);
  requireSafeClock(input, config, nowMs);
  requireMatchingDecision(input, decisionId);
  if (input.pendingDecision.intent === SOLO_INTENT) {
    throw new ValidationError('solo decisions require solo satisfaction', 'DECISION_MISMATCH');
  }
  const state = clone(input);
  const drive = state.pendingDecision.drive;
  for (const activeDrive of ACTIVE_DRIVES) {
    if (activeDrive === drive) continue;
    state.drives[activeDrive] = clamp(
      state.drives[activeDrive] * config.satisfactionCarryoverFactor,
    );
  }
  state.drives[drive] = clamp(
    state.drives[drive] * (1 - config.satisfactionDrops[drive]),
  );
  state.lastSatisfiedAt[drive] = timePair(nowMs);
  if (drive === 'libido') state.solo.lastLibidoChoice = 'seek_closeness';
  settleAutomaticThought(state, config, drive, nowMs);
  state.pendingDecision = null;
  state.updatedAt = timePair(nowMs);
  validateState(state, config);
  return state;
}

export function simulateState(input, config, ticks, stepSeconds = config.heartbeatSeconds) {
  validateState(input, config);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000) throw new ValidationError('ticks must be an integer from 1 to 10000');
  if (!Number.isSafeInteger(stepSeconds) || stepSeconds < 1 || stepSeconds > config.maxElapsedSeconds) {
    throw new ValidationError('step seconds is outside the safe range');
  }
  let state = clone(input);
  const start = state.lastTickAt.epochMs;
  const decisions = [];
  for (let index = 1; index <= ticks; index += 1) {
    const result = tickState(state, config, start + index * stepSeconds * 1000);
    state = result.state;
    if (result.decision) decisions.push(result.decision);
  }
  return { state, decisions };
}

export function simulateAutonomy(input, config, ticks, stepSeconds = config.heartbeatSeconds) {
  validateState(input, config);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 10000) {
    throw new ValidationError('ticks must be an integer from 1 to 10000');
  }
  if (!Number.isSafeInteger(stepSeconds) || stepSeconds < 1 || stepSeconds > config.maxElapsedSeconds) {
    throw new ValidationError('step seconds is outside the safe range');
  }
  let state = clone(input);
  const start = state.lastTickAt.epochMs;
  const impulses = [];
  const contacts = [];
  const solos = [];
  for (let index = 1; index <= ticks; index += 1) {
    const nowMs = start + index * stepSeconds * 1000;
    const result = tickState(state, config, nowMs);
    state = result.state;
    if (state.pendingDecision) {
      const decision = structuredClone(state.pendingDecision);
      impulses.push({
        at: timePair(nowMs),
        drive: decision.drive,
        intent: decision.intent,
        score: decision.score,
        expressed: true,
        willingness: 1,
      });
      if (decision.intent === SOLO_INTENT) {
        solos.push(decision);
        state = satisfySoloDecision(state, config, decision.id, nowMs);
      } else {
        contacts.push(decision);
        state = satisfyDecision(state, config, decision.id, nowMs);
      }
    }
  }
  return { state, impulses, contacts, solos };
}

export function publicSnapshot(state, extra = {}) {
  return {
    schema: 'aru.desire-heartbeat.output.v1',
    at: state.updatedAt,
    drives: state.drives,
    thoughtCount: state.thoughts.length,
    thoughtTypes: {
      flit: state.thoughts.filter((thought) => thought.type === 'flit').length,
      fixation: state.thoughts.filter((thought) => thought.type === 'fixation').length,
    },
    solo: {
      count: state.solo.count,
      lastSoloAt: state.solo.lastSoloAt,
      refractoryUntil: state.solo.refractoryUntil,
      lastLibidoChoice: state.solo.lastLibidoChoice,
    },
    pendingDecision: state.pendingDecision === null ? null : {
      id: state.pendingDecision.id,
      drive: state.pendingDecision.drive,
      intent: state.pendingDecision.intent,
      wantAction: state.pendingDecision.wantAction,
      score: state.pendingDecision.score,
      deliverySuppressed: state.pendingDecision.deliverySuppressed,
      delivered: false,
    },
    ...extra,
  };
}