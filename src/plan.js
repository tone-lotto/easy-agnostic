import { scopePaths, assertProjectScope } from './paths.js';
import { loadSource, sourceGuard, targetEnabled, serverAllowed, serverOverrides, secretsMode, validateServer, mergeAgentPolicies } from './source.js';
import { loadState, saveState } from './state.js';
import { planMerge } from './merge.js';
import * as codex from './adapters/codex.js';
import * as claude from './adapters/claude.js';
import { JSON_ADAPTERS } from './adapters/registry.js';
import { exists, backup, deepEqual } from './util.js';
import { withMutationLock } from './lock.js';
import fs from 'node:fs';
import path from 'node:path';

export const TARGETS = {
  'claude-user': { agent: 'claude', scope: 'user', label: 'Claude Code · user (~/.claude.json)' },
  'codex-user': { agent: 'codex', scope: 'user', label: 'Codex · user (~/.codex/config.toml)' },
  'codex-project': { agent: 'codex', scope: 'project', label: 'Codex · project (.codex/config.toml)' },
  ...Object.fromEntries(Object.keys(JSON_ADAPTERS).flatMap(agent => ['user','project'].map(scope => [`${agent}-${scope}`, {agent,scope,label:`${agent} · ${scope}`}]))),
};

export function targetsForScope(scope, root) {
  const ids = Object.keys(TARGETS).filter((id) => scope === 'all' || TARGETS[id].scope === scope);
  // project targets only make sense where a project source exists
  // A colliding project root has no project scope at all: never offer a target that would
  // write the user's own files.
  const proj = scopePaths('project', root);
  return ids.filter((id) => TARGETS[id].scope === 'user' || (!proj.collides && exists(proj.mcp)));
}

export function buildPlan(targetId, { root, prefer = null, warn = () => {} } = {}) {
  const t = TARGETS[targetId];
  if (!t) throw new Error(`unknown target ${targetId}`);
  const user = loadSource(scopePaths('user'));
  const proj = t.scope === 'project' ? loadSource(assertProjectScope(scopePaths('project', root))) : null;
  const guards = [sourceGuard(user.paths), ...(proj ? [sourceGuard(proj.paths)] : [])];
  // A project without its own agents.json must not reset the user's switches: loadSource
  // hands back DEFAULT_AGENTS when the file is missing, and spreading those last would
  // re-enable an agent the user turned off machine-wide.
  const agents = proj ? mergeAgentPolicies(user.agents, proj.hasAgents ? proj.agents : {}) : user.agents;
  const base = { targetId, ...t, root, agents };
  if (!targetEnabled(agents, t.agent)) return { ...base, skipped: `target "${t.agent}" is not enabled in agents.json` };

  // Codex DOES merge global and project mcp_servers (verified on codex-cli 0.153.4: a name
  // in both resolves to the project's). So the project block holds only the project's own
  // servers — repeating the user ones would duplicate every literal into a file inside the
  // repository for nothing.
  const srcServers = t.scope === 'user' ? { ...user.servers } : { ...proj.servers };
  const desired = new Map();
  const errors = [];
  const skippedByPolicy = [];
  for (const [name, src] of Object.entries(srcServers)) {
    if (!serverAllowed(agents, name, t.agent)) { skippedByPolicy.push(name); continue; }
    const errs = validateServer(name, src);
    if (errs.length) { errors.push(...errs); continue; }
    if (t.agent === 'claude') { const ne = claude.nameError(name); if (ne) { errors.push(ne); continue; } }
    try {
      desired.set(name, JSON_ADAPTERS[t.agent] ? JSON_ADAPTERS[t.agent].render(name,src,{overrides:serverOverrides(agents,name,t.agent),secrets:secretsMode(agents,name,t.agent,'literal'),warn}) : t.agent === 'codex'
        ? codex.render(name, src, serverOverrides(agents, name, 'codex'), warn)
        : claude.render(name, src, { secrets: secretsMode(agents, name, 'claude', 'literal'), warn }));
    } catch (e) { errors.push(e.message); }
  }
  const stateDir = t.scope === 'user' ? user.paths.state : proj.paths.state;
  const state = loadState(stateDir, targetId).servers;
  const native = JSON_ADAPTERS[t.agent] ? JSON_ADAPTERS[t.agent].read(t.scope,root,agents[t.agent]) : t.agent === 'codex' ? codex.read(t.scope, root) : claude.read();
  // Damaged markers make the managed region unknowable: refuse to plan rather than guess
  // which text belongs to eag. apply.js turns an error into "not applied", not a crash.
  if (native.damaged) errors.push(`${native.file}: ${native.damaged}`);
  const foreign = new Set([...native.servers.keys()].filter((n) => !Object.hasOwn(state, n)));
  const actions = planMerge({ desired, state, native: native.servers, foreign, locked: native.locked, prefer });
  // Unrendered entry (secrets as ${NAME}); adapters use it for output that must not carry resolved values.
  for (const a of actions) if (Object.hasOwn(srcServers, a.name)) a.source = srcServers[a.name];
  return { ...base, actions, errors, skippedByPolicy, native, stateDir, state, desired, verifySource: () => guards.forEach((guard) => guard()) };
}

export function applyPlan(plan, { dryRun = false, backupDir } = {}) {
  if (dryRun) return applyPlanLocked(plan, { dryRun, backupDir });
  return withMutationLock(() => applyPlanLocked(plan, { dryRun, backupDir }));
}

function applyPlanLocked(plan, { dryRun, backupDir }) {
  if (plan.skipped) return { skipped: plan.skipped };
  if (plan.errors?.length) throw new Error('refusing to apply a plan with validation errors');
  if (plan.scope === 'project') assertProjectScope(scopePaths('project', plan.root));
  plan.verifySource?.();
  const jsonAdapter = JSON_ADAPTERS[plan.agent];
  const freshNative = jsonAdapter ? jsonAdapter.read(plan.scope,plan.root,plan.agents[plan.agent]) : plan.agent === 'codex' ? codex.read(plan.scope, plan.root) : claude.read();
  const unchanged = plan.agent === 'codex' || jsonAdapter ? freshNative.text === plan.native.text
    : deepEqual([...freshNative.servers], [...plan.native.servers]);
  if (!unchanged || !deepEqual(loadState(plan.stateDir, plan.targetId).servers, plan.state)) throw new Error('configuration changed since planning; retry eag apply');
  const newState = Object.assign(Object.create(null), plan.state); // a server named __proto__ must become an own key
  const entries = new Map(); // codex only: what the managed block must contain afterwards
  // The block is regenerated from `entries` alone, so every table already inside it starts
  // in the map. A name the snapshot never heard of (a second machine, a .state restored
  // from dotfiles without it) would otherwise be dropped by the first write that happens
  // for some unrelated reason, while the same run reports it as untouched.
  if (plan.agent === 'codex') {
    for (const name of plan.native.managed) {
      const table = plan.native.servers.get(name);
      if (table) entries.set(name, table);
    }
  }
  for (const a of plan.actions) {
    switch (a.op) {
      case 'create': case 'update': case 'noop':
        if (!a.locked) { newState[a.name] = a.desired; entries.set(a.name, a.desired); }
        break;
      case 'refresh': case 'adopt': {
        // Both mean "the native file wins". It equals desired except under --prefer native,
        // where writing desired would silently undo the choice the user just made.
        if (a.locked) break;
        const keep = a.native ?? a.desired;
        newState[a.name] = keep; entries.set(a.name, keep);
        break;
      }
      case 'conflict':
        // Keep the user's edit and stay in conflict. A locked name lives outside the block,
        // so re-emitting it inside would define the same [mcp_servers.X] table twice and
        // leave Codex with a file it refuses to parse.
        if (!a.locked && a.native) entries.set(a.name, a.native);
        break;
      case 'delete':
        delete newState[a.name];
        entries.delete(a.name);
        break;
      case 'forget':
        // eag stops tracking the name. When the agent still has the table (--prefer native
        // on an entry dropped from the source), leave it exactly where it is.
        delete newState[a.name];
        if (!a.native) entries.delete(a.name);
        break;
      default: break; // unmanaged
    }
  }
  const writes = plan.actions.filter((a) => ['create', 'update', 'delete'].includes(a.op));
  let result;
  if (jsonAdapter) {
    result = jsonAdapter.write(plan.scope,plan.root,writes,{...plan.agents[plan.agent],backupDir:backupDir ?? backupDirFor(plan),dryRun,expectedText:plan.native.text});
  } else if (plan.agent === 'codex') {
    const needsWrite = writes.length > 0 || !plan.native.hasBlock && entries.size > 0;
    if (needsWrite) result = codex.write(plan.scope, plan.root, entries, { backupDir, dryRun, expectedText: plan.native.text });
    else {
      // Nothing to write, but the file may still carry a literal and may have been widened
      // since the last apply.
      const tightened = dryRun ? null : codex.ensureMode(plan.scope, plan.root, entries);
      result = { file: plan.native.file, changed: false, tightened };
    }
  } else {
    if (!dryRun && writes.length) backup(plan.native.file, backupDir ?? backupDirFor(plan), 'claude-user');
    const w = claude.write(writes, { dryRun });
    if (!dryRun && exists(plan.native.file)) fs.chmodSync(plan.native.file, fs.statSync(plan.native.file).mode & 0o600);
    result = { file: plan.native.file, commands: w.commands, failures: w.failures, changed: writes.length > 0 };
    if (!dryRun && writes.length) {
      // Re-read only the names this run actually wrote. Refreshing every name would pull a
      // hand edit that was just reported as a conflict into the snapshot, and the next apply
      // would read it as "the source changed" and overwrite the edit it had refused to touch.
      const written = new Set(writes.map((a) => a.name));
      for (const f of w.failures) {
        written.delete(f.name);
        // A delete that failed left the server in place. Keeping it in the snapshot is what
        // makes the next apply plan the delete again instead of calling it foreign forever.
        if (Object.hasOwn(plan.state, f.name)) newState[f.name] = plan.state[f.name];
        else delete newState[f.name];
      }
      const fresh = claude.read();
      for (const name of written) if (fresh.servers.has(name)) newState[name] = fresh.servers.get(name);
    }
  }
  if (!dryRun) saveState(plan.stateDir, plan.targetId, newState);
  return result;
}

export function backupDirFor(plan) {
  return path.join(plan.stateDir, 'backup');
}
