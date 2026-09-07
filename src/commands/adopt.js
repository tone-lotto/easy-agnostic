import { scopePaths, projectRoot } from '../paths.js';
import { loadSource, saveMcp, saveAgents, validateServer } from '../source.js';
import { loadState, saveState } from '../state.js';
import { setSecret, resolveSecret, backendName } from '../secrets.js';
import { deepEqual, looksLikeSecret, refsIn, c } from '../util.js';
import * as claude from '../adapters/claude.js';
import * as codex from '../adapters/codex.js';

// `pat` only as a whole token: PATH, NODE_PATH or PATTERN are not credentials.
const SECRETISH_KEY = /(key|token|secret|pass|auth|credential|(?:^|[^a-z0-9])pat(?:[^a-z0-9]|$))/i;
// Secret names must be valid identifiers: ${NAME} refs, `eag secret` and `eag env` all require [A-Za-z_][A-Za-z0-9_]*.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/^(?=\d)/, '_');

// Replace literal credentials with ${NAME} references and return the secrets found.
function extractSecrets(name, obj) {
  const out = structuredClone(obj);
  const found = [];
  const upper = ident(name);
  for (const [h, v] of Object.entries(out.headers || {})) {
    if (typeof v !== 'string' || /\$\{/.test(v)) continue;
    const bearer = /^(Bearer\s+)(\S+)$/i.exec(v);
    if (bearer) { const sn = `${upper}_TOKEN`; found.push([sn, bearer[2]]); out.headers[h] = `${bearer[1]}\${${sn}}`; }
    else if (looksLikeSecret(v) || SECRETISH_KEY.test(h)) { const sn = `${upper}_${ident(h)}`; found.push([sn, v]); out.headers[h] = `\${${sn}}`; }
  }
  for (const [k, v] of Object.entries(out.env || {})) {
    if (typeof v !== 'string' || /\$\{/.test(v) || v === '') continue;
    if (SECRETISH_KEY.test(k) || looksLikeSecret(v)) { const sn = IDENT.test(k) ? k : ident(k); found.push([sn, v]); out.env[k] = `\${${sn}}`; }
  }
  return { entry: out, secrets: found };
}

export async function run(args, flags) {
  const agent = args[0];
  if (!['claude', 'codex'].includes(agent)) throw new Error('usage: eag adopt <claude|codex> [--scope user|project] [--dry-run] [--force]');
  const scope = flags.scope || 'user';
  if (!['user', 'project'].includes(scope)) throw new Error(`--scope must be user or project (got "${scope}")`);
  const root = projectRoot();
  const dry = !!flags['dry-run'];
  const paths = scopePaths(scope, root);
  const src = loadSource(paths);
  if (!src.hasMcp) throw new Error(`${paths.mcp} not found; run eag init${scope === 'project' ? ' --project' : ''} first`);

  // 1. read what the agent has
  let incoming = new Map(); // name -> { entry, overrides, locked }
  let targetId = null;
  if (agent === 'claude') {
    if (scope === 'user') {
      const n = claude.read();
      for (const [name, obj] of n.servers) incoming.set(name, { entry: obj, overrides: {}, locked: false });
      targetId = 'claude-user';
    } else {
      // "local" scope entries Claude keeps in ~/.claude.json for this project
      for (const [name, obj] of Object.entries(claude.readLocal(root))) incoming.set(name, { entry: claude.canonical(obj), overrides: {}, locked: false });
    }
  } else {
    const n = codex.read(scope, root);
    for (const [name, obj] of n.servers) { const { entry, overrides } = codex.toSource(obj); incoming.set(name, { entry, overrides, locked: n.locked.has(name), native: obj }); }
    targetId = `codex-${scope}`;
  }
  if (incoming.size === 0) { console.log(`nothing to adopt: ${agent} has no MCP servers in ${scope} scope`); return 0; }

  // 2. merge into the source
  const servers = { ...src.servers };
  const agents = structuredClone(src.agents);
  agents.servers ||= {};
  const stateUpdates = {};
  const secretsToSet = [];
  let changed = false;
  for (const [name, { entry: raw, overrides, locked, native }] of incoming) {
    const { entry, secrets } = extractSecrets(name, raw);
    const errs = validateServer(name, entry);
    if (errs.length) { console.log(`${c.bad('skip   ')} ${name}: ${errs.join('; ')}`); continue; }
    const existing = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (existing && !deepEqual(existing, entry) && !flags.force) {
      console.log(`${c.warn('conflict')} ${name}: already in source with different content; keeping source. Use --force to overwrite, or: eag mcp target ${name} ${agent} off`);
    } else {
      if (!existing) { servers[name] = entry; changed = true; console.log(`${c.ok('adopt  ')} ${name} ${c.dim(entry.url || entry.command)}`); }
      else if (!deepEqual(existing, entry)) { servers[name] = entry; changed = true; console.log(`${c.ok('replace')} ${name} (--force)`); }
      else console.log(`${c.dim('same   ')} ${name}`);
      if (Object.keys(overrides).length) { agents.servers[name] = { ...(agents.servers[name] || {}), codex: overrides }; changed = true; }
    }
    for (const [sn, val] of secrets) secretsToSet.push([sn, val, name]);
    for (const ref of refsIn(entry)) if (resolveSecret(ref) === undefined && !secrets.some(([sn]) => sn === ref)) console.log(`${c.warn('missing')} ${name} references \${${ref}} which is not set. Run: eag secret set ${ref}`);
    if (locked) {
      // Another tool owns this entry in Codex. eag will not fight it.
      agents.servers[name] = { ...(agents.servers[name] || {}), targets: { ...(agents.servers[name]?.targets || {}), codex: false } };
      changed = true;
      console.log(`${c.dim('locked ')} ${name} is managed outside eag in Codex; set targets.codex=false so eag leaves it alone`);
    } else if (targetId && (deepEqual(servers[name], entry) || !existing)) {
      // The snapshot is compared against what the agent's file holds, so it must be in the
      // agent's own shape. For Codex `raw` is already translated to the source shape, which
      // never deep-equals a TOML table: keep the table we read instead, or the very next
      // status reports a phantom conflict and apply refuses to write.
      stateUpdates[name] = native ?? raw;
    }
  }

  // 3. write
  if (dry) { console.log(`\n${c.dim('dry run: nothing written')}`); return 0; }
  for (const [sn, val, from] of secretsToSet) {
    const cur = resolveSecret(sn);
    if (cur !== undefined && cur !== val) { console.log(`${c.warn('secret ')} ${sn} already set with a different value; keeping the existing one (from ${from})`); continue; }
    if (cur === undefined) { setSecret(sn, val); console.log(`${c.ok('secret ')} ${sn} stored (${backendName()}, from ${from})`); }
  }
  if (changed) { saveMcp(paths, servers, src.mcp); saveAgents(paths, agents); console.log(`${c.ok('wrote  ')} ${paths.mcp}`); }
  if (targetId && Object.keys(stateUpdates).length) {
    const st = loadState(paths.state, targetId).servers;
    saveState(paths.state, targetId, { ...st, ...stateUpdates });
  }
  console.log(`\nNext: ${c.bold('eag status')}`);
  return 0;
}
