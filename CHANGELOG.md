# Changelog

## 0.9.22

- Evaluate expression on every ten-minute heartbeat instead of gating new
  decisions behind a randomized 30–120 minute attempt deadline.
- At or above the 78% trigger, allow at most three consecutive autonomous
  silences and require contact on the fourth consecutive eligible heartbeat;
  fatigue or stress may influence a choice but cannot skip its evaluation.
- Reset the silence streak below 78%, retain no minimum contact interval, and
  add no maximum-silence timer; keep legacy scheduler fields only for schema
  and upgrade compatibility.
- Add heartbeat-cadence, fourth-cycle contact, restart, and legacy-deadline
  regression coverage.
- Validate an installed release against the exact version-bound runtime closure
  used by that release instead of applying the target release's newer entry
  list to a genuine legacy installation.
- Pin v0.9.14–v0.9.19 to their verified 31-file closure and v0.9.20 to its
  verified 32-file closure while retaining manifest shape, aggregate digest,
  per-file size and SHA-256, ownership, path, and twin-manifest checks.
- Replace version-only compatibility fixtures with genuine 31-file legacy
  layouts, add v0.9.20 as a supported source, and prove listed-file tampering
  still fails before backup creation or production mutation.
- Preserve all v0.9.20 permission, service-user post-install verification,
  isolated heartbeat, protected-state, timer-ordering, and rollback safeguards.

## 0.9.20

- Force atomic configuration replacements to their declared modes even under
  the root upgrade wrapper's restrictive umask, preventing a migrated
  configuration from becoming unreadable to the `aru-desire` service account.
- Keep the heartbeat timer inactive until an installed-runtime post-install
  verifier has loaded configuration, state, interaction state, and delivery
  settings as the service user and produced a Dashboard snapshot.
- Exercise the real installed heartbeat entry point only against an isolated
  temporary copy with delivery disabled, while proving both protected
  production state files remain byte-identical.
- Fail closed with fixed privacy-safe categories and automatically restore the
  complete old snapshot when any post-install runtime check fails.
- Extend repeated, rollback, root-umask, failure-injection, and source-version
  coverage through v0.9.19, and carry package version 0.9.20 into both
  byte-identical runtime manifests.

## 0.9.19

- Run the complete enabled-production baseline health contract before the
  active-upgrade wrapper quiesces the timer, receiver, or selfhost service.
- Give the nested installer an explicit quiesced-state contract and reuse the
  owner-only, non-sensitive pre-quiesce baseline snapshot instead of requiring
  stopped services to satisfy running-health checks.
- Preserve fail-closed real baseline faults, exact service/gate/marker restore,
  protected state and interaction-state hashes, and automatic rollback at every
  later critical failure stage.
- Add isolated regression coverage for ordering, active and quiesced service
  contracts, real baseline failure before mutation, install rollback, repeated
  execution, and v0.9.14/v0.9.17/v0.9.18 upgrade sources.
- Carry package version 0.9.19 into both generated, byte-identical runtime
  manifests and the guarded active-production installation path.

## 0.9.18

- Accept a genuine enabled v0.9.14–v0.9.16 heartbeat configuration during the
  active-production preflight by supplying the two v0.9.17 attempt-window
  defaults only when those legacy fields are absent.
- Apply the matching in-memory compatibility view to the legacy state field
  `nextAttemptAt`, while keeping the protected production state byte-identical
  throughout the upgrade transaction.
- Continue to fail closed when either attempt-window field exists with an
  invalid type or value, or when any other config or state schema requirement
  is violated.
- Replace the false-old-version test fixture with a genuine legacy shape and
  cover missing-field migration, invalid-type rejection before mutation,
  automatic rollback, repeated execution, and all supported source versions.
- Carry package version 0.9.18 into both generated, byte-identical runtime
  manifests and the guarded active-production installation path.

## 0.9.17

- Add a persisted, restart-stable 30–120 minute proactive-attempt window while
  continuing elapsed-time drive evolution on every ten-minute heartbeat.
- Emit only allowlisted proactive categories and an attempt-opportunity boolean,
  separating a scheduled opportunity, threshold/suppression outcomes,
  eligibility, delivery, timeout, and receiver failure without logging private
  state or message content.
- Add a deterministic 24-hour simulation proving that attempt deadlines keep
  advancing across restart and that an opportunity is distinct from delivery.
- Emit a fixed, non-sensitive `failure_class` for every active-production
  preflight failure instead of reporting only the broad stage.
- Compare systemd units using a narrow canonical form that accepts LF/CRLF,
  a missing final newline, and trailing whitespace-only lines while preserving
  every nonblank line byte-for-byte.
- Fail closed with an exact unit category when commands, paths, parameters,
  permissions, users, environment, sections, or any other effective content
  differs.
- Add isolated regressions for exact matches, harmless EOF differences,
  meaningful drift, privacy-safe output, and zero production mutation on
  preflight failure.
- Carry package version 0.9.17 into both generated, byte-identical runtime
  manifests and the guarded active-production installation path.

## 0.9.16

- Add `upgrade-active-production-once.sh`, a single transactional entry point
  for upgrading an enabled v0.9.14 or v0.9.15 installation without the former
  disable/install/enable gate deadlock.
- Snapshot the current release, independent runtime, both manifests,
  configurations, adapter gate, enable marker, units, service states, and
  rollback metadata before quiescing production.
- Keep state and interaction ledgers byte-identical, restore the exact prior
  gates and systemd state after success, and automatically restore the complete
  old installation after any failed stage.
- Add an explicit snapshot-bound rollback command plus isolated dynamic-loopback
  and simulated-systemd acceptance coverage.

## 0.9.15

- Add the read-only “射精与满足结算” Dashboard module with Chinese labels for
  all four settlement scenarios, latest-settlement time, libido/arousal
  before/after values and deltas, refractory/cooldown state, receipt and
  deduplication status, a newest-first ten-entry history, and an explicit empty
  state.
- Render missing legacy settlement fields as “未知” without inference, and
  expose only an allowlisted structured projection that excludes conversation
  bodies, thoughts, secrets, credentials, tokens, complete private URLs, and raw
  payloads.
- Preserve all four settlement carryovers, deduplication, autonomous delivery,
  feature gates, and production behavior; the added persisted fields record the
  already-computed settlement result for the read-only projection.
- Carry package version 0.9.15 into both generated, byte-identical runtime
  manifests and the guarded installation path.

## 0.9.14

- Remove the pre-quiesce apply-time preflight that allowed an active timer to
  race a separately successful activation preflight.
- Run exactly one complete apply-time preflight after the timer is stopped and
  the heartbeat service is confirmed inactive; an inactive timer remains a
  valid preflight state.
- Pin activation ordering and rollback coverage so any failure restores the
  prior timer state and protected files, removes an attempt-created enable file,
  and cannot leave delivery half-enabled.
- Carry package version 0.9.14 into both generated, byte-identical runtime
  manifests and the guarded installation path.

## 0.9.13

- Minimize autonomous external-trigger events by omitting all drive values,
  decision scores, action details, and thought records.
- Add a root-only, read-only activation preflight with fixed, non-sensitive
  output; exact silent credential identity comparison; and immediate fail-closed
  handling of existing pending decisions.
- Derive the activation source from the invoked checkout, quiesce the timer
  before the final pending check, preserve unrelated feature gates, and restore
  the timer's original enabled/active state if a later confirmed apply fails.

## 0.9.12

- Select the only rollback backup explicitly bound by current deployment
  metadata instead of embedding a previous installation timestamp.
- Fail closed on malformed metadata, a missing target, inconsistent
  release/time/version/manifest relationships, or duplicate exact bindings.
- Add fixed privacy-safe binding error counts and ensure each underlying
  failure increments the aggregate structure error only once.
- Add consecutive-install fixtures proving that historical backup names and
  mtimes never participate in current-backup selection.

## 0.9.11

- Add a root-only, strictly read-only production delta auditor whose output is
  limited to PASS/FAIL/INCONCLUSIVE, fixed error categories, and counts.
- Verify protected file metadata, rollback structure and installation binding,
  feature-gate equality, synthetic-event candidates, duplicate ledgers, and
  post-install journal error counts without printing private values or bodies.
- Keep arbitrary post-install state-change detection explicitly inconclusive
  because v0.9.10 intentionally created no production state snapshot.
- Add isolated fixtures for clean, polluted, duplicate, permission-failure,
  damaged-backup, journal-classification, redaction, and side-effect behavior.

## 0.9.10

- Move installation receive/replay acceptance into a fresh temporary config,
  state directory, ledger, receipt, pending namespace, secret pair, and dynamic
  loopback endpoint; clean the fixture on success and failure.
- Remove every synthetic request and synthetic-ledger assertion against the
  production receiver and production Desire data directory.
- Remove production state filenames and state backup/hash operations from the
  installer. Quiesce writers and make disabled receiver startup return before
  opening or locking state, so installation cannot pollute and later restore it.
- Require the explicit checkout containing the installer at semantic version
  0.9.10, retain `observeOnly=true` and `deliveryEnabled=false`, and preserve the
  prior service identities, activity, permissions, manifests, and release link.
- 安装验收改为完全隔离的临时状态，不再向生产 receiver 注入 synthetic event。

## 0.9.9

- Add mutually exclusive `neutral_discussion`, `flirt_tease`, `direct_desire`,
  `sexual_explicit`, and `concrete_intimate_action` classification with
  combination/context rules instead of single sensitive-word activation.
- Keep libido and Arousal separate: chat libido increments are 0, 0.020, 0.050,
  0.080, and 0.080 with the existing 0.24 hourly cap; immediate Arousal retains
  its action/body/posture/libido formula, 1.0 clamp, and 0.72 passive cap.
- Make `partnered_no_release`, `partnered_release`, `solo_no_release`, and
  `solo_release` reachable from the complete-message receiver with carryovers
  0.80, 0.30, 0.80, and 0.38.
- Give settlement precedence over stimulation; correlate user/assistant
  restatements by a text-free fact fingerprint; support one no-release-to-release
  upgrade; and prevent partnered/Solo double settlement.
- Persist and recover pending settlement receipts idempotently, including at
  receiver startup, without storing message text.
- Feed supported conversation-turn relay completions into the same canonical
  hook used by collaborator-host while preserving the existing stir callback.
- Migrate v0.9.8 interaction state in memory by adding empty settlement fields
  and normalized qualitative event metadata.

## 0.9.8

- Track relationship conflict, task pressure, fatigue burden, and other stress as
  bounded, text-free causes. Apply linked comfort, affirmation, resolution, task
  completion, and rest only to compatible causes; decay open causes naturally;
  and never revive resolved causes.
- Preserve cause identity and event idempotency across process restarts. Migrate
  existing state by adding an empty cause ledger and its time anchor without
  rewriting drives, pending decisions, cooldowns, satisfaction history, thoughts,
  or timeline entries.
- Give disabled-delivery pending decisions a restart-stable fingerprint, suppress
  repeated gate timeline entries, expire them logically after 30 minutes, and
  anchor the 60-minute cooldown to that deadline without pretending that delivery
  or satisfaction occurred.
- Evolve all eight drives toward bounded interior equilibria so long-running
  heartbeats do not mechanically pin them at zero or one.
- Distinguish clean receiver delivery from retry-after-commit duplicates and give
  each installation acceptance a nonce-qualified event identity.
- Derive the complete heartbeat and receiver runtime closure recursively, create
  byte-identical independent and current-release manifests, and verify their exact
  paths, sizes, hashes, semantic version, and aggregate digest before and after
  switching `current`.
- Bind production audit output to the two manifest paths actually verified by the
  formal release-layout checker, including after activation and rollback.
- Strengthen installation rollback so previous runtime files, manifests,
  deployment metadata, configuration, feature flags, units, owner-only secrets,
  persistent interaction state, and service activity are restored or reported as
  individual rollback failures.

## 0.9.7

- Add bounded chat stimulus and independent Arousal state with release-to-drive
  settlement.
- Add the authenticated complete-message hook and loopback receiver for
  persisted user turns and completed assistant finals.
- Add stable event identity, local deduplication, receiver replay deduplication,
  and synthetic end-to-end acceptance checks.
- Harden installation rollback so the previous release, configuration, units,
  owner-only hook secrets, interaction data, and service activity are restored;
  failed rollback steps are reported individually.
- Prevent pairing tokens, hook secrets, and credentials from appearing in
  startup logs, diagnostics, or installer output.
- Keep Solo Sessions disabled by default.

## 0.9.6

- Add autonomous expression choices while retaining disabled-by-default
  deployment gates.
