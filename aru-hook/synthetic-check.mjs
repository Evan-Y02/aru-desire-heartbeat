#!/usr/bin/env node
import { createAruDesireTurnHook } from './aru-desire-turn-hook.mjs';

const activationId = process.argv[2];
if (!/^activation-[0-9]{8}T[0-9]{6}Z$/u.test(activationId ?? '')) {
  throw new Error('a bounded activation id is required');
}
const now = Date.now();
const user = {
  messageId: `hostmsg_${activationId}_user`,
  role: 'user',
  status: 'completed',
  content: 'Synthetic neutral activation event.',
  createdAt: now,
  updatedAt: now,
};
const assistant = {
  messageId: `hostmsg_${activationId}_assistant`,
  role: 'assistant',
  status: 'completed',
  content: 'Synthetic neutral activation final.',
  createdAt: now + 1,
  updatedAt: now + 1,
};
const event = {
  outcome: 'completed',
  conversation: {
    conversationId: `hostconv_${activationId}`,
    messages: [user, assistant],
  },
  turn: {
    userMessageId: user.messageId,
    assistantMessageId: assistant.messageId,
    completedAt: now + 1,
  },
  assistantMessage: assistant,
};
const hook = createAruDesireTurnHook();
await hook.deliver(event);
await hook.deliver(event);
const result = hook.diagnostics();
if (result.sent_count !== 2 || result.duplicate_count !== 2 || result.rejected_count !== 0 ||
    result.timeout_count !== 0 || result.receiver_completed_count !== 2 ||
    result.receiver_duplicate_count !== 0) throw new Error('synthetic hook check failed');

// A fresh hook has no in-memory delivery cache. Replaying through it proves
// receiver-side idempotency rather than merely exercising the hook's cache.
const replayHook = createAruDesireTurnHook();
await replayHook.deliver(event);
const replay = replayHook.diagnostics();
if (replay.sent_count !== 2 || replay.duplicate_count !== 0 || replay.rejected_count !== 0 ||
    replay.timeout_count !== 0 || replay.receiver_completed_count !== 2 ||
    replay.receiver_duplicate_count !== 2) throw new Error('synthetic receiver replay check failed');
