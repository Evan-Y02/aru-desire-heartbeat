import {
  DRIVES,
  TIMELINE_MAX_COUNT,
  TIMELINE_REASONS,
} from './constants.mjs';

const allowedReasons = new Set(TIMELINE_REASONS);

function timePair(epochMs) {
  return { iso: new Date(epochMs).toISOString(), epochMs };
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.filter((reason) => allowedReasons.has(reason)))];
}

function selectedState(tick) {
  const pending = tick.state.pendingDecision;
  const candidate = pending ?? tick.candidate;
  if (!candidate) return { drive: null, intent: null, score: null };
  return {
    drive: candidate.drive,
    intent: candidate.intent,
    score: candidate.score,
  };
}

export function createTimelineEntry(tick, config, nowMs, outcome, extraReasons = []) {
  const selected = selectedState(tick);
  const formation = tick.sentinel?.formationBlockers ?? [];
  const delivery = selected.intent === 'solo'
    ? (config.observeOnly ? ['observe-only'] : [])
    : (tick.sentinel?.deliveryBlockers ?? []);
  return {
    at: timePair(nowMs),
    nextCheckAt: timePair(nowMs + config.heartbeatSeconds * 1000),
    outcome,
    drive: selected.drive,
    intent: selected.intent,
    score: selected.score,
    willingness: tick.expression?.willingness ?? null,
    reasons: uniqueReasons([...formation, ...delivery, ...extraReasons]),
    drives: Object.fromEntries(DRIVES.map((drive) => [drive, tick.state.drives[drive]])),
  };
}

export function appendTimeline(state, entry) {
  const previous = Array.isArray(state.timeline) ? state.timeline : [];
  state.timeline = [entry, ...previous].slice(0, TIMELINE_MAX_COUNT);
  return state;
}

export function finishLatestTimeline(state, nowMs, outcome, reasons = []) {
  if (!Array.isArray(state.timeline)) return state;
  const entry = state.timeline.find((item) => item.at?.epochMs === nowMs);
  if (!entry) return state;
  entry.outcome = outcome;
  entry.reasons = uniqueReasons([...entry.reasons, ...reasons]);
  return state;
}