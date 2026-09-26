# Solo Session design

## Disabled runtime boundary

`soloSessionsEnabled` is committed as `false`. With the gate off, the existing
local Solo behavior is unchanged. With it on, a heartbeat that chooses Solo
persists `solo_selected` and leaves the desire decision pending; selection is not
completion and does not imply release.

The current heartbeat and autonomous choice code do not call a model. Therefore
this change does not start one. `src/solo-session.mjs` supplies a generation
request contract and final-output validator for a future authorized Aru
autonomous collaborator turn. That one turn should receive the allowlisted drive
snapshot, a qualitative arousal phase, a small in-memory conversation window,
selected memory results, and the output schema. The conversation and memory
material are not copied into Session state.

## State flow

```text
selected -> preparing -> active -> edge -> preparing -> active
                              |                    |
                              +-> completed_no_release
                              +-> completed_release
                              +-> aborted
completed_* / aborted -> settled
```

Only a completed final model envelope with a valid `run_id`, narrative fields,
and structured action beats can enter `active`. Each beat has a stable step ID,
action, body category, intensity, rhythm, duration class, posture, continuous
contact flag, and release-intent flag. No sleep is used; bounded virtual beat
times drive deterministic Arousal updates.

Invalid, streamed, interrupted, duplicated, or conflicting generation fails
closed. It cannot reduce libido, consume reserve, extend refractory state, or
create a release receipt. Session, run, step, event, and effect replay boundaries
are independently idempotent.

## Settlement

- partnered intimacy without release: libido carryover `0.80`, no receipt and no
  reserve cost;
- partnered release: receipt cause `partnered`, libido carryover `0.30`;
- Solo without release: libido carryover `0.80`, no receipt and no reserve cost;
- Solo release: receipt cause `solo`, libido carryover `0.38`, three-hour Solo
  cooldown, output multiplier `0.80`, reserve-cost multiplier `0.80`;
- Solo climax quality uses the actual buildup result and is not multiplied.

Receipt cause selects exactly one carryover branch. A Solo receipt cannot also
take the partnered 0.30 branch. Existing attachment and relationship thoughts
are not settled or cleared by Solo.

## Private storage and dashboard

Session records live under `soloSessions` in owner-only
`data/interaction-state.json`. Recent conversation text and memory retrieval
material remain request-only. Persisted records contain generated qualitative
text and validated summaries, not source transcript, credentials, control
material, or replay ledgers.

The existing authenticated dashboard snapshot can include an allowlisted latest
Solo view only when `soloSessionsEnabled=true`. The frontend card is absent when
the flag is off. It uses the existing loopback server, login session, and port;
no public route, new listener, or weaker authentication is introduced.
