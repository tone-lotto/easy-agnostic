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
  return { scope, root, mcp: path.join(root, '.mcp.json'), agents: path.join(root, '.agents', 'agents.json'), state: path.join(root, '.agents', '.state') };
}
