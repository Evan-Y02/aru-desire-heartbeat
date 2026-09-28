#!/usr/bin/env node
import { open, readFile, rename } from 'node:fs/promises';

const FLAGS = Object.freeze([
  'observeOnly',
  'deliveryEnabled',
  'chatStimulusEnabled',
  'arousalEnabled',
  'arousalDriveSettlementEnabled',
  'soloSessionsEnabled',
]);

function flagRecord(config) {
  const result = {};
  for (const key of FLAGS) {
    if (typeof config[key] !== 'boolean') throw new Error(`feature flag is invalid: ${key}`);
    result[key] = config[key];
  }
  return result;
}

async function writeAtomic(file, value, mode) {
  const temporary = `${file}.flags.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

const [command, configFile, snapshotFile] = process.argv.slice(2);
if (command === 'require-safe') {
  if (!configFile || snapshotFile) {
    throw new Error('usage: preserve-feature-flags.mjs require-safe CONFIG');
  }
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const flags = flagRecord(config);
  if (flags.observeOnly !== true || flags.deliveryEnabled !== false) {
    throw new Error('installation requires observeOnly=true and deliveryEnabled=false');
  }
  process.exit(0);
}
if (!['capture', 'restore', 'verify'].includes(command) || !configFile || !snapshotFile) {
  throw new Error(
    'usage: preserve-feature-flags.mjs capture|restore|verify CONFIG SNAPSHOT',
  );
}
if (command === 'capture') {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeAtomic(snapshotFile, flagRecord(config), 0o600);
} else {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  if (Object.keys(snapshot).sort().join(',') !== [...FLAGS].sort().join(',')) {
    throw new Error('feature flag snapshot contains unexpected fields');
  }
  const expected = flagRecord(snapshot);
  if (command === 'restore') {
    Object.assign(config, expected);
    await writeAtomic(configFile, config, 0o644);
  } else if (JSON.stringify(flagRecord(config)) !== JSON.stringify(expected)) {
    throw new Error('installed feature flags were not preserved');
  }
}
