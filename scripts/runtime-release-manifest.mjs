#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeReleaseFiles } from './verify-runtime-release.mjs';

export const RUNTIME_MANIFEST_SCHEMA = 'aru.desire-heartbeat.file-manifest.v1';

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} is missing or unsafe`);
  }
  return { info, bytes: await readFile(file) };
}

function combinedDigest(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path, 'utf8');
    digest.update('\0');
    digest.update(file.sha256, 'ascii');
    digest.update('\0');
    digest.update(String(file.size), 'ascii');
    digest.update('\0');
  }
  return digest.digest('hex');
}

export async function createRuntimeManifest(rootArgument) {
  const root = path.resolve(rootArgument);
  const relativeFiles = await runtimeReleaseFiles(root);
  const files = [];
  for (const relative of relativeFiles) {
    const { info, bytes } = await regularFile(path.join(root, relative), `runtime ${relative}`);
    files.push({
      path: relative,
      size: info.size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const packageJson = JSON.parse((await regularFile(
    path.join(root, 'package.json'), 'runtime package',
  )).bytes.toString('utf8'));
  if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(packageJson.version)) {
    throw new Error('runtime package version is invalid');
  }
  return {
    schema: RUNTIME_MANIFEST_SCHEMA,
    version: packageJson.version,
    source: 'recursive-runtime-closure',
    fileCount: files.length,
    digest: combinedDigest(files),
    files,
  };
}

function validateManifestShape(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schema !== RUNTIME_MANIFEST_SCHEMA ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
      manifest.source !== 'recursive-runtime-closure' ||
      !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1 ||
      typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest) ||
      !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) {
    throw new Error('runtime manifest shape is invalid');
  }
  let previous = null;
  for (const file of manifest.files) {
    if (file === null || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).sort().join(',') !== 'path,sha256,size' ||
        typeof file.path !== 'string' || file.path.length === 0 ||
        path.isAbsolute(file.path) || file.path.split('/').includes('..') ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        (previous !== null && previous.localeCompare(file.path) >= 0)) {
      throw new Error('runtime manifest file entry is invalid');
    }
    previous = file.path;
  }
  if (combinedDigest(manifest.files) !== manifest.digest) {
    throw new Error('runtime manifest digest is invalid');
  }
}

export async function verifyRuntimeManifest(rootArgument, manifestArgument) {
  const root = path.resolve(rootArgument);
  const { bytes } = await regularFile(path.resolve(manifestArgument), 'runtime manifest');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('runtime manifest is not valid JSON');
  }
  validateManifestShape(manifest);
  const expectedFiles = await runtimeReleaseFiles(root);
  if (JSON.stringify(manifest.files.map((file) => file.path)) !== JSON.stringify(expectedFiles)) {
    throw new Error('runtime manifest does not match the recursive closure');
  }
  for (const file of manifest.files) {
    const actual = await regularFile(path.join(root, file.path), `runtime ${file.path}`);
    if (actual.info.size !== file.size ||
        createHash('sha256').update(actual.bytes).digest('hex') !== file.sha256) {
      throw new Error(`runtime manifest mismatch: ${file.path}`);
    }
  }
  const packageJson = JSON.parse((await regularFile(
    path.join(root, 'package.json'), 'runtime package',
  )).bytes.toString('utf8'));
  if (packageJson.version !== manifest.version) {
    throw new Error('runtime manifest version does not match the package');
  }
  return manifest;
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, root, manifest] = process.argv.slice(2);
  if (command === 'create' && root && !manifest) {
    process.stdout.write(`${JSON.stringify(await createRuntimeManifest(root), null, 2)}\n`);
  } else if (command === 'verify' && root && manifest) {
    const verified = await verifyRuntimeManifest(root, manifest);
    process.stdout.write(`${JSON.stringify({
      schema: verified.schema,
      version: verified.version,
      fileCount: verified.fileCount,
      digest: verified.digest,
    })}\n`);
  } else {
    throw new Error('usage: runtime-release-manifest.mjs create ROOT | verify ROOT MANIFEST');
  }
}
