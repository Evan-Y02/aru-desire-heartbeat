# Complete-message hook deployment

The installed Aru and Desire services run as different system users. A Unix
socket with a `0700` parent and `0600` socket cannot be shared by those users,
so the production design uses HTTP bound only to `127.0.0.1:18761`. Two
owner-only copies of one generated local secret are installed, one readable by
each service. The value is never placed in a unit, command line, event, log, or
diagnostic response.

`aru-desire-turn-hook.mjs` wraps the collaborator-host post-save
`onTurnSettled` callback. The supported conversation-turn relay also emits an
in-memory completed-turn record after its response has been durably renamed;
its existing qualitative stir callback remains unchanged. Both paths deliver
the canonical user event followed by the canonical assistant final.
It performs at most one bounded retry, uses a bounded configurable attempt
timeout (250 ms in the production unit), and never throws into the conversation
path. Diagnostics contain counters and error categories only.

The Desire receiver validates the exact canonical schema, stable SHA-256 event
identity, role, completion marker, time, field lengths, and a 20,000-byte text
limit. Source text exists only in the request and interpreter call. Atomic state
writes contain only event IDs, qualitative labels and strengths, bounded deltas,
body state, text-free fact fingerprints, and receipt/effect ledgers. Pending
settlement receipts are recovered before duplicate short-circuiting and once at
receiver startup.

`install-complete-message-hook-once.sh` requires the explicit source checkout,
creates a timestamped recoverable backup, and builds a new Aru release instead
of editing the active release in place. Before activation it runs receive/replay
acceptance with a dynamic loopback receiver whose config, Desire state,
interaction state, ledgers, receipts, pending records, and secret files all live
under one new temporary directory. The fixture is removed on success and every
failure path, and no real delivery endpoint is configured.

This installer is not an enabled-production upgrade interface. Starting with
the v0.9.16 release, an enabled installation must enter through
`upgrade-active-production-once.sh`. That wrapper owns the complete pre-mutation
snapshot, temporary gate transition, quiesce ordering, nested installer call,
post-install identity verification, exact runtime-state restoration, and outer
automatic rollback. Future versions must preserve this separation: installer
preconditions remain fail-closed, while active upgrades adapt those conditions
inside one tested transaction rather than requiring operators to hand-compose
gate changes.

Version 0.9.19 makes that adaptation explicit. The wrapper invokes the
installer's complete running-health preflight before any backup or quiesce and
keeps only bounded comparison facts in a mode-0600 temporary snapshot. The
post-quiesce invocation requires the timer, heartbeat, receiver, and selfhost
service to be inactive and the dashboard to remain active. It reuses that
snapshot for later health comparison; it never asks an intentionally stopped
service to satisfy the running baseline. Real baseline faults still fail before
mutation, and every later error remains covered by inner and outer rollback.

The v0.9.17 active-upgrade preflight treats only LF/CRLF representation, a
missing final newline, and trailing whitespace-only lines as equivalent in
systemd units. It does not trim or reinterpret a nonblank line. Commands,
paths, parameters, permissions, users, environment assignments, sections, and
all other effective content therefore remain exact fail-closed boundaries.
Every preflight rejection emits only a fixed non-sensitive category and occurs
before the transaction creates a backup or quiesces a writer.

The v0.9.17 heartbeat path also persists a 30–120 minute proactive-attempt
deadline independently of this turn hook. Ten-minute heartbeats continue time
evolution, and only a due deadline enters new-decision formation. Journal output
contains an allowlisted category array and an opportunity boolean, never turn
text, state values, prompt content, URLs, or credentials. A proactive
opportunity, an eligible decision, and a delivered wake are distinct events.

Production Aru, receiver, and heartbeat writers are quiesced, but the installer
never opens, copies, parses, hashes, creates, migrates, or writes production
Desire or interaction state. The production state filenames are deliberately
absent from the installer. Receiver health runs with settlement recovery
temporarily disabled; that startup path returns before acquiring a state lock or
opening state. Its error trap restores the prior Aru symlink, Desire code and
configuration, manifests, deployment metadata, owner-only hook secret files,
permissions, loaded paths, and prior service activity without printing secret
values. No production state or conversation content is written to the backup.

安装验收改为完全隔离的临时状态，不再向生产 receiver 注入 synthetic event。

Generated Solo Sessions remain disabled by default. Classified reports of an
already-completed Solo event are separate from that generation feature and can
reach settlement through the authenticated receiver when the existing
interaction gates are enabled.
