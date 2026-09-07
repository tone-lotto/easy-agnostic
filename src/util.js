import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SECRET_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const WHOLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
export function shellQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('shell value must be a string without NUL characters');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function readJson(file, fallback) {
  return readJsonSnapshot(file, fallback).value;
}
export function readJsonSnapshot(file, fallback) {
  try { const text = fs.readFileSync(file, 'utf8'); return { value: JSON.parse(text), text }; }
  catch (e) { if (e.code === 'ENOENT') return { value: fallback, text: null }; throw new Error(`${file}: ${e instanceof SyntaxError ? 'invalid JSON (content withheld)' : e.code || 'could not read file'}`); }
}
export function exists(file) { try { fs.statSync(file); return true; } catch { return false; } }
export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

export function writeFileAtomic(file, text, mode, options = {}) {
  // temp + rename replaces the inode, so resolve a symlink first: a config kept in a
  // dotfiles repo must keep receiving writes instead of being detached. Without an
  // explicit mode, restore exactly what the file had (umask must not narrow a user's
  // own permissions); a new file gets 0644 & ~umask.
  let target = file;
  try { target = fs.realpathSync(file); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to replace a dangling config symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  ensureDir(path.dirname(target));
  let keep;
  if (mode === undefined) { try { keep = fs.statSync(target).mode & 0o777; } catch { /* new file */ } }
  const want = mode ?? keep;
  const tmp = `${target}.eag-tmp-${randomUUID()}`;
  let fd;
  try {
    // Unique exclusive creation: never delete another writer's temporary file.
    fd = fs.openSync(tmp, 'wx', want ?? 0o644);
    fs.writeFileSync(fd, text);
    // open()'s mode applies only on creation and the umask narrows it: set it on the
    // descriptor so an asked-for 0600 really is 0600 and a preserved mode is exact.
    if (want !== undefined) fs.fchmodSync(fd, want);
    fs.closeSync(fd); fd = undefined;
    if (Object.hasOwn(options, 'expected')) {
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (current !== options.expected) throw new Error('configuration changed before replacement; retry');
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    fs.rmSync(tmp, { force: true }); // never leave a temp file holding the payload behind
    throw e;
  }
}
export function writeJson(file, obj, mode) { writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode); }

export function backup(file, backupDir, label) {
  if (!exists(file)) return null;
  ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `${label}-${stamp}-${randomUUID()}${path.extname(file)}`);
  // Native files can hold literal secrets: keep backups as private as the state snapshot.
  fs.writeFileSync(dest, fs.readFileSync(file), { mode: 0o600, flag: 'wx' });
  // keep the last 10 per label
  const old = fs.readdirSync(backupDir).filter((f) => f.startsWith(`${label}-`) && f !== path.basename(dest)).sort().reverse().slice(9);
  for (const f of old) fs.rmSync(path.join(backupDir, f), { force: true });
  return dest;
}

// Byte-for-byte equality of two directory trees. Used to tell a harmless duplicate of a
// skill from a genuine name collision: the first can be replaced with a link and nothing is
// lost, the second means two different skills are fighting over one name.
export function sameTree(a, b) {
  let sa;
  let sb;
  try { sa = fs.lstatSync(a); sb = fs.lstatSync(b); } catch { return false; }
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
  }
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) {
    if (sa.size !== sb.size) return false;
    try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
  }
  let ea;
  let eb;
  try { ea = fs.readdirSync(a).sort(); eb = fs.readdirSync(b).sort(); } catch { return false; }
  if (ea.length !== eb.length || ea.some((n, i) => n !== eb[i])) return false;
  return ea.every((n) => sameTree(path.join(a, n), path.join(b, n)));
}

export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
export function deepEqual(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }
export function isEmpty(v) { return v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0); }
export function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!isEmpty(v)) out[k] = v;
  return out;
}

export function refsIn(value, acc = new Set()) {
  if (typeof value === 'string') { for (const m of value.matchAll(SECRET_REF)) acc.add(m[1]); }
  else if (Array.isArray(value)) value.forEach((v) => refsIn(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => refsIn(v, acc));
  return acc;
}
export function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

// Replace every occurrence of a known secret VALUE with its ${NAME}. Native entries can hold
// resolved values (Claude user scope does), and --json output goes into logs.
export function redactKnown(value, pairs) {
  return mapStrings(value, (s) => {
    let out = s;
    for (const [name, v] of pairs) if (v && out.includes(v)) out = out.split(v).join(`\${${name}}`);
    return out;
  });
}

// Heuristic used by lint and adopt: does this string look like a literal credential?
export function looksLikeSecret(s) {
  if (typeof s !== 'string') return false;
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(s)) return false; // holds a ${NAME} reference ("Bearer ${TOKEN}"): not a literal
  if (/^Bearer\s+\S{16,}$/i.test(s)) return true;
  if (/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(s)) return true; // AWS key id: 20 chars, no separator, under the length floor below
  if (/^(sk|pk|(?:[a-z0-9]+_)?pat|ghp|gho|xox[abp]|phc|phx)[_-][A-Za-z0-9_-]{12,}$/i.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return true; // JWT (the header is base64url of {"alg":…}, always eyJ)
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i.test(s)) return true; // URL with user:password@
  // From here the rules match on shape alone, so rule out the two shapes that look like an
  // opaque blob and never are: a filesystem path and a uuid.
  if (/^[~.]?\//.test(s)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
  if (/^(?=.*\d)(?=.*[A-Z])[A-Za-z0-9+/]{32,}={0,2}$/.test(s)) return true; // long base64 blob
  return /^[A-Za-z0-9_\-]{32,}$/.test(s);
}

// Colour only for a human at a terminal: honour NO_COLOR, and stay plain when the output
// is piped so a script can grep it without stripping escapes. FORCE_COLOR overrides both.
const COLOR = process.env.FORCE_COLOR
  ? true
  : process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && !!process.stdout.isTTY;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
export const c = { ok: paint(32), warn: paint(33), bad: paint(31), dim: paint(2), bold: paint(1) };
