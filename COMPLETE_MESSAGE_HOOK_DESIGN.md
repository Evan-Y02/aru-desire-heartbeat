# Complete-message hook deployment

The installed Aru and Desire services run as different system users. A Unix
socket with a `0700` parent and `0600` socket cannot be shared by those users,
so the production design uses HTTP bound only to `127.0.0.1:18761`. Two
owner-only copies of one generated local secret are installed, one readable by
each service. The value is never placed in a unit, command line, event, log, or
diagnostic response.

`aru-desire-turn-hook.mjs` wraps the existing post-save `onTurnSettled`
callback. It invokes and returns the existing remote-push callback first, then
delivers the canonical user event followed by the canonical assistant final.
It performs at most one bounded retry, uses a bounded configurable attempt
timeout (1000 ms in the production unit), and never throws into the conversation
path. Diagnostics contain counters and error categories only.

The Desire receiver validates the exact canonical schema, stable SHA-256 event
identity, role, completion marker, time, field lengths, and a 20,000-byte text
limit. Source text exists only in the request and interpreter call. Atomic state
writes contain only event IDs, qualitative labels, bounded deltas, body state,
and receipt/effect ledgers.

`install-complete-message-hook-once.sh` creates a timestamped code-only backup,
builds a new Aru release instead of editing the active release in place,
initializes interaction state through the project initializer, installs the
receiver and feature-gated hook, and verifies service, device-count, bridge, and
loopback health. Its error trap restores the prior Aru symlink, Desire code and
configuration, owner-only hook secret files, interaction state, and prior
service activity without printing secret values. Conversation content is never
written to the backup.

Solo Sessions remain disabled because the current heartbeat Solo branch has no
authorized model-final callback that accepts the generation contract. Existing
hosted reply and separate conversation-desire flows are not repurposed: doing so
would change protected reply/initiative behavior rather than reuse the same
30–120 minute Solo selection turn.
