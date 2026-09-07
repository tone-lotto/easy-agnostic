import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runCommand as execFileSync } from './process.js';

// Every path honours the same env vars the agents themselves use, so the whole
// tool can be pointed at a sandbox: EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR.
export const HOME = os.homedir();
export const EAG_HOME = process.env.EAG_HOME || path.join(HOME, '.agents');
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(HOME, '.claude.json');
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');

// Resolve existing ancestors too: a missing config inside a linked directory is
// still an alias of the destination where it would be created.
export function physicalPath(file) {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(physicalPath(parent), path.basename(absolute));
  }
}

export function projectRoot(cwd = process.cwd()) {
  if (process.env.EAG_PROJECT) return path.resolve(process.env.EAG_PROJECT);
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return cwd;
  }
}

export function scopePaths(scope, root) {
  if (scope === 'user') {
    return { scope, root: EAG_HOME, mcp: path.join(EAG_HOME, 'mcp.json'), agents: path.join(EAG_HOME, 'agents.json'), state: path.join(EAG_HOME, '.state') };
  }
  root = root || projectRoot();
  const p = { scope, root, mcp: path.join(root, '.mcp.json'), agents: path.join(root, '.agents', 'agents.json'), state: path.join(root, '.agents', '.state') };
  // A "project" whose .agents/ IS the user's EAG_HOME — normally $HOME, since EAG_HOME
  // defaults to ~/.agents — would put the project's policy in the machine-wide agents.json
  // and its snapshots in the user's state dir. One apply there rewrites every target's
  // policy for the whole machine. Callers must refuse to write; readers must skip it.
  const projectFiles = [p.mcp, p.agents, p.state, path.join(root, '.codex', 'config.toml')].map(physicalPath);
  const userFiles = [path.join(EAG_HOME, 'mcp.json'), path.join(EAG_HOME, 'agents.json'), path.join(EAG_HOME, '.state'), path.join(CODEX_HOME, 'config.toml')].map(physicalPath);
  p.collides = projectFiles.some((file) => userFiles.includes(file));
  return p;
}

// The message every command that would write project scope shares.
export function assertProjectScope(paths) {
  if (!(paths.scope === 'project' ? scopePaths('project', paths.root).collides : paths.collides)) return paths;
  throw new Error(`project scope for ${paths.root} overlaps a user-level configuration or state path (EAG_HOME=${EAG_HOME}).\nRun this from a separate project directory, or remove the alias to user-level files.`);
}
