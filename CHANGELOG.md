# Changelog

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
