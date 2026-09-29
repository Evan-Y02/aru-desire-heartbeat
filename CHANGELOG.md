# Changelog

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
