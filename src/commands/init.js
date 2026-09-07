import path from 'node:path';
import fs from 'node:fs';
import { scopePaths, projectRoot, CODEX_HOME, PI_AGENT_DIR } from '../paths.js';
import { DEFAULT_AGENTS, saveAgents, saveMcp, loadSource } from '../source.js';
import { exists, ensureDir, c } from '../util.js';
import * as claude from '../adapters/claude.js';

export async function run(_args, flags) {
  const scope = flags.project ? 'project' : 'user';
  const paths = scopePaths(scope, scope === 'project' ? projectRoot() : undefined);
  const src = loadSource(paths);
  if (!src.hasMcp) { saveMcp(paths, {}, {}); console.log(`${c.ok('created')} ${paths.mcp}`); }
  else console.log(`${c.dim('exists ')} ${paths.mcp} (${Object.keys(src.servers).length} servers)`);
  if (!src.hasAgents) {
    const agents = structuredClone(DEFAULT_AGENTS);
    if (scope === 'user') {
      agents.targets.claude = claude.available();
      agents.targets.codex = exists(CODEX_HOME);
      agents.targets.pi = exists(PI_AGENT_DIR) ? 'read-only' : false;
    } else {
      // project agents.json only overrides; leave targets to the user file
      delete agents.targets;
    }
    saveAgents(paths, agents);
    console.log(`${c.ok('created')} ${paths.agents}`);
    if (scope === 'user') console.log(`         targets: ${Object.entries(agents.targets).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  } else console.log(`${c.dim('exists ')} ${paths.agents}`);
  ensureDir(paths.state);
  if (scope === 'project') {
    // Both can carry literal credentials: the snapshots/backups under .state, and the
    // generated Codex file (repeats user servers; literals where Codex has no env-ref field).
    const gi = path.join(paths.root, '.gitignore');
    const lines = ['.agents/.state/', '.codex/config.toml'];
    if (exists(gi)) {
      const text = fs.readFileSync(gi, 'utf8');
      const have = text.split(/\r?\n/).map((l) => l.trim());
      const missing = lines.filter((l) => !have.includes(l));
      if (missing.length) { fs.appendFileSync(gi, `${text.endsWith('\n') || text === '' ? '' : '\n'}${missing.join('\n')}\n`); console.log(`${c.ok('added  ')} ${missing.join(', ')} to .gitignore`); }
    } else console.log(`${c.warn('note   ')} no .gitignore in ${paths.root}; add ${lines.join(' and ')} if you commit this repo`);
  }
  console.log(`\nNext: ${c.bold('eag adopt claude')} and ${c.bold('eag adopt codex')} to import what you have, then ${c.bold('eag status')}.`);
  return 0;
}
