import { createHash } from 'node:crypto';
import {
  applyArousalEvent,
  applyNoReleaseSettlement,
  applyReleaseReceiptToDesire,
  qualitativeArousalPhase,
  setReleaseGate,
} from './arousal.mjs';
import { timePair } from './engine.mjs';
import { ValidationError } from './schema.mjs';

export const SOLO_GENERATION_SCHEMA = 'aru.desire-heartbeat.solo-generation.v1';
const PHASES = new Set([
  'selected', 'preparing', 'active', 'edge', 'completed_release',
  'completed_no_release', 'aborted', 'settled',
]);
const ACTIONS = new Set(['contact', 'hold', 'kiss', 'stroke', 'rub', 'thrust', 'release']);
const BODY_PARTS = new Set(['general', 'lips', 'chest', 'inner_thigh', 'genitals']);
const RHYTHMS = new Set(['slow', 'steady', 'pulsed', 'fast']);
const DURATIONS = Object.freeze({ short: 10, medium: 30, long: 60 });
const POSTURES = new Set(['neutral', 'close', 'pressed']);
const OUTCOMES = new Set(['release', 'no_release', 'edge', 'abort']);
const TEXT_FIELDS = [
  'triggerReason', 'thought', 'choiceReason', 'processSummary', 'afterBody', 'afterThought',
];

const digest = (prefix, value) =>
  `${prefix}-${createHash('sha256').update(value).digest('hex')}`;

function requireTime(epochMs, previous = 0) {
  if (!Number.isSafeInteger(epochMs) || epochMs < previous || epochMs < 0) {
    throw new ValidationError('solo session clock is invalid', 'SOLO_SESSION_INVALID');
  }
}

function safeText(value, label, maximum = 800) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be text`, 'SOLO_GENERATION_INVALID');
  }
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
      /(?:bearer|password|api[_ -]?key|auth\.json|private key|access token|digest|账本)/iu.test(text)) {
    throw new ValidationError(`${label} is unsafe or out of bounds`, 'SOLO_GENERATION_INVALID');
  }
  return text;
}

function sessionIdFor(decision) {
  const suffix = String(decision.id).split('-').at(-1);
  return `solo-session-${decision.createdAt.epochMs}-${suffix}`;
}

function clone(value) {
  return structuredClone(value);
}

export function createSoloSessionStore() {
  return {
    activeSessionId: null,
    sessions: [],
    processedRunIds: [],
    processedStepIds: [],
  };
}

function currentSession(store) {
  if (!store.activeSessionId) return null;
  return store.sessions.find((session) => session.sessionId === store.activeSessionId) ?? null;
}

function replaceSession(store, session, maximum) {
  const others = store.sessions.filter((item) => item.sessionId !== session.sessionId);
  store.sessions = [...others, session].slice(-maximum);
  store.activeSessionId = session.phase === 'settled' ? null : session.sessionId;
}

function transition(session, phase, at) {
  if (!PHASES.has(phase)) throw new ValidationError('solo phase is invalid');
  session.phase = phase;
  session.transitions.push({ phase, at: timePair(at) });
}

export function validateSoloSessionStore(store, config) {
  if (store === null || typeof store !== 'object' || Array.isArray(store) ||
      !Array.isArray(store.sessions) || store.sessions.length > config.solo.sessionMaxCount ||
      !Array.isArray(store.processedRunIds) || !Array.isArray(store.processedStepIds)) {
    throw new ValidationError('solo session store is invalid', 'SOLO_SESSION_STATE_CORRUPT');
  }
  const ids = new Set();
  for (const session of store.sessions) {
    if (session === null || typeof session !== 'object' ||
        typeof session.sessionId !== 'string' || !/^solo-session-[0-9]+-[0-9]+$/.test(session.sessionId) ||
        ids.has(session.sessionId) || !PHASES.has(session.phase)) {
      throw new ValidationError('solo session record is invalid', 'SOLO_SESSION_STATE_CORRUPT');
    }
    if (/(?:"raw|"content|"messages|"context|"memories|"digest|"ledger|"control)/iu
      .test(JSON.stringify(session))) {
      throw new ValidationError('solo session contains forbidden material', 'SOLO_SESSION_STATE_CORRUPT');
    }
    ids.add(session.sessionId);
  }
  if (store.processedRunIds.some((id) => typeof id !== 'string' ||
      !/^run-[A-Za-z0-9_-]{1,80}$/.test(id)) ||
      store.processedStepIds.some((id) => typeof id !== 'string' ||
        !/^step-[a-f0-9]{64}$/.test(id))) {
    throw new ValidationError('solo replay ledger is invalid', 'SOLO_SESSION_STATE_CORRUPT');
  }
  if (store.activeSessionId !== null && !ids.has(store.activeSessionId)) {
    throw new ValidationError('active solo session is missing', 'SOLO_SESSION_STATE_CORRUPT');
  }
  return store;
}

function baseSession(desireState, decision, nowMs) {
  return {
    sessionId: sessionIdFor(decision),
    decisionId: decision.id,
    phase: 'selected',
    outcome: null,
    selectedAt: timePair(nowMs),
    startedAt: null,
    endedAt: null,
    driveSnapshot: {
      libido: desireState.drives.libido,
      attachment: desireState.drives.attachment,
      fatigue: desireState.drives.fatigue,
      stress: desireState.drives.stress,
    },
    triggerReason: '自主检查中，身体欲望达到可以选择处理的程度。',
    thought: null,
    choiceReason: null,
    processSummary: null,
    afterBody: null,
    afterThought: null,
    beats: [],
    paused: false,
    endured: false,
    edgeReached: false,
    released: false,
    climaxQuality: null,
    output: null,
    reserveBefore: null,
    reserveAfter: null,
    libidoBefore: null,
    libidoAfter: null,
    refractoryUntil: null,
    releaseEffectId: null,
    noReleaseResult: null,
    abortReason: null,
    transitions: [{ phase: 'selected', at: timePair(nowMs) }],
  };
}

export function selectSoloSession({ desireState, interactionState, config, decisionId, nowMs }) {
  if (config.soloSessionsEnabled !== true || config.arousalEnabled !== true) {
    return { desireState, interactionState, session: null, status: 'disabled' };
  }
  requireTime(nowMs, desireState.updatedAt.epochMs);
  const decision = desireState.pendingDecision;
  if (!decision || decision.id !== decisionId || decision.intent !== 'solo') {
    throw new ValidationError('solo decision is missing or mismatched', 'DECISION_MISMATCH');
  }
  const next = clone(interactionState);
  next.soloSessions ??= createSoloSessionStore();
  validateSoloSessionStore(next.soloSessions, config);
  const id = sessionIdFor(decision);
  const replay = next.soloSessions.sessions.find((item) => item.sessionId === id);
  if (replay) return { desireState, interactionState, session: replay, status: 'replayed' };
  if (currentSession(next.soloSessions)) {
    throw new ValidationError('another solo session is active', 'SOLO_SESSION_CONFLICT');
  }
  const session = baseSession(desireState, decision, nowMs);
  replaceSession(next.soloSessions, session, config.solo.sessionMaxCount);
  return { desireState, interactionState: next, session, status: 'selected' };
}

function boundedContext(items, maximumItems, maximumLength) {
  if (!Array.isArray(items)) return [];
  return items.slice(-maximumItems).map((item) => String(item).slice(0, maximumLength));
}

export function prepareSoloGeneration({
  desireState, interactionState, config, sessionId, recentContext = [], memories = [], nowMs,
}) {
  const next = clone(interactionState);
  next.soloSessions ??= createSoloSessionStore();
  const session = currentSession(next.soloSessions);
  if (!session || session.sessionId !== sessionId || !['selected', 'edge'].includes(session.phase)) {
    throw new ValidationError('solo session cannot enter preparation', 'SOLO_SESSION_CONFLICT');
  }
  requireTime(nowMs, session.selectedAt.epochMs);
  transition(session, 'preparing', nowMs);
  replaceSession(next.soloSessions, session, config.solo.sessionMaxCount);
  return {
    interactionState: next,
    request: {
      schema: 'aru.desire-heartbeat.solo-generation-request.v1',
      sessionId,
      driveSnapshot: clone(session.driveSnapshot),
      arousalPhase: qualitativeArousalPhase(
        next.arousal, config.arousal, nowMs,
      ),
      recentContext: boundedContext(recentContext, 6, 1200),
      memories: boundedContext(memories, 6, 800),
      outputSchema: SOLO_GENERATION_SCHEMA,
      contract: {
        finalOnly: true,
        maxActionBeats: config.solo.maxActionBeats,
        allowedActions: [...ACTIONS],
        allowedBodyParts: [...BODY_PARTS],
        allowedRhythms: [...RHYTHMS],
        allowedDurations: Object.keys(DURATIONS),
        allowedPostures: [...POSTURES],
        allowedOutcomes: [...OUTCOMES],
      },
    },
    desireState,
  };
}

function validateBeat(beat, seen) {
  if (beat === null || typeof beat !== 'object' || Array.isArray(beat) ||
      typeof beat.stepId !== 'string' || !/^step-[A-Za-z0-9_-]{1,64}$/.test(beat.stepId) ||
      seen.has(beat.stepId) || !ACTIONS.has(beat.action) || !BODY_PARTS.has(beat.bodyPart) ||
      !Number.isFinite(beat.intensity) || beat.intensity < 0 || beat.intensity > 1 ||
      !RHYTHMS.has(beat.rhythm) || !Object.hasOwn(DURATIONS, beat.duration) ||
      !POSTURES.has(beat.posture) || typeof beat.continuousContact !== 'boolean' ||
      typeof beat.releaseIntent !== 'boolean') {
    throw new ValidationError('solo action beat is invalid', 'SOLO_GENERATION_INVALID');
  }
  seen.add(beat.stepId);
  return {
    stepId: beat.stepId,
    action: beat.action,
    bodyPart: beat.bodyPart,
    intensity: beat.intensity,
    rhythm: beat.rhythm,
    duration: beat.duration,
    posture: beat.posture,
    continuousContact: beat.continuousContact,
    releaseIntent: beat.releaseIntent,
  };
}

export function validateSoloGenerationEnvelope(envelope, config) {
  if (envelope === null || typeof envelope !== 'object' || envelope.status !== 'completed' ||
      envelope.final !== true || typeof envelope.runId !== 'string' ||
      !/^run-[A-Za-z0-9_-]{1,80}$/.test(envelope.runId)) {
    throw new ValidationError('solo generation was not a complete final', 'SOLO_GENERATION_INCOMPLETE');
  }
  const output = envelope.output;
  if (output === null || typeof output !== 'object' || output.schema !== SOLO_GENERATION_SCHEMA ||
      typeof output.sessionId !== 'string' || !OUTCOMES.has(output.outcome) ||
      typeof output.paused !== 'boolean' || typeof output.endured !== 'boolean' ||
      !Array.isArray(output.actionBeats) || output.actionBeats.length < 1 ||
      output.actionBeats.length > config.solo.maxActionBeats) {
    throw new ValidationError('solo generation schema is invalid', 'SOLO_GENERATION_INVALID');
  }
  const narrative = {};
  for (const field of TEXT_FIELDS) narrative[field] = safeText(output[field], field);
  const seen = new Set();
  return {
    runId: envelope.runId,
    sessionId: output.sessionId,
    outcome: output.outcome,
    paused: output.paused,
    endured: output.endured,
    actionBeats: output.actionBeats.map((beat) => validateBeat(beat, seen)),
    ...narrative,
  };
}

function abortGeneration(interactionState, config, reason, nowMs) {
  const next = clone(interactionState);
  const session = currentSession(next.soloSessions);
  if (!session) return next;
  if (session.phase === 'aborted' || session.phase === 'settled') return next;
  requireTime(nowMs, session.selectedAt.epochMs);
  session.abortReason = reason;
  session.endedAt = timePair(nowMs);
  session.outcome = 'aborted';
  transition(session, 'aborted', nowMs);
  replaceSession(next.soloSessions, session, config.solo.sessionMaxCount);
  return next;
}

export function applySoloGeneration({
  desireState, interactionState, config, envelope, nowMs,
}) {
  if (config.soloSessionsEnabled !== true || config.arousalEnabled !== true) {
    return { desireState, interactionState, status: 'disabled', session: null };
  }
  let parsed;
  try {
    parsed = validateSoloGenerationEnvelope(envelope, config);
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        desireState,
        interactionState: abortGeneration(
          interactionState, config, error.code, nowMs,
        ),
        status: 'aborted',
        session: null,
      };
    }
    throw error;
  }
  const next = clone(interactionState);
  next.soloSessions ??= createSoloSessionStore();
  if (next.soloSessions.processedRunIds.includes(parsed.runId)) {
    return { desireState, interactionState, status: 'replayed', session: currentSession(next.soloSessions) };
  }
  const session = currentSession(next.soloSessions);
  if (!session || session.sessionId !== parsed.sessionId || session.phase !== 'preparing') {
    return {
      desireState,
      interactionState: abortGeneration(next, config, 'SOLO_SESSION_CONFLICT', nowMs),
      status: 'aborted',
      session: null,
    };
  }
  requireTime(nowMs, session.selectedAt.epochMs);
  session.startedAt ??= timePair(nowMs);
  for (const field of TEXT_FIELDS) session[field] = parsed[field];
  session.paused ||= parsed.paused;
  session.endured ||= parsed.endured;
  transition(session, 'active', nowMs);
  next.arousal = setReleaseGate(next.arousal, 'release_once');
  session.reserveBefore ??= next.arousal.reserve;
  let beatTime = Math.max(nowMs, next.arousal.updatedAt.epochMs);
  let receipt = null;
  for (const beat of parsed.actionBeats) {
    const stepKey = `${session.sessionId}:${beat.stepId}`;
    const stableStepId = digest('step', stepKey);
    if (next.soloSessions.processedStepIds.includes(stableStepId)) continue;
    beatTime += DURATIONS[beat.duration] * 1000;
    const result = applyArousalEvent(
      next.arousal,
      config.arousal,
      {
        eventId: digest('event', stepKey),
        cause: 'solo',
        outputMultiplier: config.solo.outputMultiplier,
        reserveCostMultiplier: config.solo.reserveCostMultiplier,
        stimuli: [{
          action: beat.action === 'release' ? 'climax' : beat.action,
          bodyPart: beat.bodyPart,
          posture: beat.posture,
          mode: beat.continuousContact ? 'passive' : 'active',
          direction: 'solo',
          strength: beat.intensity,
          releaseSignal: beat.releaseIntent,
        }],
      },
      desireState.drives.libido,
      beatTime,
    );
    next.arousal = result.state;
    next.soloSessions.processedStepIds.push(stableStepId);
    session.beats.push(beat);
    if (next.arousal.value >= config.arousal.edge) session.edgeReached = true;
    if (result.receipt) {
      receipt = result.receipt;
      break;
    }
  }
  next.soloSessions.processedRunIds.push(parsed.runId);
  next.soloSessions.processedRunIds = next.soloSessions.processedRunIds.slice(-512);
  next.soloSessions.processedStepIds = next.soloSessions.processedStepIds.slice(-2048);
  session.reserveAfter = next.arousal.reserve;
  if (receipt) {
    session.outcome = 'completed_release';
    session.released = true;
    session.endedAt = timePair(beatTime);
    session.climaxQuality = receipt.climaxQuality;
    session.output = receipt.output;
    session.refractoryUntil = next.arousal.refractoryUntil;
    session.releaseEffectId = receipt.effectId;
    transition(session, 'completed_release', beatTime);
  } else if (parsed.outcome === 'edge' && session.edgeReached) {
    next.arousal = setReleaseGate(next.arousal, 'lock');
    session.outcome = 'edge';
    transition(session, 'edge', beatTime);
  } else if (parsed.outcome === 'abort') {
    next.arousal = setReleaseGate(next.arousal, 'lock');
    session.outcome = 'aborted';
    session.abortReason = 'generation_aborted';
    session.endedAt = timePair(beatTime);
    transition(session, 'aborted', beatTime);
  } else {
    next.arousal = setReleaseGate(next.arousal, 'lock');
    session.outcome = 'completed_no_release';
    session.endedAt = timePair(beatTime);
    session.noReleaseResult = 'ended_without_release';
    transition(session, 'completed_no_release', beatTime);
  }
  replaceSession(next.soloSessions, session, config.solo.sessionMaxCount);
  return { desireState, interactionState: next, status: session.phase, session };
}

function clearDecision(desire, session, nowMs) {
  if (desire.pendingDecision?.id === session.decisionId) desire.pendingDecision = null;
  desire.expression.consecutiveWithholds = 0;
  desire.updatedAt = timePair(nowMs);
}

export function settleSoloSession({ desireState, interactionState, config, nowMs }) {
  const next = clone(interactionState);
  const session = currentSession(next.soloSessions);
  if (!session || !['completed_release', 'completed_no_release', 'aborted'].includes(session.phase)) {
    return { desireState, interactionState, applied: false, session };
  }
  let desire = clone(desireState);
  session.libidoBefore ??= desire.drives.libido;
  let applied = false;
  if (session.phase === 'completed_release') {
    const result = applyReleaseReceiptToDesire(next.arousal, desire, config);
    next.arousal = result.arousal;
    desire = result.desire;
    applied = result.applied;
    if (applied) {
      desire.lastSatisfiedAt.libido = timePair(nowMs);
      desire.solo.refractoryUntil = timePair(nowMs + config.solo.cooldownSeconds * 1000);
    }
  } else if (session.phase === 'completed_no_release') {
    const effectId = digest('effect', `no-release:${session.sessionId}`);
    const result = applyNoReleaseSettlement(desire, config, {
      effectId, cause: 'solo', nowMs,
    });
    desire = result.desire;
    applied = result.applied;
    session.noReleaseResult = result.applied ? 'settled_0.80' : session.noReleaseResult;
  }
  if (session.phase !== 'aborted' && applied) {
    desire.solo.count += 1;
    desire.solo.lastSoloAt = timePair(nowMs);
    desire.solo.lastLibidoChoice = 'solo';
  }
  clearDecision(desire, session, nowMs);
  session.libidoAfter = desire.drives.libido;
  transition(session, 'settled', nowMs);
  replaceSession(next.soloSessions, session, config.solo.sessionMaxCount);
  return { desireState: desire, interactionState: next, applied, session };
}

export function latestSoloPrivateView(interactionState) {
  const sessions = interactionState?.soloSessions?.sessions;
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return clone(sessions.at(-1));
}
