import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalToCompleteMessage, validateCanonicalTurnEvent } from './canonical-turn-event.mjs';
import { processPersistedMessage, settlePendingRelease } from './interaction-runtime.mjs';
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

export async function processCanonicalTurn({ event, configPath, dataDirectory }) {
  validateCanonicalTurnEvent(event);
  const message = canonicalToCompleteMessage(event);
  const config = await loadConfig(configPath);
  return withLock(dataDirectory, async (directory) => {
    const desireState = await loadState(directory, config);
    const interactionState = await loadInteractionState(directory, config);
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
    if (wasDuplicate) return { status: 'duplicate' };
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
