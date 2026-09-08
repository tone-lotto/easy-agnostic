import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, PI_AGENT_DIR, CURSOR_HOME, ANTIGRAVITY_HOME, OPENCODE_HOME, projectRoot, scopePaths, assertProjectScope, physicalPath } from './paths.js';
import { exists, sameTree } from './util.js';

// Inventory and scope boundaries. Legacy shared directories remain readable, but
// only explicit policies in skill-policy.js may create cross-agent links.
export const SHARED = path.join(EAG_HOME, 'skills');
export const AGENT_DIRS = {
  claude: { dir: path.join(CLAUDE_CONFIG_DIR, 'skills') },
  codex: { dir: path.join(CODEX_HOME, 'skills') },
  pi: { dir: path.join(PI_AGENT_DIR, 'skills') },
  cursor: { dir:path.join(CURSOR_HOME,'skills') },
  antigravity: { dir:path.join(ANTIGRAVITY_HOME,'skills') },
  opencode: { dir:path.join(OPENCODE_HOME,'skills') },
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
  for (const folder of ['.agents', '.claude', '.codex', '.pi', '.cursor', '.agent', '.opencode']) {
    if (globalDirs.includes(physical(path.join(root, folder, 'skills')))) throw new Error('project skill scope overlaps a user skill directory');
    for (const file of [path.join(root, folder), path.join(root, folder, 'skills')]) {
      if (present(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file}: project skill directories must not be symlinks`);
    }
  }
  return { shared: path.join(root, '.agents', 'skills'), agents: {
    claude: { dir: path.join(root, '.claude', 'skills') },
    codex: { dir: path.join(root, '.codex', 'skills') },
    pi: { dir: path.join(root, '.pi', 'skills') },
    cursor: { dir:path.join(root,'.cursor','skills') },
    antigravity: { dir:path.join(root,'.agent','skills') },
    opencode: { dir:path.join(root,'.opencode','skills') },
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
  if (name === 'eag' || ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.opencode-plugin', '.antigravity-plugin'].some(m => present(path.join(dir, name, m)))) return true;
  if (name.startsWith('.')) return true;                                    // .system and the like
  if (exists(path.join(dir, name, '.eag-managed'))) return true;           // eag's own skill
  if (exists(path.join(dir, name, '.codex-managed')) || exists(path.join(dir, name, '.bundled'))) return true;
  return physicalPath(dir) === physicalPath(AGENT_DIRS.codex.dir) && nativeNames().has(name);
}

export function apply(items) {
  if (items.some(i => !['blocked', 'collision'].includes(i.op))) throw new Error('bulk skill adoption is disabled; use eag skills share NAME');
  return [];
}

export function plan(options = {}) {
  return inventory(options).filter(r => !r.inherited && r.origin !== 'library' && !r.linked && !isNative(path.dirname(r.path), r.name)).map(r => ({ name: r.name, agent: r.origin, from: r.path, op: 'blocked', message: 'explicit scope, targets and compatibility review required; use eag skills share' }));
}

export function inventory(options = {}) {
  const scope = options.scope ?? 'user';
  const sets = [{ scope, ...locations(options) }];
  if (scope === 'project') sets.push({ scope: 'user', ...locations({ scope: 'user' }) });
  const rows = [];
  for (const set of sets) for (const [origin, dir] of [['shared', set.shared], ['library', path.join(path.dirname(set.shared), 'skill-library')], ...Object.entries(set.agents).map(([agent, value]) => [agent, value.dir])]) {
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const file = path.join(dir, name);
      const linked = fs.lstatSync(file).isSymbolicLink();
      const broken = linked && !exists(file);
      if (!broken && !exists(path.join(file, 'SKILL.md'))) continue;
      rows.push({ name, scope: set.scope, origin, path: file, inherited: scope === 'project' && set.scope === 'user', linked, broken });
    }
  }
  for (const row of rows) {
    row.conflict = !row.broken && rows.some((other) => other !== row && !other.broken && other.scope === row.scope && other.name === row.name && !sameTree(other.path, row.path));
    row.sameNameInUserScope = row.scope === 'project' && rows.some((other) => other.scope === 'user' && other.name === row.name);
  }
  return rows;
}
