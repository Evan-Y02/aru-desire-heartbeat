#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { deliverPending, DeliveryError, validateDeliveryConfig } from '../delivery/aru-adapter.mjs';
import { submitAruExternalTrigger } from '../delivery/aru-wake-sender.mjs';
import { atomicSaveState, loadConfig, loadState } from '../src/storage.mjs';
import { withLock } from '../src/security.mjs';
import { finishLatestTimeline } from '../src/timeline.mjs';
import { ValidationError } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HEARTBEAT_CONFIG = path.join(ROOT, 'config', 'default.json');
const DEFAULT_DELIVERY_CONFIG = path.join(ROOT, 'config', 'aru-delivery.json');
const DEFAULT_DATA = path.join(ROOT, 'data');

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new ValidationError('options must be --name value pairs');
    }
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new ValidationError('duplicate option');
    options[key] = value;
  }
  const allowed = ['config', 'delivery-config', 'data-dir'];
  if (Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new ValidationError('unsupported option');
  }
  return options;
}
async function loadDeliveryConfig(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new DeliveryError('delivery config is not valid JSON', 'DELIVERY_CONFIG_INVALID'); }
  return validateDeliveryConfig(value);
}

function safeError(error) {
  const known = error instanceof DeliveryError || error instanceof ValidationError ||
    error?.name === 'SecurityError';
  return {
    error: known ? error.code ?? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
    message: known ? error.message : 'operation failed',
  };
}

try {
  const options = parse(process.argv.slice(2));
  const heartbeatConfig = await loadConfig(path.resolve(options.config ?? DEFAULT_HEARTBEAT_CONFIG));
  const deliveryConfig = await loadDeliveryConfig(
    path.resolve(options['delivery-config'] ?? DEFAULT_DELIVERY_CONFIG),
  );
  const dataDirectory = path.resolve(options['data-dir'] ?? DEFAULT_DATA);
  const result = await withLock(dataDirectory, async (directory) => {
    const state = await loadState(directory, heartbeatConfig);
    const pendingAt = state.pendingDecision?.createdAt?.epochMs ?? null;
    const delivery = await deliverPending({
      state,
      heartbeatConfig,
      deliveryConfig,
      dataDirectory: directory,
      submitEvent: submitAruExternalTrigger,
    });
    if (pendingAt !== null) {
      finishLatestTimeline(delivery.state, pendingAt, 'submitted', ['delivery-accepted']);
    }
    await atomicSaveState(directory, delivery.state, heartbeatConfig);
    return delivery;
  });
  process.stdout.write(`${JSON.stringify({
    schema: 'aru.desire-heartbeat.delivery-result.v1',
    accepted: result.accepted,
    decisionId: result.decisionId,
    intent: result.intent,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
}