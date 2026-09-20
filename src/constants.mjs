export const STATE_SCHEMA = 'aru.desire-heartbeat.state.v2';
export const CONFIG_SCHEMA = 'aru.desire-heartbeat.config.v2';

export const DRIVES = Object.freeze([
  'attachment',
  'curiosity',
  'reflection',
  'duty',
  'social',
  'fatigue',
  'libido',
  'stress',
]);

export const INTENT_BY_DRIVE = Object.freeze({
  attachment: 'reach_owner',
  curiosity: 'share',
  reflection: 'confide',
  social: 'reach_owner',
  libido: 'seek_closeness',
  stress: 'confide',
});

export const SOLO_INTENT = 'solo';
export const intentMatchesDrive = (drive, intent) =>
  INTENT_BY_DRIVE[drive] === intent || (drive === 'libido' && intent === SOLO_INTENT);

// Duty and fatigue remain internal state. They do not directly create an action.
export const ACTIVE_DRIVES = Object.freeze(Object.keys(INTENT_BY_DRIVE));

export const TIMELINE_MAX_COUNT = 72;
export const TIMELINE_OUTCOMES = Object.freeze([
  'idle',
  'withheld',
  'held_disabled',
  'submitting',
  'submitted',
  'held_claimed',
  'delivery_failed',
  'solo_completed',
]);
export const TIMELINE_REASONS = Object.freeze([
  'clock-anomaly',
  'pending-decision',
  'fatigue-gate',
  'below-trigger-threshold',
  'observe-only',
  'delivery-disabled',
  'delivery-adapter-disabled',
  'expression-withheld',
  'delivery-accepted',
  'delivery-already-claimed',
  'delivery-failed',
  'solo-completed',
]);