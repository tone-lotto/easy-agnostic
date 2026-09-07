import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EAG_HOME } from './paths.js';
import { readJson, writeJson, exists } from './util.js';
import { processFailure } from './redact.js';
import { withMutationLock, withLock } from './lock.js';

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

// npm, found the way the launcher finds node: next to the running node first, PATH second.
// A hook started by a desktop app has PATH=/usr/bin:/bin:/usr/sbin:/sbin and no npm on it,
// and that is exactly where the background update has to run from.
export function npmBin() {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return exists(beside) ? beside : 'npm';
}
// How to invoke it: `npm` is itself a node script with an env shebang, so with no node on
// PATH it must be run as `<node> <npm-cli.js>`. Returns [command, ...leadingArgs].
export function npmArgv() {
  const bin = npmBin();
  if (bin === 'npm') return ['npm'];
  let cli = bin; try { cli = fs.realpathSync(bin); } catch { /* keep */ }
  return [process.execPath, cli];
}
const runNpm = (args, opts) => { const [cmd, ...pre] = npmArgv(); return execFileSync(cmd, [...pre, ...args], opts); };

// Where `npm i -g` puts binaries. Resolved once, at install time.
export function globalBinDir() {
  try { return path.join(runNpm(['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(), 'bin'); }
  catch { return null; }
}

export function onPath(bin = 'eag') {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}

export const newer = (a, b) => {
  if (!validVersion(a) || !validVersion(b)) return false;
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

// Only exact stable registry versions can become npm package specifications.
export const validVersion = (v) => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);

// The registry's idea of latest. Short timeout, any failure is "unknown": this runs from a
// hook, and a hook must never wait on the network.
export async function latestVersion({ timeoutMs = 3000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://registry.npmjs.org/${PKG.name}/latest`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const v = (await r.json()).version;
    return validVersion(v) ? v : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// At most one registry call a day, remembered in .state/update.json. Returns the newer
// version when there is one, else null — and never throws.
export async function checkThrottled({ everyMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  let st;
  try { st = readJson(STAMP, {}) ?? {}; } catch { st = {}; }
  if (st.checkedAt && now - st.checkedAt < everyMs) return st.latest && newer(st.latest, VERSION) ? st.latest : null;
  // Offline or a broken registry: keep the last answer rather than forgetting it.
  const latest = (await latestVersion()) ?? st.latest ?? null;
  try { writeJson(STAMP, { checkedAt: now, latest, current: VERSION }, 0o600); } catch { /* read-only state dir */ }
  return latest && newer(latest, VERSION) ? latest : null;
}

// Install a version in place. Only for a global install: an npx cache cannot be updated
// and a dev checkout must never be overwritten by npm.
export function selfUpdate(version, { detached = false, fromNpx = false } = {}) {
  if (!validVersion(version)) return { ok: false, reason: 'expected an exact stable version (major.minor.patch)' };
  if (detached) return { ok: false, reason: 'background installation is disabled; run eag update explicitly' };
  const kind = installKind();
  if (kind === 'dev') return { ok: false, reason: 'installed from a checkout (npm link); update it with git' };
  if (kind === 'npx' && !fromNpx) return { ok: false, reason: 'running from the npx cache; run: npm i -g easy-agnostic' };
  const args = ['i', '-g', '--ignore-scripts', `${PKG.name}@${version}`];
  try {
    return withMutationLock(() => {
      const binDir = globalBinDir();
      if (!binDir) return { ok: false, reason: 'could not determine the npm global prefix; nothing installed' };
      // Shared across EAG_HOME configurations and outside npm's replaced package tree.
      return withLock(path.join(path.dirname(binDir), '.easy-agnostic-update.lock'), () => {
        runNpm(args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
        return { ok: true };
      });
    });
  } catch (e) { return { ok: false, reason: processFailure('npm install', e) }; }
}
