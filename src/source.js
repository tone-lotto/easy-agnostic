import { readJson, writeJson } from './util.js';

export const DEFAULT_AGENTS = { targets: { claude: true, codex: true, pi: 'read-only' }, servers: {} };

// A sentinel, not null: a file whose whole content is the JSON literal `null` parses to the
// same value a missing file would fall back to, and must not be mistaken for one.
const MISSING = Symbol('missing');

export function loadSource(paths) {
  const mcp = readJson(paths.mcp, MISSING);
  const agents = readJson(paths.agents, MISSING);
  const hasMcp = mcp !== MISSING;
  // A source that parses but has no "mcpServers" object used to read as "zero servers",
  // and the next apply would take that literally and delete every server from every agent.
  // A renamed key or a different envelope is a mistake, not an empty source.
  if (hasMcp && (!mcp?.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers))) {
    throw new Error(`${paths.mcp}: no "mcpServers" object at the top level. Expected {"mcpServers": {...}}`);
  }
  return {
    paths,
    servers: hasMcp ? mcp.mcpServers : {},
    mcp: hasMcp ? mcp : { mcpServers: {} },
    agents: agents === MISSING || agents === null ? DEFAULT_AGENTS : agents,
    hasMcp,
    hasAgents: agents !== MISSING,
  };
}

export function saveMcp(paths, servers, original = {}) {
  writeJson(paths.mcp, { ...original, mcpServers: servers });
}
export function saveAgents(paths, agents) { writeJson(paths.agents, agents); }

export function targetEnabled(agents, agentId) {
  const v = agents?.targets?.[agentId];
  return v === true;
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
  if (!s || typeof s !== 'object') { errs.push(`${name}: not an object`); return errs; }
  if (!s.url && !s.command) errs.push(`${name}: needs "url" or "command"`);
  if (s.url && s.command) errs.push(`${name}: has both "url" and "command"`);
  if (s.headers && typeof s.headers !== 'object') errs.push(`${name}: "headers" must be an object`);
  if (s.env && typeof s.env !== 'object') errs.push(`${name}: "env" must be an object`);
  if (s.args && !Array.isArray(s.args)) errs.push(`${name}: "args" must be an array`);
  return errs;
}
