import path from 'node:path';
import { projectRoot, scopePaths } from '../paths.js';
import { readJson, writeJson } from '../util.js';
import { buildPlan, applyPlan, targetsForScope, backupDirFor, TARGETS } from '../plan.js';
import { hasWrites } from '../merge.js';
import { c } from '../util.js';
import { printPlan } from './status.js';
import { refreshInit } from '../shell.js';

// --quiet runs on every agent launch, so a problem that cannot be fixed by waiting — an
// entry the agent's own CLI refuses, a conflict the user has not resolved yet — would print
// the same line forever and train them to ignore it. Report a problem when the set of
// problems CHANGES, and stay quiet until it does. `eag status` and `eag doctor` always show
// everything, and the reminder below says so.
function reportQuiet(problems) {
  const file = path.join(scopePaths('user').state, 'quiet.json');
  const seen = readJson(file, { problems: [] }).problems;
  const now = problems.map((p) => p.replace(/\x1b\[[0-9;]*m/g, ''));
  const same = now.length === seen.length && now.every((p, i) => p === seen[i]);
  try { writeJson(file, { problems: now }, 0o600); } catch { /* a read-only state dir must not break the launch */ }
  if (!problems.length || same) return;
  for (const p of problems) console.log(p);
  console.log(c.dim('This is printed once; run eag status to see it again.'));
}

export async function run(_args, flags) {
  const root = projectRoot();
  const scope = flags.scope || 'user';
  if (!['user', 'project', 'all'].includes(scope)) throw new Error(`--scope must be user, project or all (got "${scope}")`);
  const dry = !!flags['dry-run'];
  // --quiet is for the shell wrapper, which runs on every agent launch: say nothing when
  // there is nothing to say, but never swallow a conflict, an error or a failed write.
  const quiet = !!flags.quiet;
  const say = (...a) => { if (!quiet) console.log(...a); };
  // In quiet mode problems are collected rather than printed as they happen: see the
  // comment on reportQuiet() below for why a chronic one must not shout on every launch.
  const problems = [];
  const tell = (line) => { if (quiet) problems.push(line); else console.log(line); };
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
      if (!quiet) { printPlan(plan, { verbose: false }); printed = true; }
      if (plan.skipped) continue;
      errors += plan.errors.length;
      conflicts += plan.actions.filter((a) => a.op === 'conflict').length;
      if (plan.errors.length) {
        if (quiet) for (const e of plan.errors) problems.push(`${c.bad('eag')} ${TARGETS[id].agent}: ${e}`);
        else console.log(`  ${c.bad('not applied: fix the errors above')}`);
        continue;
      }
      const res = applyPlan(plan, { dryRun: dry, backupDir: backupDirFor(plan) });
      if (dry) {
        if (res.commands?.length) say(`  ${c.dim('would run:')}\n    ${res.commands.map((a) => `claude ${a.map((x) => (x.includes(' ') || x.startsWith('{') ? JSON.stringify(x) : x)).join(' ')}`).join('\n    ')}`);
        else if (res.changed) say(`  ${c.dim(`would rewrite managed block in ${res.file}`)}`);
        else say(`  ${c.dim('no changes')}`);
      } else if (hasWrites(plan.actions) || res.changed) {
        say(`  ${c.ok('applied')} ${res.file}${res.backup ? c.dim(` (backup: ${res.backup})`) : ''}`);
      } else say(`  ${c.dim('nothing to write; state refreshed')}`);
      if (res.failures?.length) {
        for (const f of res.failures) {
          tell(quiet ? `${c.bad('eag')} ${f.name}: ${f.error}` : `  ${c.bad('failed  ')} ${f.name}: ${f.error}`);
          // An update is remove-then-add. If the add is what failed, the entry is gone from
          // the agent and only the source (with ${NAME} intact) can put it back.
          const act = plan.actions.find((a) => a.name === f.name);
          if (f.op === 'add-json' && act?.op === 'update') {
            tell(`    ${c.dim(`removed before the add failed; restore with: claude mcp add-json ${f.name} '${JSON.stringify(act.source ?? {})}' -s user`)}`);
          }
        }
        failures += res.failures.length;
      }
    } catch (e) {
      // One target that throws (unparsable TOML, a damaged managed block, an I/O error)
      // must not take the remaining targets with it.
      if (!printed && !quiet) console.log(`\n${c.bold(TARGETS[id].label)}`);
      tell(`  ${c.bad(quiet ? 'eag error' : 'error   ')} ${e.message}`);
      if (process.env.EAG_DEBUG) console.error(e);
      errors++;
    }
  }
  for (const w of warnings) say(`${c.warn('warn')} ${w}`);
  if (conflicts) tell(`${quiet ? '' : '\n'}${c.bad(`${conflicts} conflict(s) left untouched.`)} Resolve with ${c.bold('eag apply --prefer source|native')}, ${c.bold('eag adopt')}, or ${c.bold('eag mcp target <name> <agent> off')}.`);
  if (failures && !quiet) console.log(`\n${c.bad(`${failures} write(s) failed.`)} See "failed" above; a retry picks them up again.`);
  if (dry) say(`\n${c.dim('dry run: nothing written')}`);
  if (quiet && !dry) reportQuiet(problems);
  // Keep the generated shell file in step with what is installed, so an agent added after
  // `eag hook install` gets wrapped without the user having to remember this exists.
  if (!dry) { try { refreshInit(); } catch { /* never fail an apply over the shell file */ } }
  return errors || failures ? 1 : conflicts ? 2 : 0;
}
