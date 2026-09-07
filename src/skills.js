import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, projectRoot, scopePaths, assertProjectScope } from './paths.js';
import { exists, sameTree } from './util.js';

// Skills flow outward from ~/.agents/skills: Codex reads that directory itself, doctor links
// it into ~/.claude/skills. A skill that lives only in one agent's own directory never
// reaches the other. This is the adopt step for skills — the same move `eag adopt claude`
// makes for MCP servers: bring what an agent has into the shared source.
export const SHARED = path.join(EAG_HOME, 'skills');
export const AGENT_DIRS = {
  claude: { dir: path.join(CLAUDE_CONFIG_DIR, 'skills'), afterMove: 'link' },   // Claude needs the entry back as a link
  codex: { dir: path.join(CODEX_HOME, 'skills'), afterMove: 'none' },           // Codex reads the shared dir directly
};

const present = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function locations({ scope = 'user', root = projectRoot() } = {}) {
  if (!['user', 'project'].includes(scope)) throw new Error('--scope must be user or project');
  if (scope === 'user') return { shared: SHARED, agents: AGENT_DIRS };
  root = fs.realpathSync(root);
  assertProjectScope(scopePaths('project', root));
  const physical = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const globalDirs = [SHARED, ...Object.values(AGENT_DIRS).map((a) => a.dir)].map(physical);
  // A repository may link .claude or .agents to the user's home. Project adoption
  // must never follow that link and move machine-wide skills into the repo.
  for (const folder of ['.agents', '.claude', '.codex']) {
    if (globalDirs.includes(physical(path.join(root, folder, 'skills')))) throw new Error('project skill scope overlaps a user skill directory');
    for (const file of [path.join(root, folder), path.join(root, folder, 'skills')]) {
      if (present(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file}: project skill directories must not be symlinks`);
    }
  }
  return { shared: path.join(root, '.agents', 'skills'), agents: {
    claude: { dir: path.join(root, '.claude', 'skills'), afterMove: 'link' },
    codex: { dir: path.join(root, '.codex', 'skills'), afterMove: 'none' },
  } };
}

// Only what the user ADDED moves. What ships with the tool stays: Codex keeps its bundled
// skills under ~/.codex/skills/.system and names its curated set in
// vendor_imports/skills-curated-cache.json; anything eag itself wrote carries a marker.
function nativeNames() {
  const out = new Set();
  const cache = path.join(CODEX_HOME, 'vendor_imports', 'skills-curated-cache.json');
  try {
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') { for (const [k, v] of Object.entries(x)) { if ((k === 'name' || k === 'slug' || k === 'id') && typeof v === 'string') out.add(v); walk(v); } }
    };
    walk(JSON.parse(fs.readFileSync(cache, 'utf8')));
  } catch { /* no cache, nothing curated */ }
  return out;
}
export function isNative(dir, name) {
  if (name.startsWith('.')) return true;                                    // .system and the like
  if (exists(path.join(dir, name, '.eag-managed'))) return true;           // eag's own skill
  if (exists(path.join(dir, name, '.codex-managed')) || exists(path.join(dir, name, '.bundled'))) return true;
  return nativeNames().has(name);
}

function realSkills(dir, { scope = 'user' } = {}) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((n) => {
    if (scope === 'user' ? isNative(dir, n) : n.startsWith('.') || ['.eag-managed', '.codex-managed', '.bundled'].some((m) => exists(path.join(dir, n, m)))) return false;
    const p = path.join(dir, n);
    try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() && exists(path.join(p, 'SKILL.md')); } catch { return false; }
  });
}

// One entry per (agent, skill) that is not yet in the shared directory.
//   adopt      move it into ~/.agents/skills
//   duplicate  identical to what is already shared (or to the other agent's copy): drop it
//   collision  a DIFFERENT skill with the same name: report, never choose
export function plan(options = {}) {
  const { shared: sharedDir, agents } = locations(options);
  const out = [];
  const seen = new Map(); // name -> path already claimed for the shared dir in this plan
  for (const [agent, { dir }] of Object.entries(agents)) {
    for (const name of realSkills(dir, options)) {
      const from = path.join(dir, name);
      const shared = path.join(sharedDir, name);
      if (present(shared)) {
        out.push({ agent, name, from, op: sameTree(shared, from) ? 'duplicate' : 'collision', against: shared });
        continue;
      }
      const claimed = seen.get(name);
      if (claimed) {
        out.push({ agent, name, from, op: sameTree(claimed, from) ? 'duplicate' : 'collision', against: claimed });
        continue;
      }
      seen.set(name, from);
      out.push({ agent, name, from, op: 'adopt' });
    }
  }
  if (options.scope === 'project') {
    // No arbitrary winner when two project agents use the same name differently.
    const clashes = new Set(out.filter((i) => i.op === 'collision').map((i) => i.name));
    for (const it of out) if (clashes.has(it.name) && it.op !== 'collision') {
      it.op = 'collision'; it.against = out.find((other) => other.name === it.name && other.from !== it.from)?.from;
    }
    const names = new Set([...realSkills(sharedDir, options), ...out.filter((i) => i.op === 'adopt').map((i) => i.name)]);
    for (const name of names) if (!clashes.has(name) && !present(path.join(agents.claude.dir, name))) {
      out.push({ agent: 'claude', name, from: path.join(agents.claude.dir, name), op: 'link' });
    }
  }
  return out;
}

export function apply(items, { dryRun = false, ...options } = {}) {
  const { shared: sharedDir, agents } = locations(options);
  const done = [];
  for (const it of items) {
    if (it.op === 'collision') continue;
    const dest = path.join(sharedDir, it.name);
    if (!Object.hasOwn(agents, it.agent) || path.basename(it.name) !== it.name || it.from !== path.join(agents[it.agent].dir, it.name)) throw new Error('invalid skill adoption plan');
    if (it.op === 'adopt') {
      if (!dryRun) {
        if (present(dest) || !fs.lstatSync(it.from).isDirectory() || fs.lstatSync(it.from).isSymbolicLink()) throw new Error(`${it.name}: skill changed since planning; retry`);
        fs.mkdirSync(sharedDir, { recursive: true });
        fs.renameSync(it.from, dest);
        if (agents[it.agent].afterMove === 'link') fs.symlinkSync(path.relative(path.dirname(it.from), dest), it.from);
      }
      done.push({ ...it, dest });
    } else if (it.op === 'duplicate') {
      // The shared copy (or the one adopted from the other agent) is what stays.
      if (!dryRun) {
        if (fs.lstatSync(it.from).isSymbolicLink() || !sameTree(it.from, dest)) throw new Error(`${it.name}: duplicate changed since planning; retry`);
        fs.rmSync(it.from, { recursive: true, force: true });
        if (agents[it.agent].afterMove === 'link') fs.symlinkSync(path.relative(path.dirname(it.from), dest), it.from);
      }
      done.push({ ...it, dest });
    } else if (it.op === 'link') {
      if (!dryRun) {
        if (present(it.from) || !exists(path.join(dest, 'SKILL.md'))) throw new Error(`${it.name}: skill link changed since planning; retry`);
        fs.mkdirSync(path.dirname(it.from), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(it.from), dest), it.from);
      }
      done.push({ ...it, dest });
    }
  }
  return done;
}

export function inventory(options = {}) {
  const scope = options.scope ?? 'user';
  const sets = [{ scope, ...locations(options) }];
  if (scope === 'project') sets.push({ scope: 'user', ...locations({ scope: 'user' }) });
  const rows = [];
  for (const set of sets) for (const [origin, dir] of [['shared', set.shared], ...Object.entries(set.agents).map(([agent, value]) => [agent, value.dir])]) {
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const file = path.join(dir, name);
      if (!exists(path.join(file, 'SKILL.md'))) continue;
      rows.push({ name, scope: set.scope, origin, path: file, inherited: scope === 'project' && set.scope === 'user', linked: fs.lstatSync(file).isSymbolicLink() });
    }
  }
  for (const row of rows) {
    row.conflict = rows.some((other) => other !== row && other.scope === row.scope && other.name === row.name && !sameTree(other.path, row.path));
    row.sameNameInUserScope = row.scope === 'project' && rows.some((other) => other.scope === 'user' && other.name === row.name);
  }
  return rows;
}
