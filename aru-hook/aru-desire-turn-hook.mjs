import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import http from 'node:http';

const SCHEMA = 'aru.desire-heartbeat.complete-message.v1';
const SOURCE = 'aru_on_turn_settled';
const MAX_TEXT_BYTES = 20_000;

const eventId = (conversationId, messageId, role) =>
  `event-${createHash('sha256').update([
    SOURCE, conversationId, messageId, role,
  ].join('\u0000')).digest('hex')}`;

function canonicalEvents(event) {
  if (!event || event.outcome !== 'completed' || !event.conversation || !event.turn ||
      !event.assistantMessage || !Array.isArray(event.conversation.messages)) return [];
  const { conversation, turn, assistantMessage } = event;
  if (typeof conversation.conversationId !== 'string' || !conversation.conversationId ||
      typeof turn.userMessageId !== 'string' || typeof turn.assistantMessageId !== 'string') return [];
  const user = conversation.messages.find((message) =>
    message?.messageId === turn.userMessageId && message.role === 'user' &&
    message.status === 'completed' && typeof message.content === 'string');
  if (!user || !user.content || assistantMessage.messageId !== turn.assistantMessageId ||
      assistantMessage.role !== 'assistant' || assistantMessage.status !== 'completed' ||
      typeof assistantMessage.content !== 'string' || !assistantMessage.content ||
      !Number.isSafeInteger(turn.completedAt) ||
      !Number.isSafeInteger(user.updatedAt ?? user.createdAt)) return [];
  const make = (message, role, completedAt, parentMessageId) => ({
    schema_version: SCHEMA,
    event_id: eventId(conversation.conversationId, message.messageId, role),
    conversation_id: conversation.conversationId,
    message_id: message.messageId,
    parent_message_id: parentMessageId ?? null,
    role,
    completed_at: completedAt,
    complete: true,
    text: message.content,
    source: SOURCE,
  });
  const events = [
    make(user, 'user', user.updatedAt ?? user.createdAt, turn.baseMessageId),
    make(assistantMessage, 'assistant', turn.completedAt, user.messageId),
  ];
  return events.every((item) => Buffer.byteLength(item.text, 'utf8') <= MAX_TEXT_BYTES)
    ? events : [];
}

function secureSecret(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.uid !== process.geteuid()) {
    throw new Error('desire hook secret file is unsafe');
  }
  const value = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error('desire hook secret is invalid');
  return value;
}

function sendOnce({ endpoint, secret, timeoutMs }, event) {
  const body = Buffer.from(JSON.stringify(event));
  return new Promise((resolve) => {
    const request = http.request(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'content-length': body.length,
      },
      timeout: timeoutMs,
      agent: false,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 4_096) chunks.push(chunk);
      });
      response.on('end', () => {
        let receiverStatus = null;
        if (size <= 4_096) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof parsed?.status === 'string') receiverStatus = parsed.status;
          } catch {
            // The HTTP status remains authoritative outside synthetic acceptance.
          }
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          category: response.statusCode >= 400 && response.statusCode < 500
            ? 'rejected' : response.statusCode >= 500 ? 'receiver_error' : null,
          retryable: response.statusCode >= 500,
          receiverStatus,
        });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({
      ok: false,
      category: error.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable',
      retryable: true,
    }));
    request.end(body);
  });
}

export function createAruDesireTurnHook({
  enabled = process.env.ARU_DESIRE_TURN_HOOK_ENABLED === 'true',
  endpoint = process.env.ARU_DESIRE_TURN_HOOK_ENDPOINT ??
    'http://127.0.0.1:18761/v1/complete-message',
  secretFile = process.env.ARU_DESIRE_TURN_HOOK_SECRET_FILE ?? '',
  timeoutMs = Number(process.env.ARU_DESIRE_TURN_HOOK_TIMEOUT_MS ?? 250),
} = {}) {
  const counters = {
    sent_count: 0,
    duplicate_count: 0,
    receiver_completed_count: 0,
    receiver_applied_count: 0,
    receiver_duplicate_count: 0,
    request_attempt_count: 0,
    retry_count: 0,
    initial_timeout_count: 0,
    initial_unavailable_count: 0,
    initial_receiver_error_count: 0,
    recovered_after_retry_count: 0,
    rejected_count: 0,
    timeout_count: 0,
    last_success_at: null,
    last_error_category: null,
  };
  if (!enabled) {
    return {
      enabled: false,
      deliver: () => Promise.resolve(),
      diagnostics: () => ({ enabled: false, ...counters }),
    };
  }
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+\/v1\/complete-message$/u.test(endpoint) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 2_000) {
    throw new Error('desire hook configuration is invalid');
  }
  const secret = secureSecret(secretFile);
  const delivered = new Set();

  async function send(event) {
    if (delivered.has(event.event_id)) {
      counters.duplicate_count += 1;
      return;
    }
    counters.request_attempt_count += 1;
    let result = await sendOnce({ endpoint, secret, timeoutMs }, event);
    if (!result.ok && result.retryable) {
      counters.retry_count += 1;
      if (result.category === 'timeout') counters.initial_timeout_count += 1;
      else if (result.category === 'unavailable') counters.initial_unavailable_count += 1;
      else if (result.category === 'receiver_error') counters.initial_receiver_error_count += 1;
      counters.request_attempt_count += 1;
      result = await sendOnce({ endpoint, secret, timeoutMs }, event);
      if (result.ok) counters.recovered_after_retry_count += 1;
    }
    if (result.ok) {
      delivered.add(event.event_id);
      if (delivered.size > 4096) delivered.delete(delivered.values().next().value);
      counters.sent_count += 1;
      if (['applied', 'settled', 'no_op', 'duplicate'].includes(result.receiverStatus)) {
        counters.receiver_completed_count += 1;
      }
      if (result.receiverStatus === 'applied' || result.receiverStatus === 'settled') {
        counters.receiver_applied_count += 1;
      } else if (result.receiverStatus === 'duplicate') {
        counters.receiver_duplicate_count += 1;
      }
      counters.last_success_at = Date.now();
      counters.last_error_category = null;
    } else {
      if (result.category === 'timeout') counters.timeout_count += 1;
      else counters.rejected_count += 1;
      counters.last_error_category = result.category;
    }
  }

  return {
    enabled,
    deliver(turnEvent) {
      if (!enabled) return Promise.resolve();
      const events = canonicalEvents(turnEvent);
      if (events.length !== 2) {
        counters.rejected_count += 1;
        counters.last_error_category = 'incomplete_or_oversize';
        return Promise.resolve();
      }
      return events.reduce(
        (pending, event) => pending.then(() => send(event)),
        Promise.resolve(),
      );
    },
    diagnostics() {
      return { enabled, ...counters };
    },
  };
}

export function wrapOnTurnSettled(existing, hook) {
  return (event) => {
    const existingResult = existing(event);
    void hook.deliver(event).catch(() => {});
    return existingResult;
  };
}

export const __test = { canonicalEvents };
