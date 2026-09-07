import { scopePaths } from './paths.js';
import { loadSource, targetEnabled, serverAllowed, serverOverrides, secretsMode, validateServer } from './source.js';
import { loadState, saveState } from './state.js';
import { planMerge } from './merge.js';
import * as codex from './adapters/codex.js';
import * as claude from './adapters/claude.js';
import { exists } from './util.js';
import path from 'node:path';

export const TARGETS = {
  'claude-user': { agent: 'claude', scope: 'user', label: 'Claude Code · user (~/.claude.json)' },
  'codex-user': { agent: 'codex', scope: 'user', label: 'Codex · user (~/.codex/config.toml)' },
  'codex-project': { agent: 'codex', scope: 'project', label: 'Codex · project (.codex/config.toml)' },
};

export function targetsForScope(scope, root) {
  const ids = Object.keys(TARGETS).filter((id) => scope === 'all' || TARGETS[id].scope === scope);
  // project targets only make sense where a project source exists
  return ids.filter((id) => TARGETS[id].scope === 'user' || exists(scopePaths('project', root).mcp));
}

function mergeAgents(user, project) {
  return {
    targets: { ...(user.targets || {}), ...(project.targets || {}) },
    servers: { ...(user.servers || {}), ...(project.servers || {}) },
    claude: { ...(user.claude || {}), ...(project.claude || {}) },
    codex: { ...(user.codex || {}), ...(project.codex || {}) },
  };
}

export function buildPlan(targetId, { root, prefer = null, warn = () => {} } = {}) {
  const t = TARGETS[targetId];
  if (!t) throw new Error(`unknown target ${targetId}`);
  const user = loadSource(scopePaths('user'));
  const proj = t.scope === 'project' ? loadSource(scopePaths('project', root)) : null;
  // A project without its own agents.json must not reset the user's switches: loadSource
  // hands back DEFAULT_AGENTS when the file is missing, and spreading those last would
  // re-enable an agent the user turned off machine-wide.
  const agents = proj ? mergeAgents(user.agents, proj.hasAgents ? proj.agents : {}) : user.agents;
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
      desired.set(name, t.agent === 'codex'
        ? codex.render(name, src, serverOverrides(agents, name, 'codex'), warn)
        : claude.render(name, src, { secrets: secretsMode(agents, name, 'claude', 'literal') }));
    } catch (e) { errors.push(e.message); }
  }
  const stateDir = t.scope === 'user' ? user.paths.state : proj.paths.state;
  const state = loadState(stateDir, targetId).servers;
  const native = t.agent === 'codex' ? codex.read(t.scope, root) : claude.read();
  // Damaged markers make the managed region unknowable: refuse to plan rather than guess
  // which text belongs to eag. apply.js turns an error into "not applied", not a crash.
  if (native.damaged) errors.push(`${native.file}: ${native.damaged}`);
  const foreign = new Set([...native.servers.keys()].filter((n) => !Object.hasOwn(state, n)));
  const actions = planMerge({ desired, state, native: native.servers, foreign, locked: native.locked, prefer });
  // Unrendered entry (secrets as ${NAME}); adapters use it for output that must not carry resolved values.
  for (const a of actions) if (Object.hasOwn(srcServers, a.name)) a.source = srcServers[a.name];
  return { ...base, actions, errors, skippedByPolicy, native, stateDir, state, desired };
}

export function applyPlan(plan, { dryRun = false, backupDir } = {}) {
  if (plan.skipped) return { skipped: plan.skipped };
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
  if (plan.agent === 'codex') {
    const needsWrite = writes.length > 0 || !plan.native.hasBlock && entries.size > 0;
    if (needsWrite) result = codex.write(plan.scope, plan.root, entries, { backupDir, dryRun });
    else {
      // Nothing to write, but the file may still carry a literal and may have been widened
      // since the last apply.
      const tightened = dryRun ? null : codex.ensureMode(plan.scope, plan.root, entries);
      result = { file: plan.native.file, changed: false, tightened };
    }
  } else {
    const w = claude.write(writes, { dryRun });
    result = { file: plan.native.file, commands: w.commands, failures: w.failures, changed: writes.length > 0 };
    if (!dryRun && writes.length) {
      // Re-read only the names this run actually wrote. Refreshing every name would pull a
      // hand edit that was just reported as a conflict into the snapshot, and the next apply
      // would read it as "the source changed" and overwrite the edit it had refused to touch.
      const written = new Set(writes.map((a) => a.name));
      const opOf = new Map(writes.map((a) => [a.name, a.op]));
      for (const f of w.failures) {
        written.delete(f.name);
        // A delete that failed left the server in place. Keeping it in the snapshot is what
        // makes the next apply plan the delete again instead of calling it foreign forever.
        if (opOf.get(f.name) === 'delete' && Object.hasOwn(plan.state, f.name)) newState[f.name] = plan.state[f.name];
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
