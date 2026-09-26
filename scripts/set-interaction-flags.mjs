#!/usr/bin/env node
import { open, readFile, rename } from 'node:fs/promises';

const file = process.argv[2];
const values = Object.fromEntries(process.argv.slice(3).map((entry) => {
  const [key, raw] = entry.split('=');
  if (!['chatStimulusEnabled', 'arousalEnabled', 'arousalDriveSettlementEnabled',
    'soloSessionsEnabled'].includes(key) || !['true', 'false'].includes(raw)) {
    throw new Error('invalid feature flag assignment');
  }
  return [key, raw === 'true'];
}));
if (!file || Object.keys(values).length === 0) throw new Error('config and assignments are required');
const config = JSON.parse(await readFile(file, 'utf8'));
for (const [key, value] of Object.entries(values)) config[key] = value;
const temporary = `${file}.flags.tmp`;
const handle = await open(temporary, 'wx', 0o644);
try {
  // The root installer deliberately runs with umask 0077. The deployed
  // configuration contains no secrets and must remain readable by aru-desire.
  await handle.chmod(0o644);
  await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
  await handle.sync();
} finally {
  await handle.close();
}
await rename(temporary, file);
