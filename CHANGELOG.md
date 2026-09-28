# Changelog

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
