import { spawn } from 'node:child_process';
import { AGENTS, AGENT_BINS } from '../agents.js';
import { projectRoot } from '../paths.js';
import { referencedNames } from './env.js';
import { resolveSecret } from '../secrets.js';
import { main } from '../cli.js';

// Explicit launcher also handles renamed binaries without hijacking a generic
// shell command such as Cursor's newer `agent` alias. Never builds a shell string.
export async function run(args, flags) {
  const [agent,...forward] = args;
  if (!AGENTS.includes(agent)) throw new Error(`run requires one agent: ${AGENTS.join(', ')}`);
  const binary = flags.binary ?? AGENT_BINS[agent];
  if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary)) throw new Error('--binary requires one executable name or path');
  if (agent !== 'pi') {
    const code = await main(['apply','--scope','all','--target',agent,'--quiet']);
    if (code !== 0) throw new Error(`sync failed (exit ${code}); resolve eag status before launching`);
  }
  const root = projectRoot(), env = {...process.env,EAG_PROJECT:root};
  for (const name of referencedNames(agent,root)) {
    const value = resolveSecret(name);
    if (value === undefined) throw new Error(`${name}: required secret is not set`);
    env[name] = value;
  }
  return await new Promise((resolve,reject) => {
    const child = spawn(binary,forward,{cwd:root,env,stdio:'inherit',shell:false});
    const forwardSignal = signal => { if (!child.killed) child.kill(signal); };
    const signals = ['SIGINT','SIGTERM'];
    const handlers = signals.map(signal => { const fn = () => forwardSignal(signal); process.on(signal,fn); return fn; });
    const cleanup = () => signals.forEach((signal,i) => process.off(signal,handlers[i]));
    child.once('error',error => { cleanup(); reject(error); });
    child.once('exit',(code,signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}
