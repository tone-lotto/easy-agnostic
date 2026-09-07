import { projectRoot } from '../paths.js';
import { buildPlan, applyPlan, targetsForScope, backupDirFor, TARGETS } from '../plan.js';
import { hasWrites } from '../merge.js';
import { c } from '../util.js';
import { printPlan } from './status.js';

export async function run(_args, flags) {
  const root = projectRoot();
  const scope = flags.scope || 'user';
  if (!['user', 'project', 'all'].includes(scope)) throw new Error(`--scope must be user, project or all (got "${scope}")`);
  const dry = !!flags['dry-run'];
  const prefer = flags.prefer || null;
  if (prefer && !['source', 'native'].includes(prefer)) throw new Error('--prefer must be source or native');
  const agentIds = [...new Set(Object.values(TARGETS).map((t) => t.agent))];
  const only = flags.target ? String(flags.target).split(',') : null;
  if (only) for (const a of only) if (!agentIds.includes(a)) throw new Error(`--target ${a} is not a write target (known: ${agentIds.join(', ')})`);
  const warnings = new Set();
  let conflicts = 0;
  let errors = 0;
  let failures = 0;
  for (const id of targetsForScope(scope, root)) {
    if (only && !only.includes(TARGETS[id].agent)) continue;
    let printed = false;
    try {
      const plan = buildPlan(id, { root, prefer, warn: (m) => warnings.add(m) });
      printPlan(plan, { verbose: false });
      printed = true;
      if (plan.skipped) continue;
      errors += plan.errors.length;
      conflicts += plan.actions.filter((a) => a.op === 'conflict').length;
      if (plan.errors.length) { console.log(`  ${c.bad('not applied: fix the errors above')}`); continue; }
      const res = applyPlan(plan, { dryRun: dry, backupDir: backupDirFor(plan) });
      if (dry) {
        if (res.commands?.length) console.log(`  ${c.dim('would run:')}\n    ${res.commands.map((a) => `claude ${a.map((x) => (x.includes(' ') || x.startsWith('{') ? JSON.stringify(x) : x)).join(' ')}`).join('\n    ')}`);
        else if (res.changed) console.log(`  ${c.dim(`would rewrite managed block in ${res.file}`)}`);
        else console.log(`  ${c.dim('no changes')}`);
      } else if (hasWrites(plan.actions) || res.changed) {
        console.log(`  ${c.ok('applied')} ${res.file}${res.backup ? c.dim(` (backup: ${res.backup})`) : ''}`);
      } else console.log(`  ${c.dim('nothing to write; state refreshed')}`);
      if (res.failures?.length) {
        for (const f of res.failures) {
          console.log(`  ${c.bad('failed  ')} ${f.name}: ${f.error}`);
          // An update is remove-then-add. If the add is what failed, the entry is gone from
          // the agent and only the source (with ${NAME} intact) can put it back.
          const act = plan.actions.find((a) => a.name === f.name);
          if (f.op === 'add-json' && act?.op === 'update') {
            console.log(`    ${c.dim(`removed before the add failed; restore with: claude mcp add-json ${f.name} '${JSON.stringify(act.source ?? {})}' -s user`)}`);
          }
        }
        failures += res.failures.length;
      }
    } catch (e) {
      // One target that throws (unparsable TOML, a damaged managed block, an I/O error)
      // must not take the remaining targets with it.
      if (!printed) console.log(`\n${c.bold(TARGETS[id].label)}`);
      console.log(`  ${c.bad('error   ')} ${e.message}`);
      if (process.env.EAG_DEBUG) console.error(e);
      errors++;
    }
  }
  for (const w of warnings) console.log(`${c.warn('warn')} ${w}`);
  if (conflicts) console.log(`\n${c.bad(`${conflicts} conflict(s) left untouched.`)} Resolve with --prefer source|native, or eag adopt, or eag mcp target <name> <agent> off.`);
  if (failures) console.log(`\n${c.bad(`${failures} write(s) failed.`)} See "failed" above; a retry picks them up again.`);
  if (dry) console.log(`\n${c.dim('dry run: nothing written')}`);
  return errors || failures ? 1 : conflicts ? 2 : 0;
}
