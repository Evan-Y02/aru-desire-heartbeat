# Aru external-trigger integration

The desire engine is transport-independent. This optional adapter connects a
pending outbound decision to Aru Self-Hosted's encrypted External Trigger bridge.

## Responsibility split

| Component | Responsibility |
| --- | --- |
| Desire engine | evolve drives, thoughts, Solo and pending decisions |
| Aru adapter | build a bounded background event and enforce idempotency |
| Aru Host | accept ciphertext and wake the registered mobile endpoint |
| Aru mobile client | decrypt, select the bound collaborator/conversation and generate the reply |

The server supplies a motivation, not final prose. The phone remains authoritative
for the collaborator, model, memory and target conversation.

## Sender bundle

Export a submit-only sender bundle from Aru. It normally contains:

- schema `aru.wake-bridge.sender-bundle.v2`;
- trigger ID;
- HTTPS submit URL;
- submit-only bearer token;
- 32-byte encryption key.

Store the complete JSON as:

```text
/var/lib/aru-desire-heartbeat/external-trigger.send-credential
```

Required ownership and mode:

```bash
sudo chown aru-desire:aru-desire \
  /var/lib/aru-desire-heartbeat/external-trigger.send-credential
sudo chmod 0600 \
  /var/lib/aru-desire-heartbeat/external-trigger.send-credential
```

Never paste the bundle into an issue or commit it to Git.

## Event contract

The adapter emits `aru.desire-heartbeat.event.v1`. It contains only:

- decision ID, drive, intent and score;
- structured `wantAction`;
- the eight derived drive values;
- up to eight related allowlisted thoughts;
- `userAuthored: false`;
- `purpose: automatic_trigger`.

It does not contain chat history, collaborator ID, conversation ID or a model
prompt copied from the user.

The guidance tells the awakened collaborator that this is an internal background
event, not a new user message. The collaborator should read its own current
conversation and memory, then respond naturally without reciting numeric state.

## Encryption and submission

`delivery/aru-wake-sender.mjs`:

1. validates the sender bundle;
2. serializes the bounded event;
3. seals it with AES-256-GCM and a fresh 12-byte nonce;
4. submits `aru.wake-bridge.sealed-event.v1` to the credential URL;
5. requires a matching event-ID acceptance.

The plaintext desire event is not sent to the public relay.

## Delivery gates

All of these must be true:

- heartbeat `observeOnly === false`;
- heartbeat `deliveryEnabled === true`;
- delivery config `enabled === true`;
- exact-content enable file exists;
- sender bundle exists and passes permission checks;
- one pending non-Solo decision exists;
- fatigue is below the configured gate.

A decision is claimed on disk before network submission. Accepted or uncertain
claims are not automatically retried. Desire is satisfied only after a matching
acceptance response.

## Activation

See `docs/DEPLOYMENT.md`. The activation script can validate a local Host
manifest and, optionally, a public manifest URL supplied through environment
variables. No author-owned hostname is embedded in the public repository.

## Adapting another transport

Keep the engine unchanged and implement a sender with the same boundary:

- accept a structured event, never raw chat;
- authenticate and encrypt in the transport layer;
- return an explicit matching acceptance receipt;
- preserve event IDs for idempotency;
- fail closed on ambiguous results;
- call satisfaction only after confirmed acceptance.