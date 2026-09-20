import { constants, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { satisfyDecision, timePair } from '../src/engine.mjs';
import { validateState } from '../src/schema.mjs';
import { parseSenderBundle } from './aru-wake-sender.mjs';

const ENABLE_MAGIC = 'aru-desire-heartbeat-external-trigger-v1';
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export class DeliveryError extends Error {
  constructor(message, code = 'DELIVERY_ERROR') {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeliveryError(`${label} must be an object`, 'DELIVERY_CONFIG_INVALID');
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DeliveryError(`${label} must be a positive integer`, 'DELIVERY_CONFIG_INVALID');
  }
}

function absoluteFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new DeliveryError(`${label} must be an absolute path`, 'DELIVERY_CONFIG_INVALID');
  }
}
export function validateDeliveryConfig(config) {
  plainObject(config, 'delivery config');
  if (config.schema !== 'aru.desire-heartbeat.external-trigger.v1' || config.version !== 1) {
    throw new DeliveryError('unsupported delivery config schema', 'DELIVERY_CONFIG_INVALID');
  }
  if (typeof config.enabled !== 'boolean') {
    throw new DeliveryError('delivery config enabled must be boolean', 'DELIVERY_CONFIG_INVALID');
  }
  absoluteFile(config.credentialPath, 'credentialPath');
  absoluteFile(config.enableFile, 'enableFile');
  positiveInteger(config.timeoutMs, 'timeoutMs');
  positiveInteger(config.maxEventBytes, 'maxEventBytes');
  if (config.maxEventBytes > 192 * 1024) {
    throw new DeliveryError('maxEventBytes exceeds the Aru sealed-event limit', 'DELIVERY_CONFIG_INVALID');
  }
  return config;
}

async function secureCredential(file) {
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600 ||
      info.size < 1 || info.size > MAX_CREDENTIAL_BYTES) {
    throw new DeliveryError('external-trigger credential file is missing or unsafe', 'CREDENTIAL_UNSAFE');
  }
  const value = await readFile(file, 'utf8');
  if (!value.trim() || /\u0000/u.test(value)) {
    throw new DeliveryError('external-trigger credential content is invalid', 'CREDENTIAL_UNSAFE');
  }
  try {
    return parseSenderBundle(value.trim());
  } catch {
    throw new DeliveryError(
      'external-trigger credential format is invalid',
      'CREDENTIAL_INVALID',
    );
  }
}

async function requireEnableFile(file) {
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new DeliveryError('delivery enable file is missing or unsafe', 'DELIVERY_NOT_ENABLED');
  }
  if ((await readFile(file, 'utf8')).trim() !== ENABLE_MAGIC) {
    throw new DeliveryError('delivery enable file does not match', 'DELIVERY_NOT_ENABLED');
  }
}
function relatedThoughts(state, drive) {
  return state.thoughts
    .filter((thought) => thought.drive === drive)
    .sort((left, right) => right.intensity - left.intensity ||
      right.updatedAt.epochMs - left.updatedAt.epochMs)
    .slice(0, 8)
    .map((thought) => ({
      id: thought.id,
      type: thought.type,
      intensity: thought.intensity,
      text: thought.text,
      updatedAt: thought.updatedAt,
    }));
}

export function buildDesireEvent(state, nowMs = Date.now()) {
  const decision = state.pendingDecision;
  if (!decision) throw new DeliveryError('there is no pending decision', 'NO_PENDING_DECISION');
  return {
    schema: 'aru.desire-heartbeat.event.v1',
    eventId: decision.id,
    eventType: 'desire_threshold_reached',
    occurredAt: timePair(nowMs),
    source: 'vps-desire-heartbeat',
    userAuthored: false,
    purpose: 'automatic_trigger',
    decision: {
      id: decision.id,
      drive: decision.drive,
      intent: decision.intent,
      score: decision.score,
      wantAction: structuredClone(decision.wantAction),
    },
    drives: structuredClone(state.drives),
    relatedThoughts: relatedThoughts(state, decision.drive),
    guidance: [
      '这是欲望系统产生的内部状态事件，不是用户发来的消息。',
      '请读取 Aru 当前对话与记忆，结合时间、关系上下文和本次欲望自主决定如何主动联系用户。',
      '不要复述事件数据，也不要声称用户刚刚发来了请求。',
    ],
  };
}

function assertEventSize(event, maximum) {
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (bytes > maximum) {
    throw new DeliveryError('desire event exceeds configured size limit', 'EVENT_TOO_LARGE');
  }
}
async function claimDecision(dataDirectory, decisionId, nowMs) {
  const directory = path.join(dataDirectory, 'delivery-attempts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() ||
      (info.mode & 0o777) !== 0o700) {
    throw new DeliveryError('delivery attempt directory is unsafe', 'IDEMPOTENCY_UNSAFE');
  }
  const claim = path.join(directory, `${decisionId}.claimed.json`);
  for (const suffix of ['claimed', 'accepted', 'uncertain']) {
    const existing = path.join(directory, `${decisionId}.${suffix}.json`);
    if (await lstat(existing).then(() => true).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) {
      throw new DeliveryError('decision already has a delivery claim', 'DELIVERY_ALREADY_CLAIMED');
    }
  }
  let handle;
  try {
    handle = await open(claim, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify({ decisionId, claimedAt: nowMs })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new DeliveryError('decision already has a delivery claim', 'DELIVERY_ALREADY_CLAIMED');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return claim;
}

async function settleClaim(claim, suffix, record) {
  const target = claim.replace(/\.claimed\.json$/, `.${suffix}.json`);
  const handle = await open(claim, constants.O_WRONLY | constants.O_TRUNC);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(claim, target);
}
function deliveryGate(state, heartbeatConfig, deliveryConfig, nowMs) {
  validateState(state, heartbeatConfig);
  validateDeliveryConfig(deliveryConfig);
  if (!deliveryConfig.enabled || heartbeatConfig.observeOnly || !heartbeatConfig.deliveryEnabled) {
    throw new DeliveryError('delivery flags are not enabled', 'DELIVERY_NOT_ENABLED');
  }
  if (!state.pendingDecision) {
    throw new DeliveryError('there is no pending decision', 'NO_PENDING_DECISION');
  }
  if (state.pendingDecision.intent === 'solo') {
    throw new DeliveryError('solo decisions are local-only', 'SOLO_NOT_EXTERNAL');
  }
  if (state.drives.fatigue >= heartbeatConfig.fatigueGate) {
    throw new DeliveryError('fatigue gate blocks delivery', 'FATIGUE_GATE');
  }
  return state.pendingDecision;
}

export async function deliverPending({
  state, heartbeatConfig, deliveryConfig, dataDirectory,
  submitEvent, nowMs = Date.now(),
}) {
  const decision = deliveryGate(state, heartbeatConfig, deliveryConfig, nowMs);
  await requireEnableFile(deliveryConfig.enableFile);
  if (typeof submitEvent !== 'function') {
    throw new DeliveryError(
      'external-trigger sender is unavailable until the Aru send credential format is configured',
      'EXTERNAL_TRIGGER_SENDER_UNAVAILABLE',
    );
  }
  const credential = await secureCredential(deliveryConfig.credentialPath);
  const event = buildDesireEvent(state, nowMs);
  assertEventSize(event, deliveryConfig.maxEventBytes);
  const claim = await claimDecision(dataDirectory, decision.id, nowMs);
  try {
    const result = await submitEvent({
      credential,
      event,
      timeoutMs: deliveryConfig.timeoutMs,
    });
    if (result?.accepted !== true || result?.eventId !== event.eventId) {
      throw new DeliveryError('external trigger did not return a matching acceptance', 'ARU_RESPONSE_INVALID');
    }
    const next = structuredClone(state);
    const satisfied = satisfyDecision(next, heartbeatConfig, decision.id, nowMs);
    await settleClaim(claim, 'accepted', {
      decisionId: decision.id,
      intent: decision.intent,
      externalEventId: result.eventId,
      acceptedAt: nowMs,
    });
    return {
      state: satisfied,
      decisionId: decision.id,
      intent: decision.intent,
      event,
      accepted: true,
    };
  } catch (error) {
    await settleClaim(claim, 'uncertain', {
      decisionId: decision.id,
      intent: decision.intent,
      failedAt: nowMs,
      code: error instanceof DeliveryError ? error.code : 'EXTERNAL_TRIGGER_REQUEST_FAILED',
    }).catch(() => {});
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('external trigger request failed', 'EXTERNAL_TRIGGER_REQUEST_FAILED');
  }
}

export const deliveryEnableMagic = ENABLE_MAGIC;