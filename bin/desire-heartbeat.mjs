#!/usr/bin/env node
import { run, safeError } from '../src/cli.mjs';

try {
  await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
}