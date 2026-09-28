import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalToCompleteMessage, validateCanonicalTurnEvent } from './canonical-turn-event.mjs';
import {
  processPersistedMessage,
  settlePendingClassifiedSettlement,
  settlePendingRelease,
} from './interaction-runtime.mjs';
import {
  atomicSaveInteractionState,
  loadInteractionState,
} from './interaction-storage.mjs';
import { withLock } from './security.mjs';
import { atomicSaveState, loadConfig, loadState } from './storage.mjs';

export const MAX_RECEIVER_BODY_BYTES = 24_000;

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function loadReceiverSecret(secretPath) {
  const { assertSecureRegularFile } = await import('./security.mjs');
  await assertSecureRegularFile(secretPath);
  const secret = (await readFile(secretPath, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('receiver secret is invalid');
  return secret;
}

export function authorizeReceiverRequest(header, secret) {
  return typeof header === 'string' && header.startsWith('Bearer ') &&
    secureEqual(header.slice(7), secret);
}

async function settleLoadedPendingReceipts({
  directory, desireState, interactionState, config,
}) {
  let desire = desireState;
  let interaction = interactionState;
  let found = false;
  let applied = false;
  if (config.arousalDriveSettlementEnabled !== true) {
    return { desireState: desire, interactionState: interaction, found, applied };
  }
  const receipts = [
    interaction.chat.pendingSettlementReceipt && {
      kind: 'classified',
      at: interaction.chat.pendingSettlementReceipt.at.epochMs,
    },
    interaction.arousal.pendingReleaseReceipt && {
      kind: 'arousal',
      at: interaction.arousal.pendingReleaseReceipt.createdAt.epochMs,
    },
  ].filter(Boolean).sort((left, right) => left.at - right.at);
  for (const receipt of receipts) {
    found = true;
    const settled = receipt.kind === 'classified'
      ? settlePendingClassifiedSettlement({
        desireState: desire, interactionState: interaction, config,
      })
      : settlePendingRelease({
        desireState: desire, interactionState: interaction, config,
      });
    desire = settled.desireState;
    interaction = settled.interactionState;
    applied ||= settled.applied;
    // Desire first preserves the effect ledger before its pending receipt is
    // cleared. Repeating after a crash completes, but never reapplies, it.
    await atomicSaveState(directory, desire, config);
    await atomicSaveInteractionState(directory, interaction, config);
  }
  return { desireState: desire, interactionState: interaction, found, applied };
}

export async function processCanonicalTurn({ event, configPath, dataDirectory }) {
  validateCanonicalTurnEvent(event);
  const message = canonicalToCompleteMessage(event);
  const config = await loadConfig(configPath);
  return withLock(dataDirectory, async (directory) => {
    let desireState = await loadState(directory, config);
    let interactionState = await loadInteractionState(directory, config);
    const recovered = await settleLoadedPendingReceipts({
      directory, desireState, interactionState, config,
    });
    desireState = recovered.desireState;
    interactionState = recovered.interactionState;
    const chatAlreadyComplete = config.chatStimulusEnabled !== true || (
      desireState.appliedChatEventIds?.includes(event.event_id) &&
      interactionState.chat.processedEvents.some((item) => item.eventId === event.event_id)
    );
    const arousalAlreadyComplete = config.arousalEnabled !== true ||
      interactionState.arousal.processedEvents.includes(event.event_id);
    const wasDuplicate = chatAlreadyComplete && arousalAlreadyComplete;
    // A full replay must return before monotonic-time validation: the first
    // event in a replayed turn is older than the state advanced by its second
    // event, but it is still a valid idempotent duplicate.
    if (wasDuplicate) return { status: recovered.applied ? 'settled' : 'duplicate' };
    const processed = processPersistedMessage({
      desireState, interactionState, config, message,
    });
    if (processed.status === 'disabled' || processed.status === 'ignored_incomplete') {
      return { status: processed.status };
    }

    // Desire first is intentional: its event ledger lets an interaction-state
    // replay reconcile safely if the process stops between the two atomic saves.
    await atomicSaveState(directory, processed.desireState, config);
    await atomicSaveInteractionState(directory, processed.interactionState, config);

    if (processed.settlementReceipt && config.arousalDriveSettlementEnabled === true) {
      const settled = settlePendingClassifiedSettlement({
        desireState: processed.desireState,
        interactionState: processed.interactionState,
        config,
      });
      await atomicSaveState(directory, settled.desireState, config);
      await atomicSaveInteractionState(directory, settled.interactionState, config);
      return { status: settled.applied ? 'settled' : processed.status };
    }

    if (processed.releaseReceipt && config.arousalDriveSettlementEnabled === true) {
      const settled = settlePendingRelease({
        desireState: processed.desireState,
        interactionState: processed.interactionState,
        config,
      });
      await atomicSaveState(directory, settled.desireState, config);
      await atomicSaveInteractionState(directory, settled.interactionState, config);
      return { status: settled.applied ? 'settled' : processed.status };
    }
    return { status: processed.status };
  });
}

export async function recoverPendingSettlement({ configPath, dataDirectory }) {
  const config = await loadConfig(configPath);
  return withLock(dataDirectory, async (directory) => {
    const desireState = await loadState(directory, config);
    const interactionState = await loadInteractionState(directory, config);
    if (config.arousalDriveSettlementEnabled !== true ||
        (!interactionState.chat.pendingSettlementReceipt &&
          !interactionState.arousal.pendingReleaseReceipt)) {
      return { status: 'no_op' };
    }
    const settled = await settleLoadedPendingReceipts({
      directory, desireState, interactionState, config,
    });
    return { status: settled.applied ? 'settled' : 'duplicate' };
  });
}

export async function readJsonBody(request, maximum = MAX_RECEIVER_BODY_BYTES) {
  const declared = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximum) {
    const error = new Error('request size is invalid');
    error.statusCode = declared > maximum ? 413 : 400;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) {
      const error = new Error('request is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size !== declared) {
    const error = new Error('request length is inconsistent');
    error.statusCode = 400;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request JSON is invalid');
    error.statusCode = 400;
    throw error;
  }
}
