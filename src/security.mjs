import { constants, open, lstat, mkdir, realpath, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(message, code = 'SECURITY_ERROR') {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

export async function ensureSecureDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SecurityError('data path must be a real directory', 'UNSAFE_DATA_DIRECTORY');
  }
  if ((info.mode & 0o777) !== 0o700 || info.uid !== process.geteuid()) {
    throw new SecurityError('data directory must be owner-only and owned by the current user', 'UNSAFE_DATA_DIRECTORY');
  }
  if (await realpath(resolved) !== resolved) {
    throw new SecurityError('data directory path may not traverse symbolic links', 'UNSAFE_DATA_DIRECTORY');
  }
  return resolved;
}

export async function assertSecureRegularFile(file, { allowMissing = false } = {}) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new SecurityError('persistent file must be a regular non-symlink file', 'UNSAFE_STATE_FILE');
  }
  if ((info.mode & 0o777) !== 0o600 || info.uid !== process.geteuid()) {
    throw new SecurityError('persistent file must be owner-only and owned by the current user', 'UNSAFE_STATE_FILE');
  }
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function removeDeadOwnerLock(dataDirectory, lockPath) {
  const info = await lstat(lockPath).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 ||
      info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600) {
    throw new SecurityError('existing lock is unsafe', 'UNSAFE_LOCK');
  }
  let record;
  try {
    record = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    throw new SecurityError('existing lock record is invalid', 'UNSAFE_LOCK');
  }
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 ||
      !Number.isSafeInteger(record.acquiredAt) || record.acquiredAt < 0) {
    throw new SecurityError('existing lock record is invalid', 'UNSAFE_LOCK');
  }
  if (processIsAlive(record.pid)) return false;
  const latest = await lstat(lockPath);
  if (latest.dev !== info.dev || latest.ino !== info.ino || latest.isSymbolicLink() ||
      !latest.isFile() || latest.nlink !== 1 || latest.uid !== process.geteuid()) {
    throw new SecurityError('lock changed during stale-lock recovery', 'UNSAFE_LOCK');
  }
  const directory = await open(dataDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await unlink(lockPath);
    await directory.sync();
  } finally {
    await directory.close();
  }
  return true;
}

export async function acquireLock(dataDirectory) {
  const lockPath = path.join(dataDirectory, 'heartbeat.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`, 'utf8');
      await handle.sync();
      const info = await handle.stat();
      return { handle, lockPath, device: info.dev, inode: info.ino };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await removeDeadOwnerLock(dataDirectory, lockPath)) continue;
      throw new SecurityError('another state-changing command holds the lock', 'LOCKED');
    }
  }
  throw new SecurityError('could not acquire state lock', 'LOCKED');
}

export async function releaseLock(lock) {
  await lock.handle.close();
  const info = await lstat(lock.lockPath);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.geteuid() ||
      info.nlink !== 1 || info.dev !== lock.device || info.ino !== lock.inode) {
    throw new SecurityError('lock changed while held; refusing removal', 'UNSAFE_LOCK');
  }
  const directory = path.dirname(lock.lockPath);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(lock.lockPath);
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function withLock(dataDirectory, action) {
  const directory = await ensureSecureDirectory(dataDirectory);
  const lock = await acquireLock(directory);
  let actionError;
  try {
    return await action(directory);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try {
      await releaseLock(lock);
    } catch (releaseError) {
      if (!actionError) throw releaseError;
    }
  }
}