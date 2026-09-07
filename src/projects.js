import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME, scopePaths } from './paths.js';
import { exists } from './util.js';
import * as claude from './adapters/claude.js';

// Claude Code keeps per-project servers in ~/.claude.json under projects[<root>].mcpServers
// — its "local" scope. Only Claude reads them, so a project set up that way is the one place
// eag's promise does not hold: open Codex or Pi in that repo and the servers are not there.
// Moving them to the project's own .mcp.json makes them agnostic, because that file is what
// Claude and Pi read natively and what eag renders into .codex/config.toml.
export function claudeLocalProjects() {
  const data = claude.readRaw();
  const out = [];
  for (const [root, p] of Object.entries(data.projects || {})) {
    const names = Object.keys(p?.mcpServers || {});
    if (names.length) out.push({ root, names });
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : 1));
}

// Why a project cannot or should not be migrated. Null means it can.
export function skipReason(root) {
  if (!exists(root)) return 'the directory no longer exists';
  try { if (!fs.statSync(root).isDirectory()) return 'not a directory'; } catch { return 'unreadable'; }
  // The case that made the guard in paths.js exist: a "project" whose .agents/ is EAG_HOME.
  if (scopePaths('project', root).collides) return `its .agents/ is ${EAG_HOME}, the user-level config`;
  const src = path.join(root, '.mcp.json');
  if (exists(src)) {
    // Already has a project source. Only skip if it already covers every local name.
    let have = [];
    try { have = Object.keys(JSON.parse(fs.readFileSync(src, 'utf8')).mcpServers || {}); } catch { return '.mcp.json does not parse'; }
    return have.length ? null : null;
  }
  return null;
}

export function migratable() {
  return claudeLocalProjects().map((p) => ({ ...p, skip: skipReason(p.root) }));
}
