# Release inventory

## 0.9.23

Version 0.9.23 restores direct elapsed-time accumulation for the four
self-driven positive needs: attachment, curiosity, social need, and libido.
Their configured hourly growth again has the v0.9.5 meaning, including bounded
deterministic heartbeat variation and the 0..1 clamp. Reflection, duty, fatigue,
and stress have no baseline: conversation or external events raise them, while
elapsed time only decays them toward 0%.

This keeps conversation stimulus, negative-event recovery, proportional
satisfaction, the 78% trigger, every-ten-minute evaluation, and the rule that
three consecutive voluntary silences require contact on the fourth eligible
heartbeat. Reaching 100% may still force contact sooner.

The state and configuration schemas remain unchanged. Active-upgrade preflight
now accepts v0.9.22 as a verified 32-file source in addition to the prior
supported versions, without weakening manifest, ownership, permission,
production-state, post-install, or rollback checks.

The v0.9.23 behavior and compatibility inventory is:

- `src/engine.mjs`
- `test/desire-heartbeat.test.mjs`
- `test/expression-autonomy.test.mjs`
- `test/runtime.test.mjs`
- `scripts/active-production-upgrade-preflight.mjs`
- `scripts/upgrade-active-production-once.sh`
- `scripts/install-complete-message-hook-once.sh`
- `test/active-production-upgrade.test.mjs`
- `test/formal-release-layout.test.mjs`
- `test/turn-hook-install.test.mjs`

## 0.9.22

Version 0.9.22 evaluates expression on every ten-minute heartbeat. At or above
78%, the engine may remain silent on three consecutive eligible heartbeats and
must form a contact decision on the fourth. Fatigue and stress may influence
those choices but cannot skip an eligible evaluation or block the fourth.
Falling below 78% resets the streak. No minimum contact interval or
maximum-silence timer is added. The legacy
attempt-window fields remain accepted for compatibility, while nextAttemptAt
records the next heartbeat and no longer gates decision entry.

The same release repairs the cross-version formal-layout check exposed by the
first real v0.9.14-to-v0.9.20 upgrade attempt. The prior compatibility fixture
changed a package version on the new 32-file runtime, so it failed to model the
31-file closure actually installed by v0.9.14 through v0.9.19.

Active preflight now binds each supported installed version to its verified
historical path set. It continues to require byte-identical canonical
manifests, valid manifest structure and aggregate digest, exact allowed paths,
per-file size and SHA-256, package-version agreement, safe ownership and modes,
deployment-metadata binding, and the expected current release. v0.9.20's
32-file closure is also accepted as an upgrade source.

Regression fixtures omit the post-install verifier from genuine legacy layouts,
cover v0.9.14, v0.9.17, v0.9.18, v0.9.19, and v0.9.20 sources, and prove a
listed runtime hash mismatch fails before backup creation or production
mutation. The target runtime remains a 32-file closure; all v0.9.20
post-install verification and automatic rollback controls are preserved.

The v0.9.22 behavior and compatibility inventory is:

- `src/engine.mjs`
- `test/expression-autonomy.test.mjs`
- `test/desire-heartbeat.test.mjs`
- `test/runtime.test.mjs`
- `scripts/active-production-upgrade-preflight.mjs`
- `scripts/formal-release-layout.mjs`
- `scripts/runtime-release-manifest.mjs`
- `scripts/upgrade-active-production-once.sh`
- `scripts/install-complete-message-hook-once.sh`
- `test/active-production-upgrade.test.mjs`
- `test/formal-release-layout.test.mjs`

## 0.9.20

Version 0.9.20 repairs the root-umask permission regression exposed by the
v0.9.19 active-production transaction. The atomic JSON writer now explicitly
sets the requested mode after creating each temporary file, so replacement of
the root-owned heartbeat configuration cannot silently change mode 0644 to
0600 and make it unreadable to the service account.

The transaction does not restore or start the heartbeat timer immediately
after installation. It first runs a privacy-safe verifier as `aru-desire`
against the installed release. The verifier loads heartbeat configuration,
protected state, interaction state, and delivery configuration; exercises the
Dashboard projection; and invokes the real cycle entry point against isolated
temporary copies with both delivery gates closed. It proves the production
state and interaction-state hashes are unchanged before allowing exact timer
restoration. Any failed check triggers the existing snapshot-bound automatic
rollback.

Isolated coverage includes root-style umask behavior, successful and repeated
execution, every critical rollback stage, five post-install failure classes,
and source compatibility for v0.9.14, v0.9.17, v0.9.18, and v0.9.19. Both
generated manifests derive version 0.9.20 from `package.json`, cover the same
32-file runtime closure, and must remain byte-identical. No generated
production manifest is committed, and v0.9.19 and every older tag remain
immutable.

The v0.9.20 upgrade and rollback inventory is:

- `scripts/upgrade-active-production-once.sh`
- `scripts/rollback-active-production-upgrade.sh`
- `scripts/install-complete-message-hook-once.sh`
- `scripts/active-production-upgrade-preflight.mjs`
- `scripts/active-production-upgrade-gates.mjs`
- `scripts/active-production-postinstall-verify.mjs`
- `scripts/verify-runtime-release.mjs`
- `test/active-production-upgrade.test.mjs`

## 0.9.19

Version 0.9.19 repairs the deterministic ordering conflict found during the
v0.9.18 active-production transaction: the wrapper had already quiesced the
selfhost service before the nested installer attempted its running baseline
diagnostics. The new transaction completes the full running baseline before
backup creation or service quiesce and records only bounded, non-sensitive
comparison facts in its mode-0600 temporary preflight directory.

After quiesce, the nested installer enforces a separate explicit contract: the
enabled timer is inactive, heartbeat/receiver/selfhost are inactive, and the
dashboard remains active. It consumes the pre-quiesce baseline rather than
contacting a stopped service. No health check is deleted or hard-coded; genuine
baseline failure still stops before mutation. The existing backup, gate and
marker preservation, exact service restoration, protected state hashes, inner
rollback, and outer automatic rollback remain in force.

Isolated coverage proves the active ordering, the quiesced contract, fail-closed
baseline faults, install-stage rollback, byte preservation of state and
interaction-state, repeated execution, critical failure injection, and
v0.9.14/v0.9.17/v0.9.18 source compatibility. Both generated manifests derive
version 0.9.19 from `package.json`, cover the same 31-file runtime closure, and
must remain byte-identical. No generated production manifest is committed, and
v0.9.18 and every older tag remain immutable.

The v0.9.19 upgrade and rollback inventory is:

- `scripts/upgrade-active-production-once.sh`
- `scripts/rollback-active-production-upgrade.sh`
- `scripts/install-complete-message-hook-once.sh`
- `scripts/active-production-upgrade-preflight.mjs`
- `scripts/active-production-upgrade-gates.mjs`
- `test/active-production-upgrade.test.mjs`

## 0.9.18

Version 0.9.18 repairs the active-production compatibility boundary exposed by
a real v0.9.14 installation. The former fixture changed only the package version
on a current config, so it did not model the absence of the two attempt-window
fields introduced in v0.9.17. The preflight consequently rejected a legal old
config as `heartbeat_config_schema` before any production mutation.

The fixed preflight uses the installed, manifest-bound source version to add
only absent `attemptWindowMinSeconds`, `attemptWindowMaxSeconds`, and
`nextAttemptAt` fields to an in-memory validation view for v0.9.14–v0.9.16.
Existing invalid values and every unrelated schema violation still fail closed.
The transactional installer replaces the old runtime config with the complete
v0.9.18 config while preserving all six production gates, and protected state
remains byte-identical.

Regression coverage now uses the actual legacy shape and verifies successful
missing-field migration, rejection of a present wrong type before backup or
quiescence, automatic restoration at every critical failure stage, repeat-safe
execution, and v0.9.14 through v0.9.17 source compatibility.

The two generated runtime manifests both derive version 0.9.18 from
`package.json`, contain the same recursive runtime closure, and must remain
byte-identical. No generated production manifest is committed. The v0.9.17 tag
and every earlier tag remain immutable.

## 0.9.17

Version 0.9.17 preserves the v0.9.16 active-production transaction and adds
fixed privacy-safe classifications to every preflight failure path. Systemd
unit comparison now accepts only LF/CRLF form, a missing final newline, and
trailing whitespace-only lines. All nonblank lines stay byte-exact, so changed
commands, paths, parameters, permissions, users, environment, sections, or any
other effective content still fails closed with the affected unit category.
Regression fixtures cover exact equality, each accepted EOF variation,
meaningful content and `ExecStart` drift, private-output exclusion, and zero
production mutation before backup or service quiesce.

The candidate also adds the previously absent persisted 30–120 minute proactive
attempt window. Every heartbeat continues elapsed-time evolution, while only a
due deadline enters new-decision formation. Each due evaluation advances and
persists the next deadline, including across restart. Cycle output contains only
the fixed proactive category vocabulary and an opportunity boolean, keeping
opportunity, eligibility, and successful delivery distinct. A deterministic
24-hour regression proves that deadlines neither freeze nor repeat one fixed
interval.

The two generated runtime manifests both derive version 0.9.17 from
`package.json`, contain the same recursive runtime closure, and must remain
byte-identical. No generated production manifest is committed.

The v0.9.16 tag and every earlier tag remain immutable. Production remains on
its separately installed version until v0.9.17 is explicitly installed.

## 0.9.16

Version 0.9.16 adds the formal active-production upgrade transaction. The new
entry point accepts installed v0.9.14 and v0.9.15 layouts only, requires a fully
enabled and internally consistent baseline with no pending decision, writes a
complete root-only rollback snapshot before production mutation, and quiesces
only after that snapshot is complete. It temporarily closes the two outer gates
without changing the adapter gate or persistent state, runs the guarded runtime,
Dashboard, and hook installer, verifies both runtime manifests, and restores the
exact pre-upgrade gates, enable marker, timer, and service states.

`rollback-active-production-upgrade.sh` is bound to the exact snapshot printed
by a successful upgrade. It refuses explicit rollback after protected state has
evolved, so rollback cannot silently discard newer state, ledger, timeline,
pending, or receipt data.

The v0.9.16 release inventory adds:

- `scripts/upgrade-active-production-once.sh`
- `scripts/rollback-active-production-upgrade.sh`
- `scripts/active-production-upgrade-preflight.mjs`
- `scripts/active-production-upgrade-gates.mjs`
- `test/active-production-upgrade.test.mjs`

## 0.9.15

The v0.9.15 release adds a read-only “射精与满足结算” Dashboard module. Its
allowlisted projection presents Chinese names for the four settlement scenarios,
the latest settlement time, libido and arousal before/after values and deltas,
refractory and cooldown state, receipt and deduplication status, and at most ten
newest-first historical records. It provides an explicit empty-state message and
renders absent legacy values as “未知” without inference or fabrication.

Conversation bodies, thoughts, secrets, credentials, tokens, complete private
URLs, and raw payloads remain outside the projection. The four settlement
carryovers, deduplication rules, autonomous sending, feature gates, and
production behavior are unchanged. The two generated runtime manifests derive
version 0.9.15 from `package.json` and are required to be byte-identical.

The v0.9.14 tag and every earlier tag remain immutable. Production remains on
its separately installed version until v0.9.15 is explicitly installed.

## 0.9.14

The v0.9.14 release fixes the remaining apply-time activation race. A confirmed
apply records the timer's original state and installs automatic failure recovery
before quiescing it, then runs exactly one complete privacy-safe preflight while
the timer is inactive and the heartbeat service is stopped. That controlled
inactive timer state is valid, so the internal preflight remains effective after
quiesce instead of depending on the timer's original activity.

No delivery gate changes before the quiesced preflight and pending-decision
checks pass. Later failures restore changed configuration and state, remove an
enable file created by the attempt, close delivery, and restore the timer's
original enabled/active state. The two generated runtime manifests both derive
version 0.9.14 from `package.json` and are required to be byte-identical.

The v0.9.13 tag and every earlier tag remain immutable. Production remains on
its separately installed version until v0.9.14 is explicitly installed.

## 0.9.13

The v0.9.13 candidate minimizes the external-trigger payload and adds a
privacy-safe, root-only, read-only activation preflight. The preflight compares
the installed and provisioning sender identities without disclosure, returns
before credential access when a pending decision exists, and emits only fixed
statuses and category counts. Activation preserves unrelated feature gates and
cannot race an active timer through its final pending-decision check.

The v0.9.12 tag and all earlier tags remain immutable. Production remains on
its separately installed version until this candidate is reviewed, published,
and explicitly installed.

## 0.9.12

The v0.9.12 source removes the v0.9.11 auditor's installation-specific backup
constants. The current deployment metadata is the sole authority for backup
selection, with bidirectional timestamp, release, package-version, metadata,
manifest, and uniqueness validation. Multiple historical backups and their
mtimes cannot affect selection.

The v0.9.11 tag and all earlier tags remain immutable. Runtime behavior is
unchanged except for the package semantic version carried by generated
manifests; this release changes only audit selection, reporting, fixtures, and
release documentation.

## 0.9.11

The v0.9.11 source adds a privacy-safe, root-only, read-only delta auditor and
isolated regression fixtures. The auditor never prints protected contents,
identifiers, hashes, configuration values, URLs, credentials, or journal text;
it emits only fixed result labels, PASS/FAIL/INCONCLUSIVE, and counts.

The v0.9.10 tag and commit remain immutable. The heartbeat and receiver runtime
behavior is unchanged except for the package semantic version carried by the
formal runtime manifest.

## 0.9.10

The v0.9.10 source release contains the same 31-file recursive heartbeat and
receiver runtime closure as v0.9.9 plus installation-only isolation and
regression assets. Both generated manifests remain byte-identical and derive
their semantic version, file sizes, hashes, and aggregate digest from the
explicit 0.9.10 source checkout.

Installation acceptance uses only a freshly created temporary state tree and a
dynamic loopback receiver. Production state is never opened by that acceptance
script or by the installer: production state filenames are absent from the
installer and disabled receiver startup returns before opening or locking its
data directory. Temporary fixtures are removed on success, injected failure,
signal, or normal error.

安装验收改为完全隔离的临时状态，不再向生产 receiver 注入 synthetic event。

Integration-only Aru release files outside the recursive heartbeat closure are
unchanged:

- `aru-desire-turn-hook.mjs`
- `aru-desire-relay-turn.mjs`
- `synthetic-check.mjs`
- patched `server.mjs`
- patched `conversation-turn-relay.mjs`

No generated production manifest or state file is committed. The v0.9.9 tag,
commit, and every older release remain immutable.

## 0.9.9

The source release contains the heartbeat/receiver runtime, the collaborator
hook, the conversation-turn relay adapter and patcher, systemd templates,
dashboard, documentation, installers, rollback tools, and isolated tests.

Runtime closure is derived by `scripts/verify-runtime-release.mjs`. The exact
file list, sizes, SHA-256 values, semantic version, and aggregate digest are
generated by `scripts/runtime-release-manifest.mjs`. Installation writes the
same generated bytes to the independent heartbeat root and the selected Aru
release; `scripts/formal-release-layout.mjs` verifies both copies.

Integration-only Aru release files outside that recursive heartbeat closure:

- `aru-desire-turn-hook.mjs`
- `aru-desire-relay-turn.mjs`
- `synthetic-check.mjs`
- patched `server.mjs`
- patched `conversation-turn-relay.mjs`

No generated production manifest is committed because its target is the exact
isolated installation payload. Tests create and compare both manifests before
any production installation is permitted.

The v0.9.8 tag and release history remain immutable.
