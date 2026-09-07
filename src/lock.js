import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EAG_HOME } from './paths.js';

const ownership = new AsyncLocalStorage();
export const MUTATION_LOCK = path.join(EAG_HOME, '.state', 'mutation.lock');

// Reentrant only within the same async call chain (setup -> adopt -> apply).
// Separate CLI processes and concurrent calls fail promptly instead of deadlocking
// an agent launch. A crash leaves an explicit recovery marker, never a guessed owner.
export function withLock(file, fn) {
  const held = ownership.getStore() ?? new Map();
  if (held.get(file)?.active) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`another eag mutation holds ${file}; after confirming no eag process is running, remove a stale lock and retry`);
    throw e;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
  let released = false;
  const token = { active: true };
  const identity = fs.fstatSync(fd);
  const release = () => {
    if (released) return;
    released = true;
    token.active = false;
    let current;
    try { current = fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') { fs.closeSync(fd); throw e; } }
    fs.closeSync(fd);
    if (current?.ino !== identity.ino || current?.dev !== identity.dev) throw new Error('mutation lock ownership changed; replacement lock was preserved');
    fs.unlinkSync(file);
  };
  try {
    const result = ownership.run(new Map([...held, [file, token]]), fn);
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release(); return result;
  } catch (e) { release(); throw e; }
}

export const withMutationLock = (fn) => withLock(MUTATION_LOCK, fn);
