# Deployment guide

This guide keeps installation and activation separate. Copying files must never
implicitly start autonomous delivery.

## 1. Requirements

- Node.js 22
- Python 3
- systemd
- a dedicated Linux account named `aru-desire`
- optional: Caddy for the dashboard
- optional: Aru Self-Hosted external-trigger sender bundle

## 2. Verify the checkout

```bash
npm test
find . -type l -print
```

The second command should print nothing.

## 3. Create the service account

Review this command for your distribution before running it:

```bash
sudo useradd --system --home /var/lib/aru-desire-heartbeat \
  --shell /usr/sbin/nologin aru-desire
```

## 4. Install without enabling

```bash
sudo ./scripts/install-once.sh --apply
```

The installer derives the source path from its own location, installs the app
under `/opt/aru-desire-heartbeat`, creates the protected data directory and
installs disabled systemd units. It does not initialize state or start the timer.

To copy an existing Aru sender bundle during installation, pass an absolute
`0600` file explicitly:

```bash
sudo ARU_SEND_CREDENTIAL_FILE=/secure/path/sender-bundle.json \
  ./scripts/install-once.sh --apply
```

Never put that file inside the Git repository.

## 5. Initialize and observe

```bash
sudo -u aru-desire /usr/bin/node \
  /opt/aru-desire-heartbeat/bin/desire-heartbeat.mjs init \
  --config /opt/aru-desire-heartbeat/config/default.json \
  --data-dir /var/lib/aru-desire-heartbeat
```

Leave `observeOnly=true`, `deliveryEnabled=false` and delivery
`enabled=false` while calibrating.

You may run a manual cycle and inspect the redacted state:

```bash
sudo -u aru-desire /usr/bin/node \
  /opt/aru-desire-heartbeat/bin/desire-cycle.mjs \
  --config /opt/aru-desire-heartbeat/config/default.json \
  --delivery-config /opt/aru-desire-heartbeat/config/aru-delivery.json \
  --data-dir /var/lib/aru-desire-heartbeat
```

## 6. Dashboard

The service binds to localhost only:

```bash
sudo install -m 0644 systemd/aru-desire-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aru-desire-dashboard.service
curl -fsS http://127.0.0.1:18760/healthz
```

Example Caddy block:

```caddyfile
pulse.example.com {
    encode zstd gzip
    basic_auth {
        desire REPLACE_WITH_CADDY_HASH
    }
    reverse_proxy 127.0.0.1:18760
}
```

Create the hash with `caddy hash-password`. Use a real domain and verify that
an unauthenticated request receives HTTP 401.

In v0.9.15 the authenticated Dashboard includes the read-only
“射精与满足结算” module. It projects only allowlisted structured settlement
fields, keeps missing legacy values as “未知”, and never exposes conversation
bodies, thoughts, secrets, credentials, tokens, complete private URLs, or raw
payloads. It does not add a write route or change settlement, delivery, or
production gates.

## 7. Enable Aru delivery

Follow `ARU_INTEGRATION.md` first. Once the sender bundle is installed with
owner `aru-desire` and mode `0600`, run the read-only preflight first:

```bash
sudo ./scripts/enable-autonomy-once.sh --preflight
```

It makes no network request and prints only fixed status names and counts. If a
pending decision exists, it stops before reading either credential. It also
silently requires the installed bundle to match the existing owner-only
provisioning bundle. A running timer is reported through
`TIMER_QUIESCE_REQUIRED=1` and is not changed by preflight.

Only after a PASS and a separate decision to activate, run:

```bash
sudo ARU_LOCAL_MANIFEST_URL=http://127.0.0.1:8788/.well-known/aru.json \
  ./scripts/enable-autonomy-once.sh --apply
```

If you also require an externally reachable manifest, set
`ARU_PUBLIC_MANIFEST_URL=https://aru.example.com/.well-known/aru.json`.

The activation script snapshots the timer's prior state, installs automatic
failure recovery, stops the timer, confirms the heartbeat service is inactive,
and then runs exactly one complete privacy-safe preflight. That preflight accepts
the controlled inactive timer state. Only after it and the final pending-decision
check pass does activation rebase the clock without growth and open the two outer
delivery gates while preserving unrelated feature gates. A later failure closes
delivery, removes any enable file created by the attempt, restores changed
protected files and the timer's prior enabled/active state, and cannot leave a
half-enabled installation.

## 8. Stop safely

```bash
sudo ./scripts/disable-autonomy-once.sh --apply
```

This stops future cycles and closes delivery while preserving evolved state.

## 9. Upgrade

For an already enabled v0.9.14, v0.9.15, v0.9.16, or v0.9.17 production
installation, use the single transactional entry point from the v0.9.18
checkout:

```bash
sudo /absolute/path/to/v0.9.18/source/scripts/upgrade-active-production-once.sh --apply
```

The v0.9.18 preflight emits a fixed `failure_class`. Its systemd comparison
accepts LF/CRLF form, a missing final newline, and trailing whitespace-only
lines, but keeps every nonblank line byte-exact. Any changed command, path,
parameter, permission, user, environment assignment, unit section, or other
effective content fails closed before backup creation, production mutation, or
service quiesce.

For manifest-bound v0.9.14–v0.9.16 installations, preflight supplies the
attempt-window defaults and null next-attempt field only in its in-memory
validation view when those later fields are absent. A present field with a
wrong type or invalid value remains a schema failure. Installation writes the
complete new config while preserving all six feature gates; protected state is
not rewritten by this migration.

After installation, every heartbeat still advances elapsed-time state. New
proactive decisions enter evaluation only at a persisted deadline sampled 30–120
minutes ahead. Journal output records fixed non-sensitive categories and whether
that cycle received an attempt opportunity; `eligible` and `delivered` are
separate, and no state values or message content are logged.

Do not stop autonomy first and do not invoke
`install-complete-message-hook-once.sh` directly for an enabled installation.
The active-production entry point verifies the installed identity and both
manifests, creates the complete rollback snapshot before mutation, quiesces the
timer and writers, applies temporary safe gates, invokes the guarded installer,
and restores the exact prior gates and service state. Any failed stage invokes
the snapshot-bound rollback automatically. On success it prints the only valid
explicit rollback command. That rollback refuses to overwrite protected state
after it has evolved.

The direct complete-message installer remains valid only for initial or already
disabled maintenance flows that satisfy its fail-closed gate precondition.

Future releases must update the active-production transaction, supported source
version allowlist, target-version assertion, both generated runtime manifests,
rollback snapshot schema, and full isolated failure matrix together. A
first-install script must never be presented as an enabled-production upgrade
path.

## 10. Recovery

Use `recover-stalled-delivery-once.sh` only for its documented narrow case:
a dead-process lock plus an unsubmitted local claim. Do not use it as a generic
retry command.
