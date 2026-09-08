import { c } from '../util.js';
import path from 'node:path';
import { VERSION, installKind, latestVersion, selfUpdate, newer, globalBinDir } from '../update.js';
import { runCommand } from '../process.js';
import { processFailure } from '../redact.js';
import { setAutoUpdate, updateStatus } from '../auto-update.js';

// `eag update`: install the latest version in place and refresh what depends on the
// installed files (the launcher, the shell file, the shipped skill).
export async function run(args, flags) {
  const automatic = args[0] === 'auto' && args.length === 2 && ['on', 'off'].includes(args[1]);
  const status = args[0] === 'status' && args.length === 1;
  if ((args.length && !automatic && !status) || (args.length && (flags.check || flags.force)) || (flags.json && !status)) {
    throw new Error('usage: eag update [--check] [--force] | eag update auto on|off | eag update status [--json]');
  }
  if (status) {
    const st = updateStatus();
    const checked = new Date(st.last?.attemptedAt);
    const checkedAt = Number.isFinite(checked.getTime()) ? checked.toISOString() : 'unknown';
    console.log(flags.json ? JSON.stringify(st, null, 2) : [
      `automatic updates: ${st.enabled ? 'on' : 'off'} (current ${st.current})`,
      st.line ? `approved line: ${st.line}.x; incompatible releases require eag update` : null,
      st.last ? `last attempt: ${checkedAt} — ${st.last.result}${st.last.latest ? ` (latest ${st.last.latest})` : ''}` : 'no automatic check recorded',
      st.pending ? `pending: ${st.pending}` : null, st.error || st.warning || st.last?.error,
      st.locks?.length ? `update locks: ${st.locks.join(', ')}; see docs/updates.md if these remain after all eag processes exit` : null,
    ].filter(Boolean).join('\n'));
    return st.error ? 1 : 0;
  }
  // Update has its own locks. Respect the global preview flag here as well.
  if (flags['dry-run']) { console.log('dry run: no update or policy change performed'); return 0; }
  if (automatic) {
    const policy = setAutoUpdate(args[1] === 'on');
    console.log(policy.enabled
      ? `automatic updates enabled for approved ${policy.line}.x releases; checked at most daily after apply or agent launch`
      : 'automatic updates disabled; the current installed version is retained');
    return 0;
  }
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
  const binDir = globalBinDir();
  if (!binDir) throw new Error('could not determine the npm global prefix; nothing installed');
  console.log(`${c.dim('installing')} easy-agnostic ${latest} …`);
  const r = selfUpdate(latest);
  if (!r.ok) { console.log(`${c.bad('failed')} ${r.reason}`); return 1; }
  console.log(`${c.ok('updated')} ${VERSION} → ${latest}`);
  // The new version's files, not this one's: hand over to the installed binary.
  try { runCommand(process.execPath, [path.join(binDir, 'eag'), 'hook', 'install'], { stdio: 'inherit', timeout: 60000 }); }
  catch (e) {
    console.log(`${c.warn('installed, but hook refresh failed')}: ${processFailure('eag hook install', e)}. Run eag hook install again.`);
    return 1;
  }
  return 0;
}
