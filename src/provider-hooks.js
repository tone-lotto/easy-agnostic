import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEW_AGENTS } from './agents.js';
import { CURSOR_HOME, ANTIGRAVITY_HOME, OPENCODE_HOME, scopePaths, assertProjectScope } from './paths.js';
import { readConfig, editConfig, guardConfig, renderConfig } from './json-config.js';
import { readJsonSnapshot, writeFileAtomic, shellQuote, backup, deepEqual } from './util.js';
import { withMutationLock } from './lock.js';

const HANDLER = fileURLToPath(new URL('../bin/eag-session-hook.js',import.meta.url));
const ENTRY = fileURLToPath(new URL('../bin/eag.js',import.meta.url));
export function hookSpec(agent,scope,root,{entry = ENTRY,handler = HANDLER,node = process.execPath} = {}) {
  if (!NEW_AGENTS.includes(agent) || !['user','project'].includes(scope)) throw new Error('provider hook needs an explicit agent and user|project scope');
  const base = scope === 'project' ? root : {cursor:CURSOR_HOME,antigravity:ANTIGRAVITY_HOME,opencode:OPENCODE_HOME}[agent];
  const file = scope === 'project' ? path.join(base,{cursor:'.cursor/hooks.json',antigravity:'.agents/hooks.json',opencode:'.opencode/plugins/eag-sync.js'}[agent]) : path.join(base,agent === 'opencode' ? 'plugins/eag-sync.js' : 'hooks.json');
  const command = [node,handler,agent,scope,entry,...(scope === 'project' ? [root] : [])].map(shellQuote).join(' ');
  if (agent === 'cursor') return {file,command,value:{command},keys:['hooks','sessionStart']};
  if (agent === 'antigravity') return {file,command,value:{PreInvocation:[{type:'command',command,timeout:20}]},keys:['easy-agnostic-sync']};
  const code = `// Managed by eag hook install --target opencode. No transcript collection.\nimport { execFile } from 'node:child_process';\nimport { isAbsolute } from 'node:path';\nexport const EasyAgnostic = async ({ directory }) => ({ event: async ({ event }) => {\n  if (event.type !== 'session.created') return;\n  const root = ${scope === 'project' ? JSON.stringify(root) : 'directory'};\n  if (typeof root !== 'string' || !isAbsolute(root)) return;\n  await new Promise(resolve => execFile(${JSON.stringify(node)}, [${JSON.stringify(entry)}, 'apply', '--scope', ${JSON.stringify(scope === 'user' ? 'all' : 'project')}, '--target', 'opencode', '--quiet'], { cwd: root, env: { ...process.env, EAG_PROJECT: root }, timeout: 15000, maxBuffer: 65536 }, () => resolve()));\n} });\n`;
  return {file,code,value:code};
}
export function providerHook(agent,{scope,root,command='status',dryRun=false,...options} = {}) {
  const work = () => providerHookLocked(agent,{scope,root,command,dryRun,...options});
  return command === 'status' || dryRun ? work() : withMutationLock(work);
}
function providerHookLocked(agent,{scope,root,command,dryRun,...options}) {
  const paths = scopePaths(scope,root); if (scope === 'project') assertProjectScope(paths);
  const spec = hookSpec(agent,scope,root,options), stateFile = path.join(paths.state,`hook-${agent}.json`);
  const bounded = file => {
      try { const st = fs.lstatSync(file); if (!st.isFile() || st.nlink !== 1 || st.size > 4 * 1024 * 1024) throw new Error('hook/plugin must be a bounded regular non-linked file'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  const guardNative = () => {
    guardConfig(spec.file,{root:scope === 'project' ? root : undefined,forbidden:scope === 'project' ? [hookSpec(agent,'user',root,options).file] : []});
    bounded(spec.file);
  };
  const guard = () => { guardNative(); guardConfig(stateFile); bounded(stateFile); };
  guard();
  const state = readJsonSnapshot(stateFile,null), owned = state.value, backupDir = path.join(paths.state,'backup');
  const snapshot = spec.code ? null : readConfig(spec.file);
  if (agent === 'cursor' && snapshot.data.version !== undefined && snapshot.data.version !== 1) throw new Error('unsupported Cursor hooks version; configuration preserved');
  let current;
  if (spec.code) { try { current = fs.readFileSync(spec.file,'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; current = null; } }
  else current = spec.keys.reduce((obj,k)=>obj?.[k],snapshot.data);
  const ours = agent === 'cursor' ? (Array.isArray(current) ? current.filter(v => deepEqual(v,owned?.value) || deepEqual(v,spec.value)) : []) : current;
  const installed = agent === 'cursor' ? ours.length > 0 : current !== undefined && current !== null;
  const expected = agent === 'cursor' ? ours.length === 1 && deepEqual(ours[0],spec.value) : deepEqual(current,spec.value);
  const status = {agent,scope,file:spec.file,installed:!!installed,current:!!expected,execution:'not verified; native trust and session reload may be required'};
  if (command === 'status') return status;
  if (!['install','uninstall'].includes(command)) throw new Error('expected hook install, uninstall or status');
  if (owned && owned.file !== spec.file) throw new Error('hook path changed; inspect the prior owned location first');
  if (agent === 'cursor') {
    if (current !== undefined && !Array.isArray(current)) throw new Error('Cursor sessionStart hooks must be an array');
    if (owned && current !== undefined && !current?.some(v => deepEqual(v,owned.value)) && !expected) throw new Error('owned Cursor hook changed or disappeared; preserved for review');
  } else if (installed && !expected && (!owned || !deepEqual(current,owned.value))) throw new Error('native hook/plugin is unowned or modified; preserved');
  if (command === 'uninstall' && !owned) return {...status,changed:false};
  if (command === 'install' && expected && owned) return {...status,changed:false};
  if (dryRun) return {...status,changed:command === 'uninstall' ? installed : !expected,dryRun};
  guard();
  const before = spec.code ? current : snapshot.text;
  let written;
  if (spec.code) {
    let fresh; try { fresh = fs.readFileSync(spec.file,'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; fresh = null; }
    if (fresh !== current) throw new Error('plugin changed since planning');
    if (current !== null) backup(spec.file,backupDir,'opencode-eag-plugin');
    written = command === 'uninstall' ? null : spec.code;
    if (command === 'uninstall' && current !== null) fs.unlinkSync(spec.file);
    else if (command === 'uninstall') { /* already removed; clear ownership below */ }
    else writeFileAtomic(spec.file,spec.code,0o600,{expected:current});
  } else {
    const value = agent === 'cursor' ? [...(current ?? []).filter(v => !deepEqual(v,owned?.value) && !deepEqual(v,spec.value)),...(command === 'install' ? [spec.value] : [])] : command === 'install' ? spec.value : undefined;
    const changes = [[spec.keys,value]];
    if (agent === 'cursor' && snapshot.data.version === undefined && command === 'install') changes.unshift([['version'],1]);
    // Do not create an empty native file merely to forget a removed hook.
    written = snapshot.text === null && command === 'uninstall' ? null : renderConfig(snapshot,changes);
    if (written !== null) editConfig(snapshot,changes,{backupDir,guard});
  }
  try {
    guard();
    writeFileAtomic(stateFile,JSON.stringify(command === 'install' ? {file:spec.file,value:spec.value} : null)+'\n',0o600,{expected:state.text});
  } catch (e) {
    // Recover the prior native snapshot if recording ownership fails. Do not
    // overwrite concurrent edits; leave the backup and report the failure.
    try {
      guardNative();
      let after = null; try { after = fs.readFileSync(spec.file,'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (after !== written) throw new Error('native hook changed externally; rollback withheld');
      if (before !== after) {
        if (before === null) fs.unlinkSync(spec.file);
        else writeFileAtomic(spec.file,before,0o600,{expected:after});
      }
    } catch (rollback) {
      throw new Error(`${e.message}; recovery: ${rollback.message}. Inspect the private backup before retrying.`,{cause:e});
    }
    throw e;
  }
  return {...status,changed:true,installed:command === 'install',backupDir};
}
