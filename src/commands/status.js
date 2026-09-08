import { projectRoot, scopePaths } from '../paths.js';
import { buildPlan, targetsForScope, TARGETS } from '../plan.js';
import { hasDrift, summarize } from '../merge.js';
import { c, exists, refsIn } from '../util.js';
import { redactConfig } from '../redact.js';
import { listSecrets, resolveSecret } from '../secrets.js';
import * as claude from '../adapters/claude.js';
import { syncInstructions, instructionPaths } from '../instructions.js';

// Known secret values, for redacting anything native we print or serialise.
function secretPairs(plan) { return [...new Set([...listSecrets(), ...refsIn(plan?.actions?.map((a) => a.source))])].map((n) => [n, resolveSecret(n)]); }

// A conflict line that does not show the two sides makes --prefer a blind choice.
function sides(a, pairs) {
  const src = a.source ? JSON.stringify(redactConfig(a.source, pairs)) : '(absent)';
  const nat = a.native ? JSON.stringify(redactConfig(a.native, pairs)) : '(absent)';
  return `\n      source: ${src}\n      native: ${nat}`;
}

export function toJson(plan, pairs = secretPairs(plan)) {
  const base = { target: plan.targetId, agent: plan.agent, scope: plan.scope, file: plan.native?.file ?? null };
  if (plan.skipped) return { ...base, skipped: plan.skipped };
  return {
    ...base,
    errors: plan.errors,
    skippedByPolicy: plan.skippedByPolicy,
    actions: plan.actions.map((a) => ({
      name: a.name, op: a.op, reason: a.reason, locked: a.locked, foreign: a.foreign,
      source: a.source ? redactConfig(a.source, pairs) : null, native: a.native ? redactConfig(a.native, pairs) : null,
    })),
    summary: summarize(plan.actions),
  };
}

const ICON = { create: c.ok('+ create '), update: c.ok('~ update '), delete: c.ok('- delete '), adopt: c.ok('= adopt  '), refresh: c.dim('= refresh'), forget: c.dim('- forget '), noop: c.dim('  ok     '), unmanaged: c.dim('  foreign'), conflict: c.bad('! conflict') };

export function printPlan(plan, { verbose = true } = {}) {
  console.log(`\n${c.bold(TARGETS[plan.targetId].label)}`);
  if (plan.skipped) { console.log(`  ${c.dim(plan.skipped)}`); return; }
  for (const e of plan.errors) console.log(`  ${c.bad('error   ')} ${e}`);
  const pairs = plan.actions.some((a) => a.op === 'conflict') ? secretPairs(plan) : [];
  for (const a of plan.actions) {
    if (a.op === 'noop' && !verbose) continue;
    if (a.op === 'unmanaged' && !verbose) continue;
    console.log(`  ${ICON[a.op] || a.op} ${a.name}${a.locked && a.op !== 'noop' ? c.dim(' [locked]') : ''} ${c.dim(a.reason)}${a.op === 'conflict' ? c.dim(sides(a, pairs)) : ''}`);
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
  let conflict = false;
  let errors = false;
  const json = flags.json ? { targets: [], warnings: [] } : null;
  // A missing source used to read as "empty", and the summary said nothing was wrong.
  const hasMcp = exists(scopePaths('user').mcp) || (!scopePaths('project',root).collides && exists(scopePaths('project',root).mcp));
  if (!hasMcp && !exists(instructionPaths(root).state)) {
    if (json) { console.log(JSON.stringify({ error: 'no source', hint: 'eag init' })); return 1; }
    console.log(`${c.bad('no source')} ${scopePaths('user').mcp} does not exist. Run: ${c.bold('eag init')} (or eag setup)`);
    return 1;
  }
  try {
    const instructions = syncInstructions(root, { dryRun: true, trackedOnly: true });
    if (json) json.instructions = instructions;
    else if (instructions.op !== 'skipped') console.log(`instructions: ${instructions.message}`);
    drift ||= ['sync', 'enroll'].includes(instructions.op);
    conflict ||= instructions.op === 'conflict';
  } catch (e) {
    errors = true;
    if (json) json.instructions = { op: 'error', message: e.message };
    else console.log(`instructions: ${e.message}`);
  }
  for (const id of hasMcp ? targetsForScope(scope, root) : []) {
    try {
      const plan = buildPlan(id, { root, warn: (m) => warnings.add(m) });
      if (json) json.targets.push(toJson(plan)); else printPlan(plan, { verbose: !flags.quiet });
      if (!plan.skipped) {
        drift ||= hasDrift(plan.actions);
        conflict ||= plan.actions.some((a) => a.op === 'conflict');
        errors ||= plan.errors.length > 0;
      }
    } catch (e) {
      if (json) json.targets.push({ target: id, error: e.message });
      else { console.log(`\n${c.bold(TARGETS[id].label)}`); console.log(`  ${c.bad('error   ')} ${e.message}`); }
      if (process.env.EAG_DEBUG) console.error(e);
      errors = true;
    }
  }
  const code = errors ? 1 : conflict ? 3 : drift ? 2 : 0;
  if (json) {
    json.warnings = [...warnings];
    json.exit = code;
    console.log(JSON.stringify(json, null, 2));
    return flags['exit-code'] ? code : 0;
  }
  if (hasMcp && scope !== 'user') {
    const local = Object.keys(claude.readLocal(root));
    console.log(`\n${c.bold('Claude Code · project')}`);
    console.log(`  ${c.dim('.mcp.json is the source; Claude and Pi read it as is')}`);
    if (local.length) console.log(`  ${c.dim(`local-scope entries in ~/.claude.json for this project (not managed): ${local.join(', ')}. Import with: eag adopt claude --scope project`)}`);
  }
  for (const w of warnings) console.log(`${c.warn('warn')} ${w}`);
  if (conflict) console.log(`\n${c.bad('conflict:')} for MCP use ${c.bold('eag apply --prefer source|native')}; for instructions use ${c.bold('eag instructions --prefer agents|claude')}.`);
  if (flags['exit-code']) return code;
  return 0;
}
