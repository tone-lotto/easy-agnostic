import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME } from './paths.js';
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

function realSkills(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((n) => {
    if (n.startsWith('.')) return false;
    const p = path.join(dir, n);
    try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink() && exists(path.join(p, 'SKILL.md')); } catch { return false; }
  });
}

// One entry per (agent, skill) that is not yet in the shared directory.
//   adopt      move it into ~/.agents/skills
//   duplicate  identical to what is already shared (or to the other agent's copy): drop it
//   collision  a DIFFERENT skill with the same name: report, never choose
export function plan() {
  const out = [];
  const seen = new Map(); // name -> path already claimed for the shared dir in this plan
  for (const [agent, { dir }] of Object.entries(AGENT_DIRS)) {
    for (const name of realSkills(dir)) {
      const from = path.join(dir, name);
      const shared = path.join(SHARED, name);
      if (exists(shared)) {
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
  return out;
}

export function apply(items, { dryRun = false } = {}) {
  const done = [];
  for (const it of items) {
    if (it.op === 'collision') continue;
    const dest = path.join(SHARED, it.name);
    if (it.op === 'adopt') {
      if (!dryRun) {
        fs.mkdirSync(SHARED, { recursive: true });
        fs.renameSync(it.from, dest);
        if (AGENT_DIRS[it.agent].afterMove === 'link') fs.symlinkSync(path.relative(path.dirname(it.from), dest), it.from);
      }
      done.push({ ...it, dest });
    } else if (it.op === 'duplicate') {
      // The shared copy (or the one adopted from the other agent) is what stays.
      if (!dryRun) {
        fs.rmSync(it.from, { recursive: true, force: true });
        if (AGENT_DIRS[it.agent].afterMove === 'link') fs.symlinkSync(path.relative(path.dirname(it.from), dest), it.from);
      }
      done.push({ ...it, dest });
    }
  }
  return done;
}
