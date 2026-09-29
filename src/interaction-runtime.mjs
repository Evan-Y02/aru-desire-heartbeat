import {
  applyArousalEvent,
  applyNoReleaseSettlement,
  applyReportedReleaseArousal,
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
import { clamp, timePair } from './engine.mjs';

export const INTERACTION_STATE_SCHEMA = 'aru.desire-heartbeat.interaction-state.v1';

function settlementResult({
  libidoBefore, libidoAfter, arousalBefore, arousalAfter,
  refractoryUntil, cooldownUntil, duplicateIgnored = false,
}) {
  return {
    libidoBefore,
    libidoAfter,
    arousalBefore,
    arousalAfter,
    refractoryUntil: refractoryUntil === null ? null : structuredClone(refractoryUntil),
    cooldownUntil: cooldownUntil === null ? null : structuredClone(cooldownUntil),
    receiptStatus: 'settled',
    settled: true,
    duplicateIgnored,
  };
}

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
      interpreted: null, releaseReceipt: null, settlementReceipt: null,
    };
  }
  if (!isComplete(message)) {
    return {
      status: 'ignored_incomplete', desireState, interactionState,
      interpreted: null, releaseReceipt: null, settlementReceipt: null,
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
      sexualClass: interpreted.sexualClass,
      intensity: interpreted.intensity,
      settlementType: interpreted.settlementType,
    },
    releaseReceipt,
    settlementReceipt: nextInteraction.chat.pendingSettlementReceipt,
  };
}

export function settlePendingClassifiedSettlement({ desireState, interactionState, config }) {
  const nextInteraction = structuredClone(validateInteractionState(interactionState, config));
  const receipt = nextInteraction.chat.pendingSettlementReceipt;
  if (!receipt || config.arousalDriveSettlementEnabled !== true) {
    return { desireState, interactionState: nextInteraction, applied: false };
  }
  const desire = structuredClone(desireState);
  const ledger = Array.isArray(desire.appliedEffectIds) ? desire.appliedEffectIds : [];
  const alreadyApplied = ledger.includes(receipt.effectId);
  const libidoBefore = alreadyApplied ? null : desire.drives.libido;
  const arousalBefore = nextInteraction.arousal.value;
  const prior = nextInteraction.chat.settlementFacts.find((item) =>
    item.factFingerprint === receipt.factFingerprint);
  if (!alreadyApplied) {
    desire.drives.libido = clamp(
      desire.drives.libido * (receipt.toFactor / receipt.fromFactor),
    );
    desire.appliedEffectIds = [...ledger, receipt.effectId].slice(-512);
    desire.lastSatisfiedAt.libido = structuredClone(receipt.at);
    desire.updatedAt = structuredClone(receipt.at);
    if (receipt.type === 'solo_release') {
      desire.solo.refractoryUntil = timePair(
        receipt.at.epochMs + config.solo.cooldownSeconds * 1000,
      );
    }
    if (receipt.type.startsWith('solo_')) {
      if (!prior) desire.solo.count += 1;
      desire.solo.lastSoloAt = structuredClone(receipt.at);
      desire.solo.lastLibidoChoice = 'solo';
    } else {
      desire.solo.lastLibidoChoice = 'seek_closeness';
    }
  }
  // Desire is intentionally saved before interaction state. If a process dies
  // between those saves, the effect ledger is already present while the old
  // pending receipt and pre-release body remain. A missing fact record is the
  // durable signal to complete the body side exactly once during recovery.
  const upgradesNoReleaseToRelease = Boolean(
    prior
    && prior.type.endsWith('_no_release')
    && ['partnered_release', 'solo_release'].includes(receipt.type),
  );
  if ((!prior || upgradesNoReleaseToRelease)
      && ['partnered_release', 'solo_release'].includes(receipt.type)) {
    const cause = receipt.type.startsWith('solo_') ? 'solo' : 'partnered';
    nextInteraction.arousal = applyReportedReleaseArousal(
      nextInteraction.arousal,
      config.arousal,
      {
        eventId: receipt.eventId,
        cause,
        nowMs: receipt.at.epochMs,
        outputMultiplier: cause === 'solo' ? config.solo.outputMultiplier : 1,
        reserveCostMultiplier: cause === 'solo' ? config.solo.reserveCostMultiplier : 1,
      },
    );
  }
  if (prior) {
    prior.type = receipt.type;
    prior.carryoverFactor = receipt.toFactor;
    prior.effectId = receipt.effectId;
    prior.at = structuredClone(receipt.at);
    if (!prior.eventIds.includes(receipt.eventId)) {
      prior.eventIds = [...prior.eventIds, receipt.eventId].slice(
        -config.chatStimulus.ledgerMaxCount,
      );
    }
  } else {
    nextInteraction.chat.settlementFacts.push({
      factFingerprint: receipt.factFingerprint,
      type: receipt.type,
      carryoverFactor: receipt.toFactor,
      effectId: receipt.effectId,
      eventIds: [receipt.eventId],
      at: structuredClone(receipt.at),
      result: null,
    });
    nextInteraction.chat.settlementFacts = nextInteraction.chat.settlementFacts.slice(
      -config.chatStimulus.ledgerMaxCount,
    );
  }
  const recorded = prior ?? nextInteraction.chat.settlementFacts.at(-1);
  recorded.result = settlementResult({
    libidoBefore,
    libidoAfter: alreadyApplied ? null : desire.drives.libido,
    arousalBefore,
    arousalAfter: nextInteraction.arousal.value,
    refractoryUntil: nextInteraction.arousal.refractoryUntil,
    cooldownUntil: receipt.type === 'solo_release' ? desire.solo.refractoryUntil : null,
  });
  nextInteraction.chat.pendingSettlementReceipt = null;
  return { desireState: desire, interactionState: nextInteraction, applied: !alreadyApplied };
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
