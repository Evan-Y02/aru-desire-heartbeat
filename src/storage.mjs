import { constants, link, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRegularFile, ensureSecureDirectory } from './security.mjs';
import { validateConfig, validateState, ValidationError } from './schema.mjs';

export const STATE_FILE = 'state.json';

function normalizeState(state) {
  if (state.solo === undefined) {
    state.solo = {
      count: 0,
      lastSoloAt: null,
      refractoryUntil: null,
      lastLibidoChoice: null,
    };
  }
  return state;
}

export async function loadConfig(configPath) {
  const text = await readFile(configPath, 'utf8');
  let config;
  try { config = JSON.parse(text); } catch { throw new ValidationError('configuration is not valid JSON'); }
  return validateConfig(config);
}

export async function loadState(dataDirectory, config) {
  const directory = await ensureSecureDirectory(dataDirectory);
  const statePath = path.join(directory, STATE_FILE);
  await assertSecureRegularFile(statePath);
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch { throw new ValidationError('state file is not valid JSON', 'STATE_CORRUPT'); }
  return validateState(normalizeState(state), config);
}

export async function atomicSaveState(dataDirectory, state, config, { mustCreate = false } = {}) {
  const directory = await ensureSecureDirectory(dataDirectory);
  validateState(state, config);
  const statePath = path.join(directory, STATE_FILE);
  await assertSecureRegularFile(statePath, { allowMissing: true });
  const tempPath = path.join(directory, `.state.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (mustCreate) {
      await link(tempPath, statePath);
      await unlink(tempPath);
    } else {
      await rename(tempPath, statePath);
    }
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  await assertSecureRegularFile(statePath);
}

export async function initializeState(dataDirectory, state, config) {
  const directory = await ensureSecureDirectory(dataDirectory, { create: true });
  const statePath = path.join(directory, STATE_FILE);
  if (await assertSecureRegularFile(statePath, { allowMissing: true })) {
    throw new ValidationError('state already exists; init refuses overwrite', 'ALREADY_INITIALIZED');
  }
  await atomicSaveState(directory, state, config, { mustCreate: true });
  return statePath;
}