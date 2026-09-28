# Desire heartbeat — autonomous v2 with lightweight thought formation

This is a local, dependency-free Node.js 22 desire engine for Aru. Every heartbeat
updates eight bounded drives and a persistent thought pool, then may create one of
four outbound intents or one local Solo intent. The engine does not search, browse, start Codex, call a
model, read conversations, or use an MCP. A separate cycle command can submit a
pending intent through Aru's encrypted external-trigger bridge. The committed
configuration and all deployment assets remain disabled by default.

An optional local complete-message interpreter and independent arousal body
state are implemented behind disabled feature gates. They make no model or
API call. The complete-message hook and loopback receiver accept only persisted
user turns and completed assistant finals, authenticate requests with owner-only
secret files, and deduplicate stable event IDs. See `CHAT_AROUSAL_DESIGN.md` and
`COMPLETE_MESSAGE_HOOK_DESIGN.md` for the boundary, private state layout,
installation checks, and rollback behavior.

The optional Solo Session layer separates autonomous selection from preparation,
structured action beats, edge, release/no-release completion, and downstream
settlement. It is also disabled by default. See `SOLO_SESSION_DESIGN.md`.

## 0.9.8

Version 0.9.8 adds restart-safe pending expiry and cooldown, bounded negative
cause tracking, linked comfort and resolution, task completion, rest recovery,
and natural cause decay. Cause records contain only stable event identities,
categories, timestamps, and numeric contributions; raw message text is never
stored in the cause or interaction ledgers.

The release also derives the complete runtime closure recursively and verifies
byte-identical manifests beside the independent heartbeat runtime and inside the
release selected by `current`. Production audits report those exact verified
paths and bind `current` to deployment metadata before accepting a release.
Installation acceptance uses nonce-qualified synthetic events, preserves all six
feature flags, and rolls back the runtime, manifests, metadata, state, units,
secrets, and service activity on failure.

`package.json` is the single authoritative semantic version source. Runtime
metadata and generated manifests derive their version from it. Timestamped Aru
release directory names identify deployment instances only and are never treated
as semantic versions.

## 0.9.7

Version 0.9.7 adds bounded chat stimulus, independent Arousal state and
release-to-drive settlement, plus the authenticated complete-message hook and
loopback receiver. Stable event IDs provide local and receiver-side
deduplication. The installer verifies the synthetic receive/replay path and
restores the previous release, configuration, units, owner-only hook secrets,
interaction data, and service activity on failure while reporting every failed
rollback step. Startup and diagnostic output redact token and secret material.
Solo Sessions remain disabled by default.

## Development setup

The committed `data/` directory is intentionally empty. Initialization is always
explicit and refuses to replace an existing state:

```bash
node bin/desire-heartbeat.mjs init
```

This creates `data/state.json` as mode `0600`; `data/` must be a real, owner-owned
`0700` directory. A corrupt, insecure, or symbolic-link state is rejected rather
than repaired or overwritten.

Read the redacted status without changing it:

```bash
node bin/desire-heartbeat.mjs status
```

Run one real-time state heartbeat manually:

```bash
node bin/desire-heartbeat.mjs tick
```

Before enabling a previously paused installation, `rebase-clock` moves only the
heartbeat time anchor to now. It refuses pending decisions and preserves all eight
drives, thoughts, timeline entries, satisfaction records, and relationship state:

```bash
node bin/desire-heartbeat.mjs rebase-clock
```

Manage one drive with user-facing percentages. `set-drive` assigns an exact
`0–100` value; `adjust-drive` adds or subtracts a non-zero amount and clamps the
result to that range:

```bash
node bin/desire-heartbeat.mjs set-drive --drive attachment --value 65
node bin/desire-heartbeat.mjs adjust-drive --drive attachment --delta -15
```

Both commands take the existing exclusive lock and atomically save only the
requested drive. They refuse to run while a decision is pending, so an already
formed outbound event cannot silently change underneath delivery. Raising a value
does not send a message immediately; it only changes what a later heartbeat can
consider. These commands call no model or MCP and consume no model tokens.

Add a bounded internal stimulus or a thought. Arguments are parsed as data and
are never assembled into a shell command:

```bash
node bin/desire-heartbeat.mjs feed --drive curiosity --amount 0.20
node bin/desire-heartbeat.mjs thought-add --drive attachment --type flit --intensity 0.55 --text "想靠近月"
```

Ask the sentinel to choose without applying elapsed-time growth:

```bash
node bin/desire-heartbeat.mjs decide
```

Complete a pending decision only with its exact ID:

```bash
node bin/desire-heartbeat.mjs satisfy --decision-id decision-EXACT-ID
```

This reduces the associated drive, records satisfaction time, and clears the
pending decision. It never claims that a message was delivered.

Run a deterministic simulation from the current persisted state. Both modes use
a memory clone and never write state or contact Aru. `simulate-autonomy` assumes
each simulated contact succeeds so growth can continue across many days:

```bash
node bin/desire-heartbeat.mjs simulate --ticks 48
node bin/desire-heartbeat.mjs simulate-autonomy --ticks 1008
```

Every command also accepts `--config ABSOLUTE_OR_RELATIVE_PATH` and `--data-dir
PATH`. A state-changing command uses an exclusive `heartbeat.lock`; the lock and
state are mode `0600`.

## Behavior

Drives are `attachment`, `curiosity`, `reflection`, `duty`, `social`, `fatigue`,
`libido`, and `stress`. Duty and fatigue remain internal state. The actionable drives map to
`reach_owner`, `seek_closeness`, `share`, or `confide`; libido may instead choose
the local `solo` outlet. Below threshold means no action. The names are motivations, not generated messages or commands.

Each drive has its own base growth rate. A small bounded, reproducible self-drive
variation changes the rate at each heartbeat, so contact timing emerges from state
rather than a fixed message schedule. At 55%, a drive creates one allowlisted
automatic flit. Continued drive growth reinforces that same thought without
duplicates; at 80% it becomes a fixation. If the drive falls, the thought decays,
and successful expression or Solo proportionally weakens it. Thoughts observe
drive state but never add value back into a drive, preventing a self-amplifying
loop. Manual thoughts remain supported and are explicitly marked. The sentinel
checks clock safety, one-pending-intent deduplication, fatigue, threshold,
observe-only state, and explicit delivery flags.

At 78%, the strongest actionable drive enters a deterministic local expression
choice: it may contact, choose Solo when libido is eligible, or remain silent.
Silence is a real autonomous choice and does not satisfy or lower any drive. It
may happen at most three eligible times in a row; the fourth eligible cycle must
contact the owner. A drive at 100% must also contact immediately. These are
upper safety bounds, not a schedule and not a rule that forces three silences.

For libido, the local state machine chooses exactly one of two outlets:
`seek_closeness` wakes Aru to contact the wife, while `solo` uses the existing
local completion path when the optional Solo Session gate is disabled. With that
gate enabled, selection instead creates a pending private Session and waits for
one authorized autonomous-check model final; it never adds a per-message model
call. The Session adapter validates structured action beats before applying them
to Arousal. A valid Solo release retains 38% of libido and starts the existing
three-hour Solo cooldown. Contact retains 70% of libido. The deterministic
choice is influenced by libido versus attachment, fatigue, and the previous
outlet. Solo remains optional on ordinary eligible cycles, but cannot replace
the mandatory owner contact at 100% or after three consecutive autonomous
silences.

There are no fixed quiet hours, daily message quota, minimum interval, maximum
interval, or fixed cooldown. A successful submission lowers the triggering drive
and softly lowers the other outbound drives, which prevents an immediate cluster
without turning desire into a schedule. Current disabled defaults were calibrated
by offline simulation across several 30-day start times: first contact about
110–130 minutes, around 13.8 expressed contacts per day, and a 90-minute median
follow-up gap. These are observations rather than quotas or time promises; rare
shorter and longer gaps remain possible.

## Read-only private dashboard

The optional dashboard presents the eight drives, strongest current tendency,
thought summaries with natural/manual provenance, pending intent, heartbeat
recency, Solo count/cooldown, the consecutive-silence counter, and a bounded
decision timeline in a mobile-first page. Ordinary below-threshold heartbeats do
not add timeline noise. Every threshold-eligible wake records a more concrete,
locally derived inner-state explanation without calling a model or copying chat. Solo completion appears as
“自己处理了”. Each cycle records only allowlisted outcomes, reasons, intent
metadata, and a snapshot of the eight derived values; it never copies raw
conversation text into the timeline. The newest 72 entries are retained and the
dashboard shows the newest 10.

It binds only to `127.0.0.1:18760`, exposes only allowlisted GET/HEAD routes, sets
strict no-cache and browser security headers, and never writes state. Untrusted
thought text is inserted with `textContent`, never interpreted as markup.

```bash
python3 -I dashboard/server.py
```

The included service unit adds a read-only filesystem boundary around the state
directory. The application intentionally implements no public authentication;
HTTPS and authentication must be applied by the reverse proxy before exposure.
The visible management button remains disabled in this version. Reading or
refreshing the page calls no model or MCP and consumes no model tokens.

## Prepared autonomous cycle

`bin/desire-cycle.mjs` performs one bounded cycle: advance state, persist any
pending intent, and—only when every explicit gate is enabled—submit it through
Aru's external-trigger path. The prepared ten-minute timer invokes this command.
`bin/desire-deliver.mjs` remains available for controlled recovery or diagnostics.

The adapter turns one pending desire decision into a bounded
`xinchao.desire-external-event.v1` background event. The event explicitly says
that it is not user-authored and carries the triggering drive, score,
`wantAction`, all drive values, and up to eight related thoughts. Aru is expected
to route it as an automatic trigger into the latest conversation, where the
collaborator reads Aru memory and decides how to respond.

Delivery requires every gate at once: heartbeat observation must be disabled,
both delivery flags must be enabled, an exact-content enable file must exist, and
an owner-only external-trigger send credential must exist. Every decision is
claimed before submission; accepted or uncertain claims are never retried
automatically.

The sender follows Aru Host v0.30.2's official `wake-send.mjs` protocol:
`aru.wake-bridge.payload.v2` plaintext is sealed with AES-256-GCM using a fresh
12-byte nonce, then submitted inside `aru.wake-bridge.sealed-event.v1` with the
bundle's submit-only bearer token. Submission uses Node's native HTTPS client,
not Fetch/Undici, so it remains compatible with the service's `--jitless` boundary. Desire event JSON is carried as background
`content`; no collaborator or conversation identifier is supplied by the VPS.
The default configuration cannot deliver.

## Drive dynamics

All eight drives have a true zero lower bound and no hidden floor. They evolve
toward bounded interior equilibria determined by configured growth, home levels,
and return rates. Negative external events add separately tracked contributions
to `reflection`, `duty`, `fatigue`, and `stress`; linked recovery or natural
decay removes only those contributions. A successful expression lowers the
selected drive proportionally rather than resetting it, retaining continuity and
aftertone. The engine remains deterministic and makes no model or conversation
call.

On narrow screens the eight drive cards use a compact two-column, four-row grid
so the timeline begins immediately after the complete snapshot.

## Tests

```bash
node --test
```

Tests use temporary directories and mock HTTP responses only. They do not touch
Aru data, credentials, services, or conversations.

## Prepared systemd assets

`systemd/` and `scripts/` are deployment material only; nothing is installed by
this project build. The timer runs a oneshot service rather than a resident loop.
The installer requires a pre-created low-privilege `aru-desire` account, installs
atomically, retains attempt backups, and does not initialize state automatically.
The complete-message-hook installer derives the recursive runtime closure, writes
`/opt/aru-desire-heartbeat/release-manifest.json` with one size and SHA-256 entry
per closure file, copies the identical manifest into the staged Aru release, and
checks both copies against the exact file set and hashes before and after the
`current` switch. Atomic deployment metadata records the expected release,
previous release, rollback root, and installation boundary for later audits. A
missing manifest, expected-release mismatch, omitted dependency, or mixed file
aborts the install and invokes the exact rollback path.
The semantic version in both manifests is always read from `package.json`; the
timestamp in the staged Aru release directory is only a deployment identifier.
The timer waits five minutes from activation before its first cycle and does not
catch up missed runs. The oneshot runs Node with `--jitless` so the service can
retain `MemoryDenyWriteExecute=yes`.

An existing disabled installation can be replaced with
`scripts/upgrade-once.sh --apply`. The upgrader refuses to continue unless both
the timer and service are inactive, keeps persistent state and credentials in
place, atomically updates the disabled systemd units, verifies state, credentials,
and unit files, and prints the exact backup-specific rollback command. It never
enables the timer or delivery.

After the upgraded source and installed versions match,
`scripts/enable-autonomy-once.sh --apply` validates the private sender credential
without printing it, verifies both Aru Host manifests, backs up configuration and
state, rebases the heartbeat clock without growth, opens all three delivery gates,
and enables the timer. Any failure returns the system to disabled state.
`scripts/disable-autonomy-once.sh --apply` stops future cycles and closes delivery
while preserving evolved state. The enable command also prints an exact rollback
command that restores the pre-activation state.

A narrowly scoped `scripts/recover-stalled-delivery-once.sh --apply` handles the
specific case where a local pre-network crash left both a dead-process lock and
an unsubmitted claim. It requires the timer to be disabled, validates the pending
decision and matching claim, backs up all recovery evidence, submits exactly once,
settles the timeline and proportional satisfaction, and leaves the timer disabled.
Any ambiguous retry failure remains closed for manual inspection.

## Committed safety defaults

- heartbeat observation and both delivery flags are committed as false;
- chat stimulus, arousal, and arousal-to-libido settlement are committed as false;
- generated Solo Sessions are committed as false;
- activation always requires the explicit root-only enable script;
- the exact-content enable file is created only during confirmed activation;
- the core runtime still contains no browsing, MCP, model, or Codex invocation;
- the timer and delivery remain off after installation or upgrade.

## Disabled-delivery pending lifecycle

A decision blocked by observe-only or a disabled sender waits durably for at
most 30 minutes. Its persisted SHA-256 fingerprint is derived only from the
decision ID, drive, intent, and creation time; it contains no message content or
credential material. Repeated heartbeats with the same fingerprint, outcome,
and blockers do not append duplicate timeline entries, including after a
restart. A changed blocker or lifecycle outcome is recorded once.

When the wait expires, the decision is cleared without satisfaction, delivery,
or any artificial drive reduction. Expiry is logically effective at the persisted
30-minute deadline; the next scheduled heartbeat may observe and record it later.
The 60-minute cooldown is anchored to that deadline rather than the observation
time, so scheduler jitter cannot extend it. After it ends, the current drives are
evaluated afresh. Decisions whose delivery was attempted remain fail-closed and
do not use this expiry path.

Drive evolution uses bounded exponential movement toward an internal
equilibrium. Every drive has a positive return rate and a non-extreme home
level, so long idle periods approach an interior value instead of mechanically
pinning four drives to 100% and four to 0%.

See `ARU_INTEGRATION.md` for the source-backed integration boundary.
