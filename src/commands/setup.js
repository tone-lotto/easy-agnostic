import { c } from '../util.js';
import { run as initRun } from './init.js';
import { run as adoptRun } from './adopt.js';
import { run as applyRun } from './apply.js';
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

  await step('1/5 init', () => initRun([], flags.project ? { project: true } : {}));
  await step('2/5 adopt claude', () => adoptRun(['claude'], { scope }));
  await step('3/5 adopt codex', () => adoptRun(['codex'], { scope }));
  await step('4/5 apply', () => applyRun([], { scope }));
  await step('5/5 doctor --fix', () => doctorRun([], { fix: true }));

  console.log(`\n${ok ? c.ok('setup done') : c.warn('setup finished; see the warnings/errors above')}. ${c.dim('eag status')} shows drift any time, ${c.dim('eag mcp add')} to add a server.`);
  return ok ? 0 : 1;
}
