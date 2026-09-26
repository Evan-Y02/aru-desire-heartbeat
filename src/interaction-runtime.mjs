import {
  applyArousalEvent,
  applyNoReleaseSettlement,
  applyReleaseReceiptToDesire,
  createArousalState,
  validateArousalState,
} from './arousal.mjs';
import { createHash } from 'node:crypto';
import {
  applyChatStimulus,
  createChatStimulusState,
  interpretCompleteMessage,
  validateChatStimulusState,
  validateCompleteMessageEvent,
} from './chat-stimulus.mjs';
import { ValidationError } from './schema.mjs';
import { createSoloSessionStore, validateSoloSessionStore } from './solo-session.mjs';

export const INTERACTION_STATE_SCHEMA = 'aru.desire-heartbeat.interaction-state.v1';

export function createInteractionState(epochMs = Date.now()) {
  return {
    schema: INTERACTION_STATE_SCHEMA,
    version: 1,
    chat: createChatStimulusState(epochMs),
    arousal: createArousalState(epochMs),
    soloSessions: createSoloSessionStore(),
  };
}

export function validateInteractionState(state, config) {
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
      state.schema !== INTERACTION_STATE_SCHEMA || state.version !== 1) {
    throw new ValidationError('unsupported interaction state', 'INTERACTION_STATE_CORRUPT');
  }
  validateChatStimulusState(state.chat, config.chatStimulus);
  validateArousalState(state.arousal);
  state.soloSessions ??= createSoloSessionStore();
  validateSoloSessionStore(state.soloSessions, config);
  return state;
}

function isComplete(event) {
  try {
    validateCompleteMessageEvent(event);
    return true;
  } catch (error) {
    if (error instanceof ValidationError &&
        ['MESSAGE_EVENT_INCOMPLETE', 'MESSAGE_EVENT_INVALID'].includes(error.code)) return false;
    throw error;
  }
}

// Formal inbound adapter boundary. A supported Host hook must call this only after
// the complete turn has been durably committed; partial stream callbacks are rejected.
export function processPersistedMessage({
  desireState,
  interactionState,
  config,
  message,
}) {
  if (config.chatStimulusEnabled !== true && config.arousalEnabled !== true) {
    return {
      status: 'disabled', desireState, interactionState,
      interpreted: null, releaseReceipt: null,
    };
  }
  if (!isComplete(message)) {
    return {
      status: 'ignored_incomplete', desireState, interactionState,
      interpreted: null, releaseReceipt: null,
    };
  }
  const nextInteraction = structuredClone(validateInteractionState(interactionState, config));
  const interpreted = interpretCompleteMessage(message);
  let nextDesire = desireState;
  let chatApplied = false;
  if (config.chatStimulusEnabled === true) {
    const result = applyChatStimulus(
      desireState, nextInteraction.chat, config, interpreted, message.completedAt,
    );
    nextDesire = result.desireState;
    nextInteraction.chat = result.chatState;
    chatApplied = result.applied;
  }

  let arousalApplied = false;
  let released = false;
  let releaseReceipt = null;
  if (config.arousalEnabled === true) {
    const result = applyArousalEvent(
      nextInteraction.arousal,
      config.arousal,
      { eventId: interpreted.eventId, stimuli: interpreted.stimuli },
      nextDesire.drives.libido,
      message.completedAt,
    );
    nextInteraction.arousal = result.state;
    arousalApplied = result.applied;
    released = result.released;
    releaseReceipt = result.receipt;
  }
  return {
    status: chatApplied || arousalApplied || released ? 'applied' : 'no_op',
    desireState: nextDesire,
    interactionState: nextInteraction,
    interpreted: {
      eventId: interpreted.eventId,
      types: interpreted.types,
      labels: interpreted.labels,
    },
    releaseReceipt,
  };
}

// Two-phase settlement boundary: persist interactionState with its receipt first,
// then call this function and save the desire state before clearing the receipt.
// The effect ID stored in desire state makes that save order replay-safe.
export function settlePendingRelease({ desireState, interactionState, config }) {
  const nextInteraction = structuredClone(validateInteractionState(interactionState, config));
  const result = applyReleaseReceiptToDesire(
    nextInteraction.arousal, desireState, config,
  );
  nextInteraction.arousal = result.arousal;
  return {
    desireState: result.desire,
    interactionState: nextInteraction,
    applied: result.applied,
  };
}

export function settlePartneredNoRelease({ desireState, interactionState, config, eventId, nowMs }) {
  if (typeof eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(eventId)) {
    throw new ValidationError('partnered no-release event id is invalid');
  }
  const effectId = `effect-${createHash('sha256')
    .update(`partnered-no-release:${eventId}`)
    .digest('hex')}`;
  const result = applyNoReleaseSettlement(desireState, config, {
    effectId, cause: 'partnered', nowMs,
  });
  return {
    desireState: result.desire,
    interactionState,
    applied: result.applied,
    effectId,
  };
}
