// Single-instance lock. Two pollers on the same token cause Telegram 409
// storms and duplicate command execution, so the second copy must exit.

import fs from 'node:fs';
import path from 'node:path';

export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function acquireLock(file, logger = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (existing?.pid && Number(existing.pid) !== process.pid && isProcessAlive(existing.pid)) {
    throw new Error(`Another bot instance is already running (pid ${existing.pid}).`);
  }
  if (existing) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }

  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 1) throw error;
      const raced = readLock(file);
      if (raced?.pid && isProcessAlive(raced.pid)) {
        throw new Error(`Another bot instance is already running (pid ${raced.pid}).`);
      }
      fs.rmSync(file, { force: true });
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readLock(file);
      if (!current || Number(current.pid) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      logger?.warn('could not remove bot lock');
    }
  };
  process.once('exit', release);
  return { file, release };
}
