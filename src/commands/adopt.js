import os from 'node:os';
import path from 'node:path';
import { scopePaths, assertProjectScope, projectRoot } from '../paths.js';
import { migratable } from '../projects.js';
import * as skills from '../skills.js';
import { run as initRun } from './init.js';
import { run as applyRun } from './apply.js';
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
export function extractSecrets(name, obj) {
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
  if (flags['all-projects']) return allProjects(agent, flags);
  if (agent === 'skills') return adoptSkills(flags);
  if (!['claude', 'codex'].includes(agent)) throw new Error('usage: eag adopt <claude|codex> [--scope user|project] [--dry-run] [--force]');
  const scope = flags.scope || 'user';
  if (!['user', 'project'].includes(scope)) throw new Error(`--scope must be user or project (got "${scope}")`);
  const root = projectRoot();
  const dry = !!flags['dry-run'];
  const paths = scopePaths(scope, root);
  if (scope === 'project') assertProjectScope(paths);
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
    for (const [name, obj] of n.servers) { const { entry, overrides } = codex.toSource(obj); incoming.set(name, { entry, overrides, locked: n.locked.has(name), keep: n.keep.get(name) || null, native: obj }); }
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
  for (const [name, { entry: raw, overrides, locked, keep, native }] of incoming) {
    // A locked table that belongs to another tool, or is a macOS app internal, or is
    // disabled, is Codex's alone: pushing it into Claude means, on a machine with the ChatGPT
    // app, registering ChatGPT.app itself as an MCP server. It is not brought into the
    // source unless the source already has that name from another agent — then the only
    // job is to keep eag from fighting over it in Codex.
    if (keep && !Object.hasOwn(servers, name)) {
      console.log(`${c.dim('keep   ')} ${name} ${c.dim(`is ${keep}; left to Codex, not shared (eag mcp add ${name} … to share it on purpose)`)}`);
      continue;
    }
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

// Claude's "local" scope is the one place eag's promise does not hold: those servers live in
// ~/.claude.json and only Claude reads them, so opening Codex or Pi in that repo finds
// nothing. This walks every project that has them and moves them into the project's own
// .mcp.json, which Claude and Pi read natively and which eag renders into .codex/config.toml.
//
// It writes inside repositories the user did not name, so it says exactly what it touched,
// skips anything it is not sure about, and never runs without being asked.
async function allProjects(agent, flags) {
  if (agent && agent !== 'claude') throw new Error('--all-projects applies to: eag adopt claude --all-projects');
  const dry = !!flags['dry-run'];
  const keepLocal = !!flags['keep-local'];
  const items = migratable();
  if (!items.length) { console.log('no project-scoped servers in Claude Code to migrate'); return 0; }

  let moved = 0;
  let failed = 0;
  const before = process.env.EAG_PROJECT;
  for (const p of items) {
    const short = p.root.replace(os.homedir(), '~');
    if (p.skip) { console.log(`${c.dim('skip   ')} ${short} ${c.dim(`(${p.skip})`)}`); continue; }
    console.log(`\n${c.bold(short)} ${c.dim(p.names.join(', '))}`);
    if (dry) { console.log(`  ${c.dim(`would write ${path.join(p.root, '.mcp.json')} and .codex/config.toml`)}`); continue; }
    try {
      // EAG_PROJECT is the documented way to aim project scope somewhere other than the cwd.
      process.env.EAG_PROJECT = p.root;
      await initRun([], { project: true });
      await run(['claude'], { scope: 'project' });
      await applyRun([], { scope: 'project' });
      if (!keepLocal) {
        // Leaving the local copy behind means Claude carries the server twice and the copy
        // nothing syncs is the one that drifts.
        for (const name of p.names) {
          const err = claude.removeLocal(p.root, name);
          if (err) { console.log(`  ${c.warn('kept   ')} ${name} in local scope: ${err}`); failed++; }
        }
      }
      moved++;
    } catch (e) {
      console.log(`  ${c.bad('error  ')} ${e.message}`);
      failed++;
    } finally {
      if (before === undefined) delete process.env.EAG_PROJECT; else process.env.EAG_PROJECT = before;
    }
  }
  console.log(`\n${moved} project(s) now agnostic${failed ? `, ${c.warn(`${failed} problem(s)`)}` : ''}${dry ? c.dim(' (dry run: nothing written)') : ''}`);
  if (moved && !dry) console.log(c.dim('Each repo got a committable .mcp.json; .codex/config.toml and .agents/.state/ went into its .gitignore.\nCodex reads a project config only in a repo you have trusted inside Codex — eag doctor says which.'));
  return failed ? 1 : 0;
}

// Skills only flow outward from ~/.agents/skills. A skill that lives only in ~/.claude/skills
// or ~/.codex/skills stays that agent's alone until it is moved here; then Codex reads it
// directly and Claude keeps a link. Two different skills with one name are never merged.
async function adoptSkills(flags) {
  const dry = !!flags['dry-run'];
  const items = skills.plan();
  if (!items.length) { console.log('every skill is already shared; nothing to adopt'); return 0; }
  const short = (p) => p.replace(os.homedir(), '~');
  for (const it of items) {
    if (it.op === 'adopt') console.log(`${c.ok('adopt  ')} ${it.name} ${c.dim(`${short(it.from)} → ${short(skills.SHARED)}${it.agent === 'claude' ? ' (link left behind)' : ''}`)}`);
    else if (it.op === 'duplicate') console.log(`${c.dim('same   ')} ${it.name} ${c.dim(`${short(it.from)} is identical to ${short(it.against)}; dropping the copy`)}`);
    else console.log(`${c.warn('clash  ')} ${it.name}: ${short(it.from)} is a DIFFERENT skill from ${short(it.against)}. Rename one; eag will not choose`);
  }
  if (dry) { console.log(`\n${c.dim('dry run: nothing moved')}`); return 0; }
  const done = skills.apply(items);
  const clashes = items.filter((i) => i.op === 'collision').length;
  console.log(`\n${done.filter((d) => d.op === 'adopt').length} skill(s) now shared, ${done.filter((d) => d.op === 'duplicate').length} duplicate(s) dropped${clashes ? `, ${c.warn(`${clashes} name clash(es) left alone`)}` : ''}`);
  if (done.length) console.log(c.dim('Codex reads ~/.agents/skills directly; run eag doctor --fix to link them into Claude Code.'));
  return clashes ? 2 : 0;
}
