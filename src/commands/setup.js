import { c } from '../util.js';
import { run as initRun } from './init.js';
import { run as adoptRun } from './adopt.js';
import { run as applyRun } from './apply.js';
import { run as hookRun } from './hook.js';
import { run as doctorRun } from './doctor.js';


// The one-command path for the common case: detect what's installed, import what each
// agent already has, sync it everywhere, repair the non-MCP wiring. Same primitives as
// init/adopt/apply/doctor --fix, run in the order that makes them converge; nothing here
// bypasses the 3-way merge or the never-clobber guarantees those already have, so it is
// as safe to run again later as running each step by hand.
export async function run(_args, flags) {
  const scope = flags.project ? 'project' : 'user';
  let ok = true;
  const step = async (label, fn) => {
    console.log(`\n${c.bold(label)}`);
    try { if (await fn()) ok = false; }
    catch (e) { console.log(`  ${c.bad('error')} ${e.message}`); ok = false; }
  };

  await step('1/8 init', () => initRun([], flags.project ? { project: true } : {}));
  await step('2/8 adopt claude', () => adoptRun(['claude'], { scope }));
  await step('3/8 adopt codex', () => adoptRun(['codex'], { scope }));
  await step('4/8 apply', () => applyRun([], { scope }));
  // Skills only flow outward from ~/.agents/skills; anything one agent keeps to itself is
  // moved there so the others get it. A name clash is reported, never decided.
  await step('5/8 adopt skills', () => (scope === 'project'
    ? console.log(`  ${c.dim('skipped in project scope')}`)
    : adoptRun(['skills'], {})));
  // The one place the promise does not hold on its own: servers Claude keeps per project in
  // ~/.claude.json, which no other agent can see. This writes inside repositories the user
  // did not name, so it reports every one and --no-projects turns it off.
  await step('6/8 make projects agnostic', () => (scope === 'project' || flags['no-projects']
    ? console.log(`  ${c.dim(flags['no-projects'] ? 'skipped: --no-projects' : 'skipped in project scope')}`)
    : adoptRun(['claude'], { 'all-projects': true })));
  // What turns "synced right now" into "synced from now on": a shell wrapper for terminal
  // launches and a SessionStart hook for app and IDE launches. Machine-level, so project
  // scope skips it.
  await step('7/8 hook install', () => (scope === 'project'
    ? console.log(`  ${c.dim('skipped: sync-on-launch is machine-level; run eag hook install once')}`)
    : hookRun(['install'], {})));
  await step('8/8 doctor --fix', () => doctorRun([], { fix: true }));

  console.log(`\n${ok ? c.ok('setup done') : c.warn('setup finished; see the warnings/errors above')}. ${c.dim('eag status')} shows drift any time, ${c.dim('eag mcp add')} to add a server.`);
  return ok ? 0 : 1;
}
