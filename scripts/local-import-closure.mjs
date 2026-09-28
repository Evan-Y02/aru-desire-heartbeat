#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const importPattern = /(?:from\s*|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/gu;

export async function localImportClosure(rootArgument, entries) {
  if (!rootArgument || !Array.isArray(entries) || entries.length === 0) {
    throw new Error('root and entry files are required');
  }
  const root = path.resolve(rootArgument);
  const visited = new Set();
  const pending = entries.map((entry) => path.resolve(root, entry));

  while (pending.length > 0) {
    const file = pending.pop();
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('local import escaped the source root');
    }
    if (visited.has(relative)) continue;
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`runtime artifact is not a file: ${relative}`);
    visited.add(relative);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      let dependency = path.resolve(path.dirname(file), match[1]);
      if (path.extname(dependency) === '') dependency += '.mjs';
      pending.push(dependency);
    }
  }
  return [...visited].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [rootArgument, ...entries] = process.argv.slice(2);
  const closure = await localImportClosure(rootArgument, entries);
  process.stdout.write(`${closure.join('\n')}\n`);
}
