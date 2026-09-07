import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  p.collides = path.resolve(p.agents) === path.resolve(path.join(EAG_HOME, 'agents.json'));
  return p;
}

// The message every command that would write project scope shares.
export function assertProjectScope(paths) {
  if (!paths.collides) return paths;
  throw new Error(`project scope for ${paths.root} would write ${paths.agents}, which is the user-level file (EAG_HOME=${EAG_HOME}).\nRun this from a project directory, or point EAG_PROJECT at one.`);
}
