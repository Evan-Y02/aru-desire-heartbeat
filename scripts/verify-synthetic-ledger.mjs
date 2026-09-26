#!/usr/bin/env node
import path from 'node:path';
import { canonicalEventId } from '../src/canonical-turn-event.mjs';
import { loadInteractionState } from '../src/interaction-storage.mjs';
import { loadConfig, loadState } from '../src/storage.mjs';

const [configFile, dataDirectory, activationId] = process.argv.slice(2);
if (!configFile || !dataDirectory || !/^activation-[0-9]{8}T[0-9]{6}Z$/u.test(activationId ?? '')) {
  throw new Error('config, data directory, and activation id are required');
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
  if (desire.appliedChatEventIds?.filter((item) => item === id).length !== 1 ||
      interaction.chat.processedEvents.filter((item) => item.eventId === id).length !== 1 ||
      interaction.arousal.processedEvents.filter((item) => item === id).length !== 1) {
    throw new Error('synthetic event was not applied exactly once');
  }
}
