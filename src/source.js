import { readJsonSnapshot, writeFileAtomic } from './util.js';
import { assertProjectScope } from './paths.js';
import { withMutationLock } from './lock.js';
import { AGENTS } from './agents.js';

export const DEFAULT_AGENTS = { targets: { claude: true, codex: true, pi: 'read-only' }, servers: {} };

// A sentinel, not null: a file whose whole content is the JSON literal `null` parses to the
// same value a missing file would fall back to, and must not be mistaken for one.
const MISSING = Symbol('missing');
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const snapshots = new WeakMap();

export function loadSource(paths) {
  const mcpSnapshot = readJsonSnapshot(paths.mcp, MISSING);
  const agentsSnapshot = readJsonSnapshot(paths.agents, MISSING);
  const mcp = mcpSnapshot.value;
  const agents = agentsSnapshot.value;
  snapshots.set(paths, { mcp: mcpSnapshot.text, agents: agentsSnapshot.text });
  const hasMcp = mcp !== MISSING;
  // A source that parses but has no "mcpServers" object used to read as "zero servers",
  // and the next apply would take that literally and delete every server from every agent.
  // A renamed key or a different envelope is a mistake, not an empty source.
  if (hasMcp && (!mcp?.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers))) {
    throw new Error(`${paths.mcp}: no "mcpServers" object at the top level. Expected {"mcpServers": {...}}`);
  }
  if (agents !== MISSING) {
    const errors = validateAgents(agents);
    if (errors.length) throw new Error(`${paths.agents}: ${errors.join('; ')}`);
  }
  return {
    paths,
    servers: hasMcp ? mcp.mcpServers : {},
    mcp: hasMcp ? mcp : { mcpServers: {} },
    agents: agents === MISSING ? DEFAULT_AGENTS : agents,
    hasMcp,
    hasAgents: agents !== MISSING,
  };
}

export function saveMcp(paths, servers, original = {}) {
  saveSourceFile(paths, 'mcp', { ...original, mcpServers: servers });
}
export function saveAgents(paths, agents) {
  const errors = validateAgents(agents);
  if (errors.length) throw new Error(`${paths.agents}: ${errors.join('; ')}`);
  saveSourceFile(paths, 'agents', agents);
}

function saveSourceFile(paths, key, value) {
  return withMutationLock(() => saveSourceFileLocked(paths, key, value));
}
function saveSourceFileLocked(paths, key, value) {
  assertProjectScope(paths);
  const previous = snapshots.get(paths);
  const text = JSON.stringify(value, null, 2) + '\n';
  writeFileAtomic(paths[key], text, undefined, previous ? { expected: previous[key] } : {});
  if (previous) snapshots.set(paths, { ...previous, [key]: text });
}

export function sourceGuard(paths) {
  const expected = snapshots.get(paths);
  return () => {
    for (const key of ['mcp', 'agents']) if (readJsonSnapshot(paths[key], MISSING).text !== expected[key]) throw new Error('source or agent policy changed since planning; retry eag apply');
  };
}

export function targetEnabled(agents, agentId) {
  const v = agents?.targets?.[agentId];
  return v === true;
}
// Project policy overrides individual switches, not the entire per-server policy.
// Defining one receiver must not erase a different receiver's inherited denial.
export function mergeAgentPolicies(user, project = {}) {
  const servers = Object.create(null);
  for (const name of new Set([...Object.keys(user.servers ?? {}),...Object.keys(project.servers ?? {})])) {
    const a = user.servers?.[name] ?? {}, b = project.servers?.[name] ?? {};
    servers[name] = {...a,...b,targets:{...a.targets,...b.targets}};
    for (const agent of AGENTS) if (a[agent] || b[agent]) servers[name][agent] = {...a[agent],...b[agent]};
  }
  return {...user,...project,targets:{...user.targets,...project.targets},servers,
    ...Object.fromEntries(AGENTS.map(agent=>[agent,{...user[agent],...project[agent]}]))};
}
export function serverAllowed(agents, name, agentId) {
  const v = agents?.servers?.[name]?.targets?.[agentId];
  return v !== false;
}
export function serverOverrides(agents, name, agentId) {
  return agents?.servers?.[name]?.[agentId] || {};
}
export function secretsMode(agents, name, agentId, fallback) {
  return agents?.servers?.[name]?.secrets || agents?.[agentId]?.secrets || fallback;
}

export function validateServer(name, s) {
  const errs = [];
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) errs.push(`name "${name}" has characters outside [A-Za-z0-9_.-]`);
  // These would address Object.prototype instead of an entry in every map keyed by server name.
  if (['__proto__', 'constructor', 'prototype'].includes(name)) errs.push(`name "${name}" is reserved`);
  if (!record(s)) { errs.push(`${name}: not an object`); return errs; }
  if (!s.url && !s.command) errs.push(`${name}: needs "url" or "command"`);
  if (s.url && s.command) errs.push(`${name}: has both "url" and "command"`);
  for (const key of ['url', 'command', 'cwd']) {
    if (key in s && (typeof s[key] !== 'string' || !s[key].trim() || /[\0\r\n]/.test(s[key]))) errs.push(`${name}: "${key}" must be a non-empty single-line string`);
  }
  for (const key of ['headers', 'env']) {
    if (!(key in s)) continue;
    if (!record(s[key])) { errs.push(`${name}: "${key}" must be an object`); continue; }
    for (const [k, v] of Object.entries(s[key])) {
      if (!(key === 'env' ? identifier : headerName).test(k) || typeof v !== 'string' || v.includes('\0') || (key === 'headers' && /[\r\n]/.test(v))) errs.push(`${name}: "${key}" requires valid names and string values without unsafe control characters`);
    }
  }
  if ('args' in s) {
    if (!Array.isArray(s.args)) errs.push(`${name}: "args" must be an array`);
    else if (s.args.some((v) => typeof v !== 'string' || v.includes('\0'))) errs.push(`${name}: "args" must contain strings without NUL characters`);
  }
  if ('type' in s && (!['stdio', 'http', 'sse'].includes(s.type) || (s.url && s.type === 'stdio') || (s.command && s.type !== 'stdio'))) errs.push(`${name}: "type" must match the command or URL transport`);
  if (typeof s.url === 'string' && s.url.trim() && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(s.url)) {
    try { if (!['http:', 'https:'].includes(new URL(s.url).protocol)) throw new Error(); }
    catch { errs.push(`${name}: "url" must be an HTTP(S) URL or contain an environment reference`); }
  }
  return errs;
}

export function validateAgents(agents) {
  if (!record(agents)) return ['agent policy must be an object'];
  const errors = [];
  const mode = (v, label) => { if (v !== undefined && !['env', 'literal'].includes(v)) errors.push(`${label}: secrets must be env or literal`); };
  const targets = (v, label) => {
    if (v === undefined) return;
    if (!record(v)) { errors.push(`${label}: targets must be an object`); return; }
    for (const [key, value] of Object.entries(v)) {
      if (!AGENTS.includes(key) || (typeof value !== 'boolean' && !(key === 'pi' && value === 'read-only')) || (key === 'pi' && value === true)) errors.push(`${label}: invalid target switch`);
    }
  };
  targets(agents.targets, 'agents');
  if ('autoUpdate' in agents && typeof agents.autoUpdate !== 'boolean') errors.push('autoUpdate must be boolean (automatic updates are disabled)');
  for (const key of AGENTS) {
    if (!(key in agents)) continue;
    if (!record(agents[key])) errors.push(`${key}: policy must be an object`);
    else {
      mode(agents[key].secrets, key);
      if (key === 'opencode' && agents[key].mcpFormat !== undefined && !['auto','v1','v2'].includes(agents[key].mcpFormat)) errors.push('opencode: mcpFormat must be auto, v1 or v2');
    }
  }
  if ('servers' in agents) {
    if (!record(agents.servers)) errors.push('servers policy must be an object');
    else for (const [name, policy] of Object.entries(agents.servers)) {
      if (!record(policy)) { errors.push('server policy must be an object'); continue; }
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) errors.push('invalid server policy name');
      targets(policy.targets, 'server policy');
      mode(policy.secrets, 'server policy');
      for (const key of AGENTS) if (key in policy && !record(policy[key])) errors.push(`${key}: overrides must be an object`);
    }
  }
  return errors;
}
