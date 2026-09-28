import { createHash } from 'node:crypto';

export const PENDING_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export function pendingDecisionFingerprint(decision) {
  const identity = [
    decision.id,
    decision.drive,
    decision.intent,
    String(decision.createdAt.epochMs),
  ].join('\u0000');
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}
