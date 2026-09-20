import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ENVELOPE_SCHEMA,
  parseSenderBundle,
  PAYLOAD_SCHEMA,
  sealWakeEvent,
  SENDER_BUNDLE_SCHEMA,
  submitAruExternalTrigger,
} from '../delivery/aru-wake-sender.mjs';

const KEY = Buffer.alloc(32, 7);
const TOKEN = Buffer.alloc(32, 3).toString('base64');
const BUNDLE = Object.freeze({
  schema: SENDER_BUNDLE_SCHEMA,
  triggerId: '00000000-0000-4000-8000-000000000001',
  submitURL: 'https://host.example/aru/v1/wake-bridge/endpoints/test/events',
  submitToken: TOKEN,
  encryptionKey: KEY.toString('base64'),
});

test('sender bundle validation is strict and requires HTTPS', () => {
  const parsed = parseSenderBundle(JSON.stringify(BUNDLE));
  assert.equal(parsed.schema, SENDER_BUNDLE_SCHEMA);
  assert.equal(parsed.triggerId, BUNDLE.triggerId);
  assert.throws(() => parseSenderBundle({ ...BUNDLE, submitURL: 'http://host.example/events' }));
  assert.throws(() => parseSenderBundle({ ...BUNDLE, encryptionKey: 'not-a-key' }));
  assert.throws(() => parseSenderBundle({ ...BUNDLE, schema: 'unknown' }));
});
test('sealed event matches the Aru v0.30.2 AES-256-GCM protocol', () => {
  const event = {
    schema: 'aru.desire-heartbeat.event.v1',
    eventId: 'decision-1',
    userAuthored: false,
    purpose: 'automatic_trigger',
  };
  const envelope = sealWakeEvent(BUNDLE, JSON.stringify(event), event.eventId);
  assert.equal(envelope.schema, ENVELOPE_SCHEMA);
  assert.equal(envelope.eventId, event.eventId);

  const combined = Buffer.from(envelope.sealedPayload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, combined.subarray(0, 12));
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(combined.subarray(12, combined.length - 16)),
    decipher.final(),
  ]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  assert.equal(payload.schema, PAYLOAD_SCHEMA);
  assert.equal(payload.eventId, event.eventId);
  assert.equal(payload.triggerId, BUNDLE.triggerId);
  assert.deepEqual(JSON.parse(payload.content), event);
  assert.equal(payload.collaboratorId, undefined);
  assert.equal(payload.conversationId, undefined);
});
test('submission uses only the credential URL and bearer token', async () => {
  const event = {
    schema: 'aru.desire-heartbeat.event.v1',
    eventId: 'decision-2',
    userAuthored: false,
  };
  let posted;
  const result = await submitAruExternalTrigger({
    credential: BUNDLE,
    event,
    timeoutMs: 1000,
    requestImpl: async (options) => {
      posted = options;
      return {
        status: 202,
        body: JSON.stringify({
          schema: ENVELOPE_SCHEMA,
          eventId: event.eventId,
          accepted: true,
        }),
      };
    },
  });
  assert.equal(posted.url, BUNDLE.submitURL);
  assert.equal(posted.method, 'POST');
  assert.equal(posted.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(posted.timeoutMs, 1000);
  const envelope = JSON.parse(posted.body);
  assert.equal(envelope.schema, ENVELOPE_SCHEMA);
  assert.equal(envelope.eventId, event.eventId);
  assert.deepEqual(result, { accepted: true, eventId: event.eventId });
});

test('native HTTPS sender runs under --jitless without Undici or WebAssembly', () => {
  const moduleUrl = new URL('../delivery/aru-wake-sender.mjs', import.meta.url).href;
  const source = `
    import { submitAruExternalTrigger } from ${JSON.stringify(moduleUrl)};
    const credential = ${JSON.stringify({ ...BUNDLE, submitURL: 'https://127.0.0.1:1/events' })};
    const event = { schema: 'aru.desire-heartbeat.event.v1', eventId: 'jitless-test' };
    try {
      await submitAruExternalTrigger({ credential, event, timeoutMs: 250 });
      process.exit(2);
    } catch (error) {
      process.stdout.write(String(error.code));
    }
  `;
  const child = spawnSync(process.execPath, ['--jitless', '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ARU_REQUEST_FAILED');
  assert.doesNotMatch(child.stderr, /WebAssembly|undici/i);
});