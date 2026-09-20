import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod } from 'node:fs/promises';
import {
  addThought, adjustDrive, createInitialState, decideState, feedDrive,
  publicSnapshot, rebaseClock, satisfyDecision, satisfySoloDecision,
  setDrive, simulateAutonomy, simulateState, tickState,
} from './engine.mjs';
import { initializeState, loadConfig, loadState, atomicSaveState } from './storage.mjs';
import { ensureSecureDirectory, withLock } from './security.mjs';
import { ValidationError } from './schema.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(PROJECT_ROOT, 'config', 'default.json');
const DEFAULT_DATA = path.join(PROJECT_ROOT, 'data');

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--') || token.length < 3) throw new ValidationError('unexpected positional argument');
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new ValidationError('duplicate option');
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ValidationError('option value is missing');
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function only(options, allowed) {
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new ValidationError('unsupported option');
}

function numberOption(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label} must be numeric`);
  return number;
}

function integerOption(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new ValidationError(`${label} must be an integer`);
  return number;
}

function percentOption(value, label, { signed = false } = {}) {
  const number = numberOption(value, label);
  const minimum = signed ? -100 : 0;
  if (number < minimum || number > 100 || (signed && number === 0)) {
    throw new ValidationError(
      signed
        ? `${label} must be non-zero and between -100 and 100`
        : `${label} must be between 0 and 100`,
    );
  }
  return number / 100;
}

async function mutate(dataDirectory, config, operation) {
  return withLock(dataDirectory, async (directory) => {
    const state = await loadState(directory, config);
    const result = await operation(state);
    await atomicSaveState(directory, result.state ?? result, config);
    return result;
  });
}

export async function run(argv, io = console) {
  const { command, options } = parseArguments(argv);
  const configPath = path.resolve(options.config ?? DEFAULT_CONFIG);
  const dataDirectory = path.resolve(options['data-dir'] ?? DEFAULT_DATA);
  const config = await loadConfig(configPath);

  switch (command) {
    case 'init': {
      only(options, ['config', 'data-dir']);
      await ensureSecureDirectory(dataDirectory, { create: true });
      await chmod(dataDirectory, 0o700);
      const state = createInitialState(config);
      await withLock(dataDirectory, async (directory) => initializeState(directory, state, config));
      io.log(JSON.stringify(publicSnapshot(state, { initialized: true })));
      break;
    }
    case 'status': {
      only(options, ['config', 'data-dir']);
      const state = await loadState(dataDirectory, config);
      io.log(JSON.stringify(publicSnapshot(state)));
      break;
    }
    case 'tick': {
      only(options, ['config', 'data-dir']);
      const result = await mutate(dataDirectory, config, (state) => tickState(state, config));
      io.log(JSON.stringify(publicSnapshot(result.state, {
        elapsedSeconds: result.elapsedSeconds,
        sentinel: result.sentinel,
      })));
      break;
    }
    case 'rebase-clock': {
      only(options, ['config', 'data-dir']);
      const result = await mutate(dataDirectory, config, (state) => {
        const previousTickAt = state.lastTickAt;
        const next = rebaseClock(state, config);
        return { state: next, previousTickAt };
      });
      io.log(JSON.stringify(publicSnapshot(result.state, {
        clockRebased: true,
        previousTickAt: result.previousTickAt,
        drivesUnchanged: true,
        thoughtsUnchanged: true,
        timelineUnchanged: true,
      })));
      break;
    }
    case 'set-drive': {
      only(options, ['config', 'data-dir', 'drive', 'value']);
      const value = percentOption(options.value, 'value');
      const result = await mutate(dataDirectory, config, (state) => {
        const previous = state.drives[options.drive];
        const next = setDrive(state, config, options.drive, value);
        return { state: next, previous, current: next.drives[options.drive] };
      });
      io.log(JSON.stringify(publicSnapshot(result.state, {
        changedDrive: options.drive,
        operation: 'set',
        previousPercent: result.previous * 100,
        currentPercent: result.current * 100,
      })));
      break;
    }
    case 'adjust-drive': {
      only(options, ['config', 'data-dir', 'drive', 'delta']);
      const delta = percentOption(options.delta, 'delta', { signed: true });
      const result = await mutate(dataDirectory, config, (state) => {
        const previous = state.drives[options.drive];
        const next = adjustDrive(state, config, options.drive, delta);
        return { state: next, previous, current: next.drives[options.drive] };
      });
      io.log(JSON.stringify(publicSnapshot(result.state, {
        changedDrive: options.drive,
        operation: 'adjust',
        requestedDeltaPercent: delta * 100,
        previousPercent: result.previous * 100,
        currentPercent: result.current * 100,
      })));
      break;
    }
    case 'feed': {
      only(options, ['config', 'data-dir', 'drive', 'amount']);
      const result = await mutate(dataDirectory, config, (state) => feedDrive(
        state, config, options.drive, numberOption(options.amount, 'amount'),
      ));
      io.log(JSON.stringify(publicSnapshot(result, { changedDrive: options.drive })));
      break;
    }
    case 'thought-add': {
      only(options, ['config', 'data-dir', 'drive', 'type', 'intensity', 'text']);
      const result = await mutate(dataDirectory, config, (state) => addThought(state, config, {
        drive: options.drive,
        type: options.type,
        intensity: numberOption(options.intensity, 'intensity'),
        text: options.text,
      }));
      io.log(JSON.stringify(publicSnapshot(result, { thoughtAdded: true })));
      break;
    }
    case 'decide': {
      only(options, ['config', 'data-dir']);
      const result = await mutate(dataDirectory, config, (state) => decideState(state, config));
      io.log(JSON.stringify(publicSnapshot(result.state, { sentinel: result.sentinel })));
      break;
    }
    case 'satisfy': {
      only(options, ['config', 'data-dir', 'decision-id']);
      if (!options['decision-id']) throw new ValidationError('--decision-id is required');
      const result = await mutate(dataDirectory, config, (state) =>
        state.pendingDecision?.intent === 'solo'
          ? satisfySoloDecision(state, config, options['decision-id'])
          : satisfyDecision(state, config, options['decision-id']));
      io.log(JSON.stringify(publicSnapshot(result, { satisfied: true })));
      break;
    }
    case 'simulate-autonomy': {
      only(options, ['config', 'data-dir', 'ticks', 'step-seconds']);
      const state = await loadState(dataDirectory, config);
      const ticks = integerOption(options.ticks ?? '1', 'ticks');
      const stepSeconds = integerOption(
        options['step-seconds'] ?? String(config.heartbeatSeconds),
        'step-seconds',
      );
      const result = simulateAutonomy(state, config, ticks, stepSeconds);
      io.log(JSON.stringify(publicSnapshot(result.state, {
        simulatedAutonomy: true,
        simulatedTicks: ticks,
        expressionOpportunityCount: result.impulses.length,
        withheldOpportunityCount: result.impulses.filter((impulse) => !impulse.expressed).length,
        contacts: result.contacts.map((decision) => ({
          at: decision.createdAt,
          drive: decision.drive,
          intent: decision.intent,
          score: decision.score,
        })),
        solos: result.solos.map((decision) => ({
          at: decision.createdAt,
          drive: decision.drive,
          intent: decision.intent,
          score: decision.score,
        })),
      })));
      break;
    }
    case 'simulate': {
      only(options, ['config', 'data-dir', 'ticks', 'step-seconds']);
      const state = await loadState(dataDirectory, config);
      const result = simulateState(
        state,
        config,
        integerOption(options.ticks ?? '1', 'ticks'),
        integerOption(options['step-seconds'] ?? String(config.heartbeatSeconds), 'step-seconds'),
      );
      io.log(JSON.stringify(publicSnapshot(result.state, {
        simulated: true,
        simulatedTicks: integerOption(options.ticks ?? '1', 'ticks'),
        decisionsFormed: result.decisions.length,
      })));
      break;
    }
    default:
      throw new ValidationError('command must be one of: init, status, tick, rebase-clock, set-drive, adjust-drive, feed, thought-add, decide, satisfy, simulate, simulate-autonomy');
  }
}

export function safeError(error) {
  const known = error instanceof ValidationError || ['SecurityError'].includes(error?.name);
  return {
    error: known ? error.code ?? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    message: known ? error.message : 'operation failed',
  };
}