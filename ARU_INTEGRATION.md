# Aru external-trigger integration

Scope: source inspection of the installed Aru Self-Hosted
`v0.30.2-pairing-hotfix1` release and the Aru UI supplied by the user. The
desired runtime target is the Aru frontend app. GPT Work and Codex are deployment
tools only and are not heartbeat targets or memory authorities.

The exported submit-only sender bundle was inspected locally with all secret
values redacted. No authenticated API request, Aru state read, service action,
conversation action, real event submission, or model call was performed.

## Product decision

The desire system must not recreate the old Polaris fixed-time messages. The user
does not want scheduled prompts. A ten-minute heartbeat always advances internal
state. A persisted, restart-stable deadline selects a random 30–120 minute
opportunity to evaluate a new proactive decision; the opportunity does not force
a message. Only an eligible decision may then wake the Aru collaborator.

The Aru external trigger is the selected integration:

- name: `欲望系统唤醒`;
- receiving Host: `Aru Self-Hosted`;
- message purpose: `自动触发`;
- conversation mode: `跟随最新对话`.

The event body is background context, not a user utterance. The awakened
collaborator must read Aru conversation and memory, then decide naturally whether
and how to contact 解月.

## Source-proven wake-bridge boundary

The Host manifest advertises `external-wake-bridge` with registration schema
`aru.wake-bridge.registration.v2` and ciphertext-only content retention.

A registered endpoint separates:

- a submit token used only to submit events;
- a fetch token used to retrieve and acknowledge events;
- an encryption-key fingerprint;
- an opaque official wake-relay route and wake token.

The Host stores hashes for submit and fetch tokens. Event content enters the Host
as a `sealedPayload`; the Host does not receive plaintext desire text.
The Host endpoint accepts:

```text
POST /aru/v1/wake-bridge/endpoints/{endpointId}/events
Authorization: Bearer <submit token>
```

with a sealed envelope containing schema
`aru.wake-bridge.sealed-event.v1`, a bounded `eventId`, and a bounded
`sealedPayload`. Acceptance returns HTTP 202.

Duplicate event IDs with identical ciphertext are idempotent. Reusing an event
ID with different ciphertext is rejected. The Host limits one endpoint to 120
admitted events per minute, returns at most 32 pending events per fetch, caps
sealed payloads at 192 KiB, and prunes acknowledged history after 30 days while
bounding total retained events.

After admission, the Host sends only an HMAC-derived request ID to the official
wake relay. It does not send the event plaintext to that relay.

## Mobile-authoritative behavior

The source installed on the VPS proves the ciphertext bridge and notification
path, but it does not contain the iOS implementation that decrypts an event and
applies the locally bound collaborator, purpose, and conversation route. Those
bindings are shown by the Aru UI and remain phone-authoritative.

The exported credential is `aru.wake-bridge.sender-bundle.v2` and contains a
trigger ID, HTTPS submit URL, submit-only token, and 32-byte encryption key. It
was captured directly into an owner-only file and was never pasted into chat.
The phone still owns collaborator, purpose, and latest-conversation routing.

## Rejected integration

The collaborator initiative subsystem and its
`initiative/rules/{ruleId}/run` endpoint are not the desire-system transport.
They model fixed one-time, daily, or interval proactive plans and require a broad
paired-device bearer credential. No collaborator ID, initiative rule ID, or old
Polaris schedule belongs in the external-trigger adapter.
## Prepared adapter status

The disabled-by-default autonomous cycle now:

- advances desire locally with per-drive growth and bounded reproducible variation,
  then persists a pending decision before submission;
- uses one-pending-decision and per-decision claims for deduplication;
- preserves the fatigue gate and explicit delivery flags without fixed quiet
  hours, a daily quota, or a fixed cooldown;
- converts a pending decision into
  `xinchao.desire-external-event.v1`;
- marks the event `userAuthored: false` and `purpose: automatic_trigger`;
- includes only the decision identity, triggering drive and intent, and fixed
  non-user-authored guidance; it omits drive values, scores, action details,
  and thought records;
- requires an exact enable file and an owner-only send-credential file;
- writes a per-decision claim before submission;
- never automatically retries accepted or ambiguous attempts;
- lowers desire only after the Host returns matching HTTP acceptance;
- contains no initiative-rule lookup, hosted-reply dependency, or run request.

The separate sender now matches Aru Host v0.30.2's official
`wake-send.mjs`: AES-256-GCM with a fresh 12-byte nonce, combined
nonce/ciphertext/16-byte tag Base64 encoding, submit-token Bearer authorization,
and matching event-ID acceptance checks. Tests decrypt the mock envelope and
verify its complete payload without using the real credential or network.

With the committed defaults, delivery remains disabled. No files are installed,
no timer is enabled, and no Aru message has been sent.

## Activation sequencing

Version 0.9.15 keeps the standalone preflight strictly read-only. During a
separately confirmed apply, the script first records the timer state and installs
failure recovery, then quiesces the timer and confirms the heartbeat service is
inactive. It runs exactly one complete internal preflight in that stable state;
an inactive timer is valid and requires no additional quiesce. Delivery gates and
the enable file remain unchanged until this preflight and the final pending
decision check pass. Every later failure closes delivery and restores the prior
timer and protected-file state, so no half-enabled state remains.

## Active-production upgrade comparison

Version 0.9.17 keeps the active v0.9.16 transaction and adds fixed preflight
failure categories. Systemd units are equivalent only when differences are
limited to LF/CRLF form, a missing final newline, or trailing whitespace-only
lines. Nonblank lines are not trimmed or semantically rewritten: an altered
command, path, parameter, permission, user, environment assignment, section,
or other effective value fails closed before backup, quiesce, gate mutation, or
installation. Failure output contains the category only, never unit contents,
runtime values, credentials, URLs, or conversation material.
