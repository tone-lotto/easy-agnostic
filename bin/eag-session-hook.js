// Silent, bounded native hook. No model calls, history indexing or trust writes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [agent,scope,entry,fixedRoot] = process.argv.slice(2);
try {
  if (!['cursor','antigravity'].includes(agent) || !['user','project'].includes(scope) || !path.isAbsolute(entry)) throw new Error();
  if (scope === 'project' && !fixedRoot) throw new Error();
  const root = scope === 'project' ? fixedRoot : (agent === 'cursor' ? process.env.CURSOR_PROJECT_DIR : process.env.ANTIGRAVITY_PROJECT_DIR) || process.cwd();
  if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new Error();
  execFileSync(process.execPath,[entry,'apply','--scope',scope === 'user' ? 'all' : 'project','--target',agent,'--quiet'],{
    cwd:root,env:{...process.env,EAG_PROJECT:root},stdio:'ignore',timeout:15000,killSignal:'SIGKILL',
  });
} catch { /* never prevent an agent session from opening */ }
