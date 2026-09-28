#!/usr/bin/env node
import path from 'node:path';
import { canonicalEventId } from '../src/canonical-turn-event.mjs';
import { loadInteractionState } from '../src/interaction-storage.mjs';
import { loadConfig, loadState } from '../src/storage.mjs';

const [mode, configFile, dataDirectory, activationId] = process.argv.slice(2);
if (!['absent', 'applied-once'].includes(mode) || !configFile || !dataDirectory ||
    !/^activation-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{16}$/u.test(activationId ?? '')) {
  throw new Error('mode, config, data directory, and unique activation id are required');
}
const config = await loadConfig(path.resolve(configFile));
const desire = await loadState(path.resolve(dataDirectory), config);
const interaction = await loadInteractionState(path.resolve(dataDirectory), config);
const conversationId = `hostconv_${activationId}`;
const ids = ['user', 'assistant'].map((role) => canonicalEventId({
  conversationId,
  messageId: `hostmsg_${activationId}_${role}`,
  role,
}));
for (const id of ids) {
  const counts = [
    desire.appliedChatEventIds?.filter((item) => item === id).length ?? 0,
    interaction.chat.processedEvents.filter((item) => item.eventId === id).length,
    interaction.arousal.processedEvents.filter((item) => item === id).length,
  ];
  const expected = mode === 'absent' ? 0 : 1;
  if (counts.some((count) => count !== expected)) {
    throw new Error(mode === 'absent'
      ? 'unique synthetic event already exists before acceptance'
      : 'synthetic event was not applied exactly once');
  }
}
