import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EAG_HOME, physicalPath } from './paths.js';
import { readJson, writeFileAtomic } from './util.js';
import { withLock } from './lock.js';
import { validVersion, newer, installKind } from './update.js';

export const BASE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BASE_PACKAGE = readJson(path.join(BASE_ROOT, 'package.json'));
export const POLICY_FILE = path.join(EAG_HOME, 'update-policy.json');
export const UPDATE_ROOT = path.join(EAG_HOME, '.state', 'updates');
export const ACTIVE_FILE = path.join(UPDATE_ROOT, 'active.json');
export const STATUS_FILE = path.join(UPDATE_ROOT, 'status.json');
export const PENDING_FILE = path.join(UPDATE_ROOT, 'pending.json');
export const GATE = path.join(UPDATE_ROOT, 'activation.lock');
export const READERS = path.join(UPDATE_ROOT, 'readers');
export const RELEASES = path.join(UPDATE_ROOT, 'releases');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const versionLine = v => validVersion(v) ? v.split('.').slice(0, 2).join('.') : null;
export const present = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// Only EAG_HOME supplies the policy. Project agents.json and legacy autoUpdate
// booleans are deliberately never consulted. Refuse aliases within this store.
export function guardStore(extra = []) {
  if (!path.isAbsolute(EAG_HOME)) throw new Error('automatic updates require an absolute EAG_HOME');
  const root = physicalPath(EAG_HOME);
  const rootStat = present(root);
  if (rootStat && (rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o022))) throw new Error('update home has unsafe ownership or permissions');
  for (const file of [POLICY_FILE, UPDATE_ROOT, ACTIVE_FILE, STATUS_FILE, PENDING_FILE, GATE, READERS, RELEASES, ...extra]) {
    const relative = path.relative(EAG_HOME, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('update path escapes user store');
    let p = path.join(root, path.relative(EAG_HOME, file));
    while (p !== root) {
      const st = present(p);
      if (st?.isSymbolicLink() || (st && st.uid !== process.getuid?.())) throw new Error('update store has an unsafe owner or symlink');
      if (st && (st.mode & 0o022)) throw new Error('update store must not be writable by other users');
      if (st?.isFile() && st.nlink !== 1) throw new Error('update store must not contain hard links');
      p = path.dirname(p);
    }
  }
}

export function loadPolicy() {
  const p = readJson(POLICY_FILE, null);
  if (p === null) return null;
  if (!record(p) || p.protocol !== 1 || typeof p.enabled !== 'boolean' || !ID.test(p.generation)
      || !/^\d+\.\d+$/.test(p.line) || !Number.isSafeInteger(p.compatibility) || p.compatibility < 1
      || typeof p.consentedAt !== 'string') throw new Error('invalid automatic-update policy; automatic updates are disabled');
  return p;
}

export function writePrivate(file, value) {
  guardStore([file]);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', 0o600);
}

export function treeDigest(dir) {
  const hash = createHash('sha256'); let count = 0; let bytes = 0;
  const walk = (file, rel, depth) => {
    const st = fs.lstatSync(file);
    if (st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error('unsafe installed update ownership or permissions');
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) throw new Error('unsafe installed update tree');
    if (++count > 10000 || depth > 32 || (bytes += st.isFile() ? st.size : 0) > 64 * 1024 * 1024) throw new Error('installed update exceeds limits');
    hash.update(JSON.stringify([rel, st.isDirectory(), st.isFile() ? st.size : 0, st.mode & 0o111]) + '\n');
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), `${rel}/${name}`, depth + 1);
    else hash.update(fs.readFileSync(file));
  };
  walk(dir, '', 0); return hash.digest('hex');
}

export function releaseRoot(receipt) {
  if (!record(receipt) || receipt.protocol !== 1 || !ID.test(receipt.id) || !validVersion(receipt.version)
      || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('invalid update receipt');
  return path.join(RELEASES, receipt.id);
}

export function verifyRelease(receipt) {
  guardStore();
  const root = releaseRoot(receipt);
  guardStore([root]);
  if (present(root)?.isSymbolicLink()) throw new Error('unsafe update release path');
  const modules = path.join(root, 'node_modules');
  if (treeDigest(modules) !== receipt.digest) throw new Error('installed update integrity mismatch');
  const packageRoot = path.join(modules, 'easy-agnostic');
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  if (pkg.name !== 'easy-agnostic' || pkg.version !== receipt.version || pkg.eagUpdate?.protocol !== 1) throw new Error('invalid update package');
  return { root: packageRoot, pkg, receipt };
}

export function selectRuntime(baseRoot = BASE_ROOT) {
  const pkg = readJson(path.join(baseRoot, 'package.json'));
  const fallback = { root: baseRoot, pkg, receipt: null };
  // A checkout or npx invocation must never execute another installed version.
  if (installKind(path.join(baseRoot, 'bin', 'eag.js')) !== 'global') return fallback;
  try {
    guardStore();
    const active = readJson(ACTIVE_FILE, null);
    if (!active || !newer(active.version, pkg.version)) return fallback;
    return verifyRelease(active);
  } catch (e) { return { ...fallback, warning: e.message }; }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Called while holding GATE. PID reuse can postpone activation, never justify
// interrupting a live process. Unknown/corrupted lease files fail closed.
export function busyReaders(isAlive = alive) {
  if (!present(READERS)) return false;
  let busy = false;
  for (const name of fs.readdirSync(READERS)) {
    const match = /^(\d+)-([0-9a-f-]+)\.json$/.exec(name);
    const file = path.join(READERS, name), st = fs.lstatSync(file);
    if (!match || !ID.test(match[2]) || !st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.()) { busy = true; continue; }
    const lease = readJson(file, null);
    if (!record(lease) || lease.pid !== Number(match[1]) || lease.id !== match[2] || lease.pid < 1) { busy = true; continue; }
    if (isAlive(lease.pid)) busy = true;
    else fs.unlinkSync(file);
  }
  return busy;
}

export function acquireRuntime(baseRoot = BASE_ROOT) {
  const pkg = readJson(path.join(baseRoot, 'package.json'));
  const fallback = { root: baseRoot, pkg, receipt: null, release: () => {} };
  if (!present(POLICY_FILE) && !present(ACTIVE_FILE)) return fallback;
  if (installKind(path.join(baseRoot, 'bin', 'eag.js')) !== 'global') return fallback;
  try {
    guardStore();
    return withLock(GATE, () => {
      const selected = selectRuntime(baseRoot), id = randomUUID();
      fs.mkdirSync(READERS, { recursive: true, mode: 0o700 });
      const lease = path.join(READERS, `${process.pid}-${id}.json`);
      fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
      const identity = fs.lstatSync(lease);
      return { ...selected, release: () => {
        const current = present(lease);
        if (current?.ino === identity.ino && current.dev === identity.dev) fs.unlinkSync(lease);
      } };
    });
  } catch (e) {
    // Never block the agent's launcher. The baseline is immutable and remains
    // usable; mutation locks still protect its writes during an activation.
    return { ...fallback, warning: e.message };
  }
}

export async function boot(args, baseRoot = BASE_ROOT) {
  const selected = acquireRuntime(baseRoot);
  let code;
  try {
    let module;
    try { module = await import(pathToFileURL(path.join(selected.root, 'src', 'cli.js')).href); }
    catch (e) {
      if (!selected.receipt) throw e;
      // Fall back only before invoking a command. Never replay partial mutations.
      module = await import(pathToFileURL(path.join(baseRoot, 'src', 'cli.js')).href);
    }
    const { main } = module;
    code = await main(args);
  } finally { selected.release(); }
  // Queries, invalid commands and previews do not schedule updates. The existing
  // launch wrappers invoke apply/env; Pi's env path is included without syncing MCP.
  if ((code ?? 0) === 0 && ['apply', 'env'].includes(args[0]) && !args.some(a => /^--(?:dry-run|help|version)(?:=|$)/.test(a))) {
    try {
      const { scheduleAutoUpdate } = await import(pathToFileURL(path.join(selected.root, 'src', 'auto-update.js')).href);
      scheduleAutoUpdate({ baseRoot, workerRoot: selected.root });
    } catch { /* optional maintenance must never prevent an agent launch */ }
  }
  return code ?? 0;
}
