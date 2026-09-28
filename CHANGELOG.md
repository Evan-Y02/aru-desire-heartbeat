# Changelog

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
