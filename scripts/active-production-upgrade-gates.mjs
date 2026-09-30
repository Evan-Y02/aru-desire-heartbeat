#!/usr/bin/env node
import { open, readFile, rename } from 'node:fs/promises';

async function atomicJson(file, value, mode = 0o644) {
  const temporary = `${file}.active-upgrade.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    // The root wrapper runs with umask 0077; force the intended public mode.
    await handle.chmod(mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function parse(bytes) {
  const value = JSON.parse(bytes);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid JSON');
  return value;
}

const [command, heartbeatFile, deliveryFile, snapshotFile] = process.argv.slice(2);
if (!['capture', 'safe', 'restore', 'verify'].includes(command) ||
    !heartbeatFile || !deliveryFile || !snapshotFile) {
  throw new Error('usage: active-production-upgrade-gates.mjs capture|safe|restore|verify HEARTBEAT DELIVERY SNAPSHOT');
}

const heartbeat = parse(await readFile(heartbeatFile, 'utf8'));
const delivery = parse(await readFile(deliveryFile, 'utf8'));
if (typeof heartbeat.observeOnly !== 'boolean' ||
    typeof heartbeat.deliveryEnabled !== 'boolean' ||
    typeof delivery.enabled !== 'boolean') throw new Error('upgrade gate is invalid');

if (command === 'capture') {
  await atomicJson(snapshotFile, {
    observeOnly: heartbeat.observeOnly,
    deliveryEnabled: heartbeat.deliveryEnabled,
    adapterEnabled: delivery.enabled,
  }, 0o600);
} else {
  const snapshot = parse(await readFile(snapshotFile, 'utf8'));
  if (Object.keys(snapshot).sort().join(',') !==
      'adapterEnabled,deliveryEnabled,observeOnly' ||
      Object.values(snapshot).some((value) => typeof value !== 'boolean')) {
    throw new Error('upgrade gate snapshot is invalid');
  }
  if (command === 'safe') {
    heartbeat.observeOnly = true;
    heartbeat.deliveryEnabled = false;
    await atomicJson(heartbeatFile, heartbeat);
  } else if (command === 'restore') {
    heartbeat.observeOnly = snapshot.observeOnly;
    heartbeat.deliveryEnabled = snapshot.deliveryEnabled;
    delivery.enabled = snapshot.adapterEnabled;
    await atomicJson(heartbeatFile, heartbeat);
    await atomicJson(deliveryFile, delivery);
  } else if (heartbeat.observeOnly !== snapshot.observeOnly ||
      heartbeat.deliveryEnabled !== snapshot.deliveryEnabled ||
      delivery.enabled !== snapshot.adapterEnabled) {
    throw new Error('upgrade gates were not restored');
  }
}
