# Local chat stimulus and arousal design

## Boundary and wiring status

The complete-message hook is wired to completed collaborator-host turns and to
supported completed conversation-turn relay responses. Both sources produce the
same canonical schema and reach the same loopback receiver. The relay adapter
uses only the in-memory provider request and the already-durable final response;
it never adds conversation text to relay state or diagnostics.

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
- Sexual classification is mutually exclusive: `neutral_discussion`,
  `flirt_tease`, `direct_desire`, `sexual_explicit`, or
  `concrete_intimate_action`. Combination rules require directed participants
  and context; isolated sensitive words are insufficient.
- Completed settlement facts have priority and are mutually exclusive:
  `partnered_no_release`, `partnered_release`, `solo_no_release`, or
  `solo_release`. A stable text-free fact fingerprint links the user event and
  its assistant restatement.
- Negative effects are represented in the existing desire state as bounded,
  text-free cause records containing only a stable event-derived ID, kind,
  timestamps, initial and remaining contribution, and status. Heartbeats decay
  open contributions; resolved contributions remain zero and are never reapplied.
- `src/arousal.mjs` owns the independent physical state, stimulus mechanics,
  release gate, reserve, refractory interval, receipt creation, and the strict
  nine-field public projection.
- `src/interaction-storage.mjs` provides owner-only atomic persistence at
  `data/interaction-state.json`.

The existing `data/state.json` remains the Desire-Heartbeat state. Optional
`appliedChatEventIds` and `appliedEffectIds` ledgers are created in it only after
the corresponding enabled feature actually applies an event. They make a replay
safe if the desire state was saved before the separate interaction state.

Recovery targets one compatible cause. Explicit IDs and stable parent-message
links take priority. Without a link, reassurance/comfort may reduce only the
newest relationship or other-stress cause, affirmation only the newest
relationship cause, and resolution/task/rest only the newest cause of the
matching kind. Unlinked recovery is fractional and cannot close a cause.
Recovery never changes pending decisions, satisfaction timestamps, cooldowns,
delivery gates, or timeline outcomes.

## Migration and activation

Existing version-2 configuration files are normalized in memory with all four
new gates disabled. Existing desire state is normalized in memory with an empty
cause ledger and a decay clock copied from its last heartbeat when those fields
are absent. Interaction state is created explicitly only when a supported inbound
hook is available and the feature is intentionally activated; initialization
refuses to overwrite an existing file. A v0.9.8 interaction state gains empty
`settlementFacts` and `pendingSettlementReceipt` fields in memory, while its
existing event ledgers and body state remain unchanged.

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

Classified Solo completion does not require the optional generated Solo Session
layer. It reports an already-completed event through the same protected receiver
receipt boundary. Installation and gate changes remain deliberate; building
this release performs neither.

## Installation acceptance isolation

The installation acceptance path and installer never read or copy production
Desire or interaction state. A new temporary fixture receives every config,
state, ledger, receipt, pending, secret, and loopback receiver path, verifies one
receive/replay sequence, and is removed on success or failure. Production state
filenames are absent from the installer, and disabled receiver startup returns
before acquiring a production state lock or opening a state file.

安装验收改为完全隔离的临时状态，不再向生产 receiver 注入 synthetic event。
