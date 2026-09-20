import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const MAX_RESPONSE_BYTES = 64 * 1024;

export const SENDER_BUNDLE_SCHEMA = 'aru.wake-bridge.sender-bundle.v2';
export const PAYLOAD_SCHEMA = 'aru.wake-bridge.payload.v2';
export const ENVELOPE_SCHEMA = 'aru.wake-bridge.sealed-event.v1';

export class AruWakeSenderError extends Error {
  constructor(message, code = 'ARU_WAKE_SENDER_ERROR') {
    super(message);
    this.name = 'AruWakeSenderError';
    this.code = code;
  }
}

function invalid(message) {
  throw new AruWakeSenderError(message, 'ARU_SENDER_BUNDLE_INVALID');
}

function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || value.length < 1 ||
      Buffer.byteLength(value) > maximum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function decodeKey(value) {
  boundedString(value, 'encryptionKey', 128);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('encryptionKey is invalid');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    invalid('encryptionKey is invalid');
  }
  return key;
}
export function parseSenderBundle(value) {
  let bundle = value;
  if (typeof value === 'string') {
    try { bundle = JSON.parse(value); }
    catch { invalid('sender bundle is not valid JSON'); }
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    invalid('sender bundle must be an object');
  }
  if (bundle.schema !== SENDER_BUNDLE_SCHEMA) invalid('sender bundle schema is unsupported');
  const triggerId = boundedString(bundle.triggerId, 'triggerId', 128);
  const submitToken = boundedString(bundle.submitToken, 'submitToken', 256);
  const encryptionKey = boundedString(bundle.encryptionKey, 'encryptionKey', 128);
  decodeKey(encryptionKey);

  let submitURL;
  try { submitURL = new URL(bundle.submitURL); }
  catch { invalid('submitURL is invalid'); }
  if (submitURL.protocol !== 'https:' || submitURL.username || submitURL.password ||
      submitURL.hash) {
    invalid('submitURL must be credential-free HTTPS');
  }
  return Object.freeze({
    schema: SENDER_BUNDLE_SCHEMA,
    triggerId,
    submitURL: submitURL.href,
    submitToken,
    encryptionKey,
  });
}

export function sealWakeEvent(bundleValue, content, eventId = randomUUID()) {
  const bundle = parseSenderBundle(bundleValue);
  const id = boundedString(eventId, 'eventId', 128);
  const normalizedContent = String(content ?? '').trim();
  if (!normalizedContent) {
    throw new AruWakeSenderError('event content is empty', 'ARU_EVENT_INVALID');
  }
  const payload = Buffer.from(JSON.stringify({
    schema: PAYLOAD_SCHEMA,
    eventId: id,
    triggerId: bundle.triggerId,
    content: normalizedContent,
  }), 'utf8');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(bundle.encryptionKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema: ENVELOPE_SCHEMA,
    eventId: id,
    sealedPayload: Buffer.concat([nonce, ciphertext, tag]).toString('base64'),
  };
}

function postJsonWithHttps({ url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof AruWakeSenderError ? error : new AruWakeSenderError(
        'wake submission request failed',
        'ARU_REQUEST_FAILED',
      ));
    };
    const request = httpsRequest(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy(new AruWakeSenderError(
            'wake submission response is too large',
            'ARU_RESPONSE_INVALID',
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new AruWakeSenderError(
      'wake submission timed out',
      'ARU_SUBMISSION_TIMEOUT',
    )));
    request.on('error', fail);
    request.end(body);
  });
}

export async function submitAruExternalTrigger({
  credential,
  event,
  timeoutMs,
  requestImpl = postJsonWithHttps,
}) {
  const bundle = parseSenderBundle(credential);
  const envelope = sealWakeEvent(bundle, JSON.stringify(event), event.eventId);
  const response = await requestImpl({
    url: bundle.submitURL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${bundle.submitToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(envelope),
    timeoutMs,
  });
  if (!Number.isSafeInteger(response?.status) || response.status < 200 || response.status >= 300) {
    throw new AruWakeSenderError(
      `wake submission failed with HTTP ${response?.status ?? 0}`,
      'ARU_SUBMISSION_FAILED',
    );
  }
  let result;
  try { result = JSON.parse(response.body); }
  catch {
    throw new AruWakeSenderError(
      'wake submission returned invalid JSON',
      'ARU_RESPONSE_INVALID',
    );
  }
  return {
    accepted: result?.accepted === true,
    eventId: typeof result?.eventId === 'string' ? result.eventId : '',
  };
}