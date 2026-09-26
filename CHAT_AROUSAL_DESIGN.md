# Local chat stimulus and arousal design

## Boundary and wiring status

The current repository has one outbound Aru integration: the encrypted
external-trigger sender. It has no supported inbound callback for a durably
stored user message or a completed assistant final. No Host credential,
conversation store, stream, or private runtime state is inspected to manufacture
one.

`src/interaction-runtime.mjs` is the formal inbound adapter boundary. A future
supported Aru hook must call `processPersistedMessage` only after committing a
complete turn and provide:

- a stable source, conversation ID, and provider message ID;
- role `user` or `assistant`;
- `status: "complete"` and `persisted: true`;
- `final: true` for assistant turns;
- a completion timestamp and the complete in-memory content.

Streaming chunks, thinking, tool states, cancellations, and incomplete assistant
turns are rejected. The adapter hashes message identity into a stable event ID.
Raw content is used only during the call and is absent from every returned or
persistent record.

## Modules and state

- `src/chat-stimulus.mjs` performs deterministic context filtering, event
  classification, bounded drive changes, decay, replay protection, qualitative
  flits, and a bounded ambiguous-event queue.
- `src/arousal.mjs` owns the independent physical state, stimulus mechanics,
  release gate, reserve, refractory interval, receipt creation, and the strict
  nine-field public projection.
- `src/interaction-storage.mjs` provides owner-only atomic persistence at
  `data/interaction-state.json`.

The existing `data/state.json` remains the Desire-Heartbeat state. Optional
`appliedChatEventIds` and `appliedEffectIds` ledgers are created in it only after
the corresponding enabled feature actually applies an event. They make a replay
safe if the desire state was saved before the separate interaction state.

## Migration and activation

Existing version-2 configuration files are normalized in memory with all four
new gates disabled. Existing desire state needs no rewrite. Interaction state is
created explicitly only when a supported inbound hook is available and the
feature is intentionally activated; initialization refuses to overwrite an
existing file.

The committed defaults are:

```text
chatStimulusEnabled=false
arousalEnabled=false
arousalDriveSettlementEnabled=false
soloSessionsEnabled=false
```

The confirmed partnered carryovers are 0.80 without release and 0.30 after a
valid partnered release. Solo retains 0.38 after release, with output and reserve
cost multipliers of 0.80 and the existing three-hour cooldown. Settlement remains
inert while its feature gate is off.

Activation still requires a supported complete-message hook, an authorized Solo
generation turn, explicit private-state initialization, and deliberate gate
changes. None of these actions is performed by this change.
