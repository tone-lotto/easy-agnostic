import { c } from '../util.js';
import { VERSION, installKind, latestVersion, selfUpdate, newer } from '../update.js';
import { run as hookRun } from './hook.js';

// `eag update`: install the latest version in place and refresh what depends on the
// installed files (the launcher, the shell file, the shipped skill).
export async function run(_args, flags) {
  const kind = installKind();
  const latest = await latestVersion({ timeoutMs: 8000 });
  const state = !latest ? 'unknown' : newer(latest, VERSION) ? 'behind' : latest === VERSION ? 'current' : 'ahead';
  if (flags.check) {
    console.log({ unknown: `${c.dim('could not reach the registry')} (current ${VERSION})`, behind: `${c.warn('update available')} ${VERSION} → ${latest}`, current: `${c.ok('up to date')} ${VERSION}`, ahead: `${c.ok('ahead of the registry')} ${VERSION} (registry has ${latest})` }[state]);
    return 0;
  }
  if (state === 'unknown') { console.log(`${c.bad('could not reach the registry')}; nothing changed (current ${VERSION})`); return 1; }
  if (state !== 'behind' && !flags.force) { console.log(`${c.ok(state === 'ahead' ? 'ahead of the registry' : 'up to date')} ${VERSION}`); return 0; }
  if (kind === 'dev') { console.log(`${c.warn('dev checkout')}: this eag is a linked checkout; update it with git (registry has ${latest})`); return 0; }
  if (kind === 'npx') { console.log(`${c.warn('npx cache')}: run ${c.bold('npm i -g easy-agnostic')} once; then eag update works in place`); return 1; }
  console.log(`${c.dim('installing')} easy-agnostic ${latest} …`);
  const r = selfUpdate(latest);
  if (!r.ok) { console.log(`${c.bad('failed')} ${r.reason}`); return 1; }
  console.log(`${c.ok('updated')} ${VERSION} → ${latest}`);
  // The new version's files, not this one's: hand over to the installed binary.
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('eag', ['hook', 'install'], { stdio: 'inherit' }); } catch { await hookRun(['install'], {}); }
  return 0;
}
