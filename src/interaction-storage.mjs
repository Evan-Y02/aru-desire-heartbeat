import { constants, link, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRegularFile, ensureSecureDirectory } from './security.mjs';
import { validateInteractionState } from './interaction-runtime.mjs';
import { ValidationError } from './schema.mjs';

export const INTERACTION_STATE_FILE = 'interaction-state.json';

export async function loadInteractionState(dataDirectory, config) {
  const directory = await ensureSecureDirectory(dataDirectory);
  const statePath = path.join(directory, INTERACTION_STATE_FILE);
  await assertSecureRegularFile(statePath);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new ValidationError('interaction state is not valid JSON', 'INTERACTION_STATE_CORRUPT');
  }
  return validateInteractionState(state, config);
}

export async function atomicSaveInteractionState(
  dataDirectory, state, config, { mustCreate = false } = {},
) {
  const directory = await ensureSecureDirectory(dataDirectory);
  validateInteractionState(state, config);
  const statePath = path.join(directory, INTERACTION_STATE_FILE);
  await assertSecureRegularFile(statePath, { allowMissing: true });
  const temporary = path.join(
    directory, `.interaction.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600,
    );
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (mustCreate) {
      await link(temporary, statePath);
      await unlink(temporary);
    } else {
      await rename(temporary, statePath);
    }
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await assertSecureRegularFile(statePath);
}

export async function initializeInteractionState(dataDirectory, state, config) {
  const directory = await ensureSecureDirectory(dataDirectory, { create: true });
  const statePath = path.join(directory, INTERACTION_STATE_FILE);
  if (await assertSecureRegularFile(statePath, { allowMissing: true })) {
    throw new ValidationError(
      'interaction state already exists; init refuses overwrite', 'ALREADY_INITIALIZED',
    );
  }
  await atomicSaveInteractionState(directory, state, config, { mustCreate: true });
  return statePath;
}
