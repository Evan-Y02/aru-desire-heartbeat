import { constants, link, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRegularFile, ensureSecureDirectory } from './security.mjs';
import { validateConfig, validateState, ValidationError } from './schema.mjs';

export const STATE_FILE = 'state.json';

const SAFE_FEATURE_DEFAULTS = Object.freeze({
  chatStimulusEnabled: false,
  arousalEnabled: false,
  arousalDriveSettlementEnabled: false,
  soloSessionsEnabled: false,
  chatStimulus: {
    decayTauSeconds: 21600,
    windowSeconds: 3600,
    ledgerMaxCount: 512,
    pendingMaxCount: 24,
    intimacyNoReleaseCarryoverFactor: 0.80,
    singleCaps: {
      attachment: 0.08, curiosity: 0.03, reflection: 0.08, duty: 0.08,
      social: 0.06, fatigue: 0, libido: 0.10, stress: 0.08,
    },
    windowCaps: {
      attachment: 0.20, curiosity: 0.08, reflection: 0.20, duty: 0.20,
      social: 0.16, fatigue: 0, libido: 0.24, stress: 0.20,
    },
  },
  arousal: {
    tauSeconds: 1800,
    gain: 0.20,
    charged: 0.40,
    edge: 0.88,
    ponr: 0.96,
    refractoryMinSeconds: 60,
    refractoryMaxSeconds: 120,
    reserveRecoverySeconds: 10800,
    passiveContactCap: 0.72,
    ledgerMaxCount: 512,
    releaseCarryoverFactor: 0.30,
  },
});

function normalizeConfig(config) {
  for (const key of [
    'chatStimulusEnabled', 'arousalEnabled', 'arousalDriveSettlementEnabled',
    'soloSessionsEnabled',
  ]) config[key] ??= SAFE_FEATURE_DEFAULTS[key];
  config.chatStimulus ??= structuredClone(SAFE_FEATURE_DEFAULTS.chatStimulus);
  config.arousal ??= structuredClone(SAFE_FEATURE_DEFAULTS.arousal);
  config.solo.outputMultiplier ??= 0.80;
  config.solo.reserveCostMultiplier ??= 0.80;
  config.solo.sessionMaxCount ??= 24;
  config.solo.maxActionBeats ??= 24;
  return config;
}

function normalizeState(state) {
  if (state.solo === undefined) {
    state.solo = {
      count: 0,
      lastSoloAt: null,
      refractoryUntil: null,
      lastLibidoChoice: null,
    };
  }
  if (state.expression === undefined) {
    state.expression = { consecutiveWithholds: 0 };
  }
  return state;
}

export async function loadConfig(configPath) {
  const text = await readFile(configPath, 'utf8');
  let config;
  try { config = JSON.parse(text); } catch { throw new ValidationError('configuration is not valid JSON'); }
  return validateConfig(normalizeConfig(config));
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
