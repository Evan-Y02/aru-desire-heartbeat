import { createHash } from 'node:crypto';
import { ValidationError } from './schema.mjs';

export const CANONICAL_TURN_SCHEMA = 'aru.desire-heartbeat.complete-message.v1';
export const CANONICAL_TURN_SOURCE = 'aru_on_turn_settled';
export const MAX_CANONICAL_TEXT_BYTES = 20_000;

const digest = (value) => createHash('sha256').update(value).digest('hex');

export function canonicalEventId({ conversationId, messageId, role }) {
  if (![conversationId, messageId, role].every((value) =>
    typeof value === 'string' && value.length > 0)) {
    throw new ValidationError('canonical identity is invalid', 'CANONICAL_EVENT_INVALID');
  }
  return `event-${digest([
    CANONICAL_TURN_SOURCE, conversationId, messageId, role,
  ].join('\u0000'))}`;
}

export function validateCanonicalTurnEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new ValidationError('canonical event must be an object', 'CANONICAL_EVENT_INVALID');
  }
  const expected = [
    'schema_version', 'event_id', 'conversation_id', 'message_id',
    'parent_message_id', 'role', 'completed_at', 'complete', 'text', 'source',
  ].sort();
  if (Object.keys(event).sort().join(',') !== expected.join(',')) {
    throw new ValidationError('canonical event fields are invalid', 'CANONICAL_EVENT_INVALID');
  }
  if (event.schema_version !== CANONICAL_TURN_SCHEMA ||
      event.source !== CANONICAL_TURN_SOURCE || event.complete !== true ||
      !['user', 'assistant'].includes(event.role) ||
      typeof event.conversation_id !== 'string' || event.conversation_id.length < 1 ||
      event.conversation_id.length > 200 ||
      typeof event.message_id !== 'string' || event.message_id.length < 1 ||
      event.message_id.length > 200 ||
      (event.parent_message_id !== null &&
        (typeof event.parent_message_id !== 'string' || event.parent_message_id.length < 1 ||
          event.parent_message_id.length > 200)) ||
      !Number.isSafeInteger(event.completed_at) || event.completed_at < 0 ||
      typeof event.text !== 'string' || event.text.length < 1 ||
      Buffer.byteLength(event.text, 'utf8') > MAX_CANONICAL_TEXT_BYTES) {
    throw new ValidationError('canonical event is malformed', 'CANONICAL_EVENT_INVALID');
  }
  const expectedId = canonicalEventId({
    conversationId: event.conversation_id,
    messageId: event.message_id,
    role: event.role,
  });
  if (event.event_id !== expectedId) {
    throw new ValidationError('canonical event id is inconsistent', 'CANONICAL_EVENT_INVALID');
  }
  return event;
}

export function canonicalToCompleteMessage(event) {
  validateCanonicalTurnEvent(event);
  return {
    source: CANONICAL_TURN_SOURCE,
    conversationId: event.conversation_id,
    providerMessageId: event.message_id,
    parentMessageId: event.parent_message_id,
    role: event.role,
    status: 'complete',
    persisted: true,
    final: true,
    cancelled: false,
    completedAt: event.completed_at,
    content: event.text,
  };
}
