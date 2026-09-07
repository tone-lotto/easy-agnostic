import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EAG_HOME } from './paths.js';
import { readJson, writeJson, exists } from './util.js';

// eag is invoked by hooks and wrappers that run without the user's PATH, from a location
// that depends on HOW it was installed. Everything here exists so those callers keep working
// after an upgrade, and so an upgrade happens without anyone remembering to run it.
const PKG = createRequire(import.meta.url)('../package.json');
export const VERSION = PKG.version;
export const ENTRY = fileURLToPath(new URL('../bin/eag.js', import.meta.url));
const STAMP = path.join(EAG_HOME, '.state', 'update.json');

// global   `npm i -g`: a stable path, updatable in place
// npx      the npx cache: evictable, pinned to one version, never on PATH
// dev      a checkout linked with `npm link`: never touched by an auto-update
export function installKind(entry = ENTRY) {
  let real = entry;
  try { real = fs.realpathSync(entry); } catch { /* keep as is */ }
  if (/[\\/]_npx[\\/]/.test(real)) return 'npx';
  // A checkout: a .git above the package root, or the global package dir being a symlink.
  let d = path.dirname(real);
  for (let i = 0; i < 6 && d !== path.dirname(d); i++, d = path.dirname(d)) {
    if (exists(path.join(d, '.git'))) return 'dev';
  }
  return 'global';
}

// Where `npm i -g` puts binaries. Resolved once, at install time, when npm is on PATH;
// the hook launcher has no PATH to speak of.
export function globalBinDir() {
  try { return path.join(execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(), 'bin'); }
  catch { return null; }
}

export function onPath(bin = 'eag') {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}

export const newer = (a, b) => {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

// The registry's idea of latest. Short timeout, any failure is "unknown": this runs from a
// hook, and a hook must never wait on the network.
export async function latestVersion({ timeoutMs = 3000 } = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`https://registry.npmjs.org/${PKG.name}/latest`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const v = (await r.json()).version;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

// At most one registry call a day, remembered in .state/update.json. Returns the newer
// version when there is one, else null — and never throws.
export async function checkThrottled({ everyMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const st = readJson(STAMP, {});
  if (st.checkedAt && now - st.checkedAt < everyMs) return st.latest && newer(st.latest, VERSION) ? st.latest : null;
  // Offline or a broken registry: keep the last answer rather than forgetting it.
  const latest = (await latestVersion()) ?? st.latest ?? null;
  try { writeJson(STAMP, { checkedAt: now, latest, current: VERSION }, 0o600); } catch { /* read-only state dir */ }
  return latest && newer(latest, VERSION) ? latest : null;
}

// Install a version in place. Only for a global install: an npx cache cannot be updated
// and a dev checkout must never be overwritten by npm.
export function selfUpdate(version, { detached = false, fromNpx = false } = {}) {
  const kind = installKind();
  if (kind === 'dev') return { ok: false, reason: 'installed from a checkout (npm link); update it with git' };
  if (kind === 'npx' && !fromNpx) return { ok: false, reason: 'running from the npx cache; run: npm i -g easy-agnostic' };
  const args = ['i', '-g', `${PKG.name}@${version}`];
  if (detached) {
    try {
      const p = spawn('npm', args, { detached: true, stdio: 'ignore' });
      p.unref();
      return { ok: true, background: true };
    } catch (e) { return { ok: false, reason: e.message }; }
  }
  try { execFileSync('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.stderr?.toString().trim() || e.message }; }
}
