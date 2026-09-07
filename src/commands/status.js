import { projectRoot } from '../paths.js';
import { buildPlan, targetsForScope, TARGETS } from '../plan.js';
import { hasDrift, summarize } from '../merge.js';
import { c } from '../util.js';
import * as claude from '../adapters/claude.js';

const ICON = { create: c.ok('+ create '), update: c.ok('~ update '), delete: c.ok('- delete '), adopt: c.ok('= adopt  '), refresh: c.dim('= refresh'), forget: c.dim('- forget '), noop: c.dim('  ok     '), unmanaged: c.dim('  foreign'), conflict: c.bad('! conflict') };

export function printPlan(plan, { verbose = true } = {}) {
  console.log(`\n${c.bold(TARGETS[plan.targetId].label)}`);
  if (plan.skipped) { console.log(`  ${c.dim(plan.skipped)}`); return; }
  for (const e of plan.errors) console.log(`  ${c.bad('error   ')} ${e}`);
  for (const a of plan.actions) {
    if (a.op === 'noop' && !verbose) continue;
    if (a.op === 'unmanaged' && !verbose) continue;
    console.log(`  ${ICON[a.op] || a.op} ${a.name}${a.locked && a.op !== 'noop' ? c.dim(' [locked]') : ''} ${c.dim(a.reason)}`);
  }
  if (plan.skippedByPolicy.length) console.log(`  ${c.dim(`skipped by agents.json: ${plan.skippedByPolicy.join(', ')}`)}`);
  const s = summarize(plan.actions);
  console.log(`  ${c.dim(Object.entries(s).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty')}`);
}

export async function run(_args, flags) {
  const root = projectRoot();
  const scope = flags.scope || 'all';
  if (!['user', 'project', 'all'].includes(scope)) throw new Error(`--scope must be user, project or all (got "${scope}")`);
  const warnings = new Set();
  let drift = false;
  let errors = false;
  for (const id of targetsForScope(scope, root)) {
    try {
      const plan = buildPlan(id, { root, warn: (m) => warnings.add(m) });
      printPlan(plan, { verbose: !flags.quiet });
      if (!plan.skipped) { drift ||= hasDrift(plan.actions); errors ||= plan.errors.length > 0; }
    } catch (e) {
      console.log(`\n${c.bold(TARGETS[id].label)}`);
      console.log(`  ${c.bad('error   ')} ${e.message}`);
      if (process.env.EAG_DEBUG) console.error(e);
      errors = true;
    }
  }
  if (scope !== 'user') {
    const local = Object.keys(claude.readLocal(root));
    console.log(`\n${c.bold('Claude Code · project')}`);
    console.log(`  ${c.dim('.mcp.json is the source; Claude and Pi read it as is')}`);
    if (local.length) console.log(`  ${c.dim(`local-scope entries in ~/.claude.json for this project (not managed): ${local.join(', ')}. Import with: eag adopt claude --scope project`)}`);
  }
  for (const w of warnings) console.log(`${c.warn('warn')} ${w}`);
  if (flags['exit-code']) return errors ? 1 : drift ? 2 : 0;
  return 0;
}
