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

## 7. Enable Aru delivery

Follow `ARU_INTEGRATION.md` first. Once the sender bundle is installed with
owner `aru-desire` and mode `0600`, run:

```bash
sudo ARU_LOCAL_MANIFEST_URL=http://127.0.0.1:8788/.well-known/aru.json \
  ./scripts/enable-autonomy-once.sh --apply
```

If you also require an externally reachable manifest, set
`ARU_PUBLIC_MANIFEST_URL=https://aru.example.com/.well-known/aru.json`.

The activation script rebases the clock without growth, opens all explicit
delivery gates, enables the timer, and prints rollback and stop commands.

## 8. Stop safely

```bash
sudo ./scripts/disable-autonomy-once.sh --apply
```

This stops future cycles and closes delivery while preserving evolved state.

## 9. Upgrade

Stop autonomy first, then:

```bash
sudo ./scripts/upgrade-once.sh --apply
```

The upgrader verifies tests, preserves state and credentials, and leaves the
timer inactive. Review the printed rollback command before re-enabling.

## 10. Recovery

Use `recover-stalled-delivery-once.sh` only for its documented narrow case:
a dead-process lock plus an unsubmitted local claim. Do not use it as a generic
retry command.