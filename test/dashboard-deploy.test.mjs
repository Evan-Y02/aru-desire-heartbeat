import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const installPath = new URL("../scripts/install-dashboard-once.sh", import.meta.url);
const rollbackPath = new URL("../scripts/rollback-dashboard.sh", import.meta.url);
const loginUpgradePath = new URL("../scripts/upgrade-dashboard-login-once.sh", import.meta.url);
const loginRollbackPath = new URL("../scripts/rollback-dashboard-login.sh", import.meta.url);

test("dashboard installer keeps authentication and heartbeat boundaries explicit", async () => {
  const source = await readFile(installPath, "utf8");
  assert.match(source, /read -r -s -p "New dashboard password/);
  assert.match(source, /hashlib\.scrypt/);
  assert.match(source, /authentication=web_session/);
  assert.doesNotMatch(source, /basicauth|basic_auth/);
  assert.match(source, /pulse\.xinchaonian\.duckdns\.org/);
  assert.match(source, /reverse_proxy 127\.0\.0\.1:18760/);
  assert.match(source, /heartbeat timer must remain inactive/);
  assert.match(source, /for attempt in \{1\.\.15\}/);
  assert.match(source, /dashboard did not become ready within 15 seconds/);
  assert.match(source, /systemctl status "\$SERVICE" --no-pager/);
  assert.doesNotMatch(source, /enable --now aru-desire-heartbeat/);
});

test("dashboard login migration is scoped, reversible, and removes only the proxy auth gate", async () => {
  const source = await readFile(loginUpgradePath, "utf8");
  const rollback = await readFile(loginRollbackPath, "utf8");
  assert.match(source, /heartbeat timer must be inactive during dashboard login upgrade/);
  assert.match(source, /production state changed during dashboard login upgrade/);
  assert.match(source, /hashlib\.scrypt/);
  assert.match(source, /basic_auth\|basicauth/);
  assert.match(source, /protected snapshot returned HTTP/);
  assert.match(source, /restore_failed_upgrade/);
  assert.match(rollback, /dashboard login backup path is invalid/);
  assert.doesNotMatch(source, /state\.json["']?\s*,?\s*["']?w/);
});

test("dashboard rollback is scoped away from desire state and application", async () => {
  const source = await readFile(rollbackPath, "utf8");
  assert.match(source, /dashboard backup path is invalid/);
  assert.match(source, /sha256sum --check/);
  assert.match(source, /desire_application_unchanged=yes/);
  assert.doesNotMatch(source, /\/var\/lib\/aru-desire-heartbeat\/state\.json/);
  assert.doesNotMatch(source, /rm -rf/);
});
