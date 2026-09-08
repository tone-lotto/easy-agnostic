import path from 'node:path';
import { projectRoot, scopePaths } from '../paths.js';
import { readJson, writeJson, exists, c } from '../util.js';
import { buildPlan, applyPlan, targetsForScope, backupDirFor, TARGETS } from '../plan.js';
import { hasWrites } from '../merge.js';
import { loadSource, saveMcp } from '../source.js';
import { setSecret, resolveSecret } from '../secrets.js';
import { printPlan, toJson } from './status.js';
import { extractSecrets } from './adopt.js';
import { refreshInit } from '../shell.js';
import * as codex from '../adapters/codex.js';
import { JSON_ADAPTERS } from '../adapters/registry.js';
import { installSkill } from './hook.js';
import { syncInstructions, instructionPaths } from '../instructions.js';
import { syncLinks } from '../skill-policy.js';

// `--prefer native` used to record the native value only in the snapshot. The next plain
// apply then saw state == native != source and called it "source changed", and overwrote
// the edit the user had just chosen to keep. "Native wins" has to mean the SOURCE changes:
// the native entry is translated back (Codex table -> source shape; a resolved secret ->
// its ${NAME}) and written into mcp.json, exactly as `eag adopt` would.
function keepNativeInSource(plan, actions, { say }) {
  const kept = actions.filter((a) => a.op === 'refresh' && a.desired && a.native && / \(prefer native\)$/.test(a.reason));
  if (!kept.length) return;
  const paths = scopePaths(plan.scope, plan.root);
  const src = loadSource(paths);
  const servers = { ...src.servers };
  for (const a of kept) {
    const raw = JSON_ADAPTERS[plan.agent] ? JSON_ADAPTERS[plan.agent].toSource(a.native).entry : plan.agent === 'codex' ? codex.toSource(a.native).entry : a.native;
    const { entry, secrets } = extractSecrets(a.name, raw);
    for (const [sn, val] of secrets) if (resolveSecret(sn) === undefined) setSecret(sn, val);
    servers[a.name] = entry;
    say(`  ${c.ok('kept    ')} ${a.name}: native version written back into ${paths.mcp}`);
  }
  saveMcp(paths, servers, src.mcp);
}

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
  const log = console.log;
  try { return await runApply(_args, flags); }
  finally { console.log = log; }
}

async function runApply(_args, flags) {
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
  const json = flags.json ? { targets: [], warnings: [] } : null;
  if (json) console.log = (...a) => { if (!json.captured) json.captured = []; json.captured.push(a.join(' ')); }; // never mix text into JSON
  // A missing source used to apply as "nothing", exit 0, which is the wrong kind of quiet.
  const hasMcp = exists(scopePaths('user').mcp) || (!scopePaths('project',root).collides && exists(scopePaths('project',root).mcp));
  // Default launch apply also wires this project's explicitly shared skills, like
  // enrolled instructions. An explicit --scope user opts out of project wiring.
  const hasProjectSkills = flags.scope !== 'user' && ['skills','skill-library'].some(dir => exists(path.join(root, '.agents', dir))) && !scopePaths('project', root).collides;
  const hasUserSkills = flags.scope !== 'project' && ['skills','skill-library'].some(dir => exists(path.join(scopePaths('user').root, dir)));
  if (!hasMcp && !exists(instructionPaths(root).state) && !hasProjectSkills && !hasUserSkills) {
    const msg = `${scopePaths('user').mcp} does not exist. Run: eag init (or eag setup)`;
    if (json) { process.stdout.write(`${JSON.stringify({ error: 'no source', hint: 'eag init' })}\n`); return 1; }
    process.stdout.write(`${c.bad('no source')} ${msg}\n`);
    return 1;
  }
  const agentIds = [...new Set(Object.values(TARGETS).map((t) => t.agent))];
  const only = flags.target ? String(flags.target).split(',') : null;
  if (only) for (const a of only) if (!agentIds.includes(a)) throw new Error(`--target ${a} is not a write target (known: ${agentIds.join(', ')})`);
  const warnings = new Set();
  let conflicts = 0;
  let errors = 0;
  let failures = 0;
  for (const skillScope of [...(hasUserSkills ? ['user'] : []), ...(hasProjectSkills ? ['project'] : [])]) {
    try {
      const links = syncLinks({ scope: skillScope, root, dryRun: dry, target: only });
      if (json) json.skills = [...(json.skills ?? []), ...links.map(link => ({...link, scope:skillScope}))];
      for (const link of links) {
        if (link.op === 'conflict') { conflicts++; tell(`skills: ${link.message}`); }
        else if (link.op === 'blocked') { if (json) json.warnings.push(link.message); tell(`skills: ${link.message}`); }
        else say(`skills: ${dry ? 'would ' : ''}${link.op}: ${link.message}`);
      }
    } catch (e) {
      errors++;
      if (json) json.skills = [{ op: 'error', message: e.message }];
      tell(`skills: ${e.message}`);
    }
  }
  // Enrollment is explicit (instructions or doctor --fix). Launch hooks must not
  // start mirroring files in an unrelated repository just because it was opened.
  try {
    const instructions = syncInstructions(root, { dryRun: dry, trackedOnly: true });
    if (json) json.instructions = instructions;
    if (instructions.op === 'conflict') { conflicts++; tell(`instructions: ${instructions.message}`); }
    else if (instructions.op !== 'skipped' && instructions.op !== 'noop') say(`instructions: ${instructions.message}`);
  } catch (e) {
    errors++;
    if (json) json.instructions = { op: 'error', message: e.message };
    tell(`instructions: ${e.message}`);
  }
  for (const id of hasMcp ? targetsForScope(scope, root) : []) {
    if (only && !only.includes(TARGETS[id].agent)) continue;
    let printed = false;
    try {
      const plan = buildPlan(id, { root, prefer, warn: (m) => warnings.add(m) });
      const jt = json ? toJson(plan) : null;
      if (jt) json.targets.push(jt);
      if (!quiet && !json) { printPlan(plan, { verbose: false }); printed = true; }
      if (plan.skipped) continue;
      errors += plan.errors.length;
      conflicts += plan.actions.filter((a) => a.op === 'conflict').length;
      if (plan.errors.length) {
        if (quiet) for (const e of plan.errors) problems.push(`${c.bad('eag')} ${TARGETS[id].agent}: ${e}`);
        else console.log(`  ${c.bad('not applied: fix the errors above')}`);
        continue;
      }
      const res = applyPlan(plan, { dryRun: dry, backupDir: backupDirFor(plan) });
      if (!dry) keepNativeInSource(plan, plan.actions, { say });
      if (jt) Object.assign(jt, { applied: !dry && (hasWrites(plan.actions) || !!res.changed), dryRun: dry, backup: res.backup ?? null, failures: res.failures ?? [] });
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
            tell(`    ${c.dim(f.rollback === 'restored' ? 'previous configuration restored; retry eag apply after fixing the error' : 'replacement and recovery did not complete; review the private backup and retry eag apply')}`);
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
  if (conflicts) tell(`${quiet ? '' : '\n'}${c.bad(`${conflicts} conflict(s) left untouched.`)} For MCP use ${c.bold('eag apply --prefer source|native')}; for instructions use ${c.bold('eag instructions --prefer agents|claude')}; for skills inspect the reported paths (no automatic winner).`);
  if (failures && !quiet) console.log(`\n${c.bad(`${failures} write(s) failed.`)} See "failed" above; a retry picks them up again.`);
  if (dry) say(`\n${c.dim('dry run: nothing written')}`);
  if (quiet && !dry) reportQuiet(problems);
  // Keep the generated shell file in step with what is installed, so an agent added after
  // `eag hook install` gets wrapped without the user having to remember this exists.
  if (!dry) { try { refreshInit(); } catch { /* never fail an apply over the shell file */ } }
  // Same for eag's own skill: a background update replaces the package, and the copy in
  // ~/.agents/skills should say what the installed version does.
  if (!dry) { try { if (exists(path.join(scopePaths('user').root, 'skills', 'eag', '.eag-managed'))) installSkill(); } catch { /* ditto */ } }
  const code = errors || failures ? 1 : conflicts ? 3 : 0;
  if (json) { json.warnings = [...warnings]; json.exit = code; process.stdout.write(`${JSON.stringify(json, null, 2)}\n`); }
  return code;
}
