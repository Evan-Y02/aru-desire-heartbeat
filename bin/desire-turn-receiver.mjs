#!/usr/bin/env node
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizeReceiverRequest,
  loadReceiverSecret,
  processCanonicalTurn,
  recoverPendingSettlement,
  readJsonBody,
} from '../src/turn-receiver.mjs';
import { ValidationError } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.ARU_DESIRE_RECEIVER_HOST ?? '127.0.0.1';
const port = Number(process.env.ARU_DESIRE_RECEIVER_PORT ?? 18761);
const configPath = path.resolve(process.env.ARU_DESIRE_CONFIG ?? path.join(ROOT, 'config/default.json'));
const dataDirectory = path.resolve(process.env.ARU_DESIRE_DATA_DIR ?? path.join(ROOT, 'data'));
const secretPath = path.resolve(
  process.env.ARU_DESIRE_TURN_HOOK_SECRET_FILE ?? path.join(dataDirectory, 'turn-hook.secret'),
);

if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('receiver must use a valid 127.0.0.1 endpoint');
}

const secret = await loadReceiverSecret(secretPath);
await recoverPendingSettlement({ configPath, dataDirectory });
const diagnostics = {
  accepted_count: 0,
  duplicate_count: 0,
  rejected_count: 0,
  last_success_at: null,
  last_error_category: null,
};

function send(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    send(response, 200, { status: 'ok', ...diagnostics });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/complete-message') {
    send(response, 404, { error: 'not_found' });
    return;
  }
  if (!authorizeReceiverRequest(request.headers.authorization, secret)) {
    diagnostics.rejected_count += 1;
    diagnostics.last_error_category = 'unauthorized';
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  try {
    const event = await readJsonBody(request);
    const result = await processCanonicalTurn({ event, configPath, dataDirectory });
    if (result.status === 'duplicate') diagnostics.duplicate_count += 1;
    diagnostics.accepted_count += 1;
    diagnostics.last_success_at = Date.now();
    diagnostics.last_error_category = null;
    send(response, 200, { status: result.status });
  } catch (error) {
    diagnostics.rejected_count += 1;
    diagnostics.last_error_category = error instanceof ValidationError
      ? error.code : error?.code === 'LOCKED' ? 'busy' : 'processing_error';
    const status = error?.statusCode ?? (error?.code === 'LOCKED' ? 503 : 422);
    send(response, status, { error: diagnostics.last_error_category });
  }
});

server.requestTimeout = 1_000;
server.headersTimeout = 1_000;
server.keepAliveTimeout = 500;
server.listen(port, host);
