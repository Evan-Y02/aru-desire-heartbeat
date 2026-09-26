#!/usr/bin/env node
import path from 'node:path';
import { createInteractionState } from '../src/interaction-runtime.mjs';
import { initializeInteractionState } from '../src/interaction-storage.mjs';
import { withLock } from '../src/security.mjs';
import { atomicSaveState, loadConfig, loadState } from '../src/storage.mjs';

const options = Object.fromEntries(
  Array.from({ length: process.argv.slice(2).length / 2 }, (_, index) => {
    const args = process.argv.slice(2);
    return [args[index * 2]?.replace(/^--/u, ''), args[index * 2 + 1]];
  }),
);
if (!options.config || !options['data-dir'] || Object.keys(options).some((key) =>
  !['config', 'data-dir'].includes(key))) throw new Error('expected --config and --data-dir');

const configPath = path.resolve(options.config);
const dataDirectory = path.resolve(options['data-dir']);
const config = await loadConfig(configPath);
await withLock(dataDirectory, async (directory) => {
  const state = await loadState(directory, config);
  state.appliedChatEventIds ??= [];
  state.appliedEffectIds ??= [];
  await atomicSaveState(directory, state, config);
  await initializeInteractionState(directory, createInteractionState(Date.now()), config);
});
