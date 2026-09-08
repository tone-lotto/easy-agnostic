import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { locations, isNative } from './skills.js';
import { projectRoot, physicalPath, CODEX_HOME } from './paths.js';
import { withMutationLock } from './lock.js';
import { exists, readJsonSnapshot, writeFileAtomic } from './util.js';
import { AGENTS } from './agents.js';
import { CURSOR_HOME, OPENCODE_HOME } from './paths.js';
import { loadSource } from './source.js';
import { scopePaths } from './paths.js';

export { AGENTS };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const stat = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export const validName = n => typeof n === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(n) && !['constructor', 'prototype', '__proto__', 'synced', 'eag'].includes(n.toLowerCase());
const agentList = v => Array.isArray(v) && v.every(a => AGENTS.includes(a)) && new Set(v).size === v.length;

export function policyLocations(options) {
  const loc = structuredClone(locations(options));
  loc.scope = options.scope ?? 'user'; loc.root = options.root ?? projectRoot();
  // Resolve OS aliases (/var, /tmp on macOS), but refuse aliases inside each scope.
  for (const key of ['shared']) loc[key] = path.join(physicalPath(path.dirname(loc[key])), path.basename(loc[key]));
  for (const a of AGENTS) loc.agents[a].dir = path.join(physicalPath(path.dirname(loc.agents[a].dir)), 'skills');
  loc.library = path.join(path.dirname(loc.shared), 'skill-library');
  loc.policy = path.join(path.dirname(loc.shared), 'agents.json');
  loc.state = path.join(path.dirname(loc.shared), '.state', 'skills.json');
  return loc;
}
function guard(loc) {
  const files = [loc.shared, loc.library, loc.policy, loc.state, ...AGENTS.map(a => loc.agents[a].dir)];
  for (const file of files) for (let p = file; path.dirname(p) !== p; p = path.dirname(p)) {
    if (stat(p)?.isSymbolicLink()) throw new Error(`${p}: skill paths must not contain symlinks`);
  }
  const dirs = [loc.shared, loc.library, ...AGENTS.map(a => loc.agents[a].dir)].map(physicalPath);
  if (dirs.some((p,i) => dirs.some((q,j) => i !== j && (p === q || p.startsWith(q + path.sep))))) throw new Error('skill directories overlap');
}
export function fingerprint(dir) {
  const hash = createHash('sha256'); let files = 0; let bytes = 0;
  const walk = (p, rel, depth) => {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw new Error('skill contains a link or non-regular file');
    if (++files > 4096 || depth > 24 || (bytes += s.isFile() ? s.size : 0) > 32 * 1024 * 1024) throw new Error('skill exceeds review limits');
    if (['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.opencode-plugin', '.antigravity-plugin', '.codex-managed', '.bundled', '.eag-managed'].includes(path.basename(p))) throw new Error('vendor-managed skill or plugin must stay with its provider');
    // Length-delimit content: file bytes must not impersonate the next entry's header.
    hash.update(JSON.stringify([rel, s.isDirectory() ? 'dir' : 'file', s.mode & 0o111, s.isFile() ? s.size : 0]) + '\n');
    if (s.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p,n), `${rel}/${n}`, depth+1);
    else hash.update(fs.readFileSync(p));
  };
  if (!stat(path.join(dir,'SKILL.md'))?.isFile()) throw new Error('source needs a regular SKILL.md');
  walk(dir,'',0); return hash.digest('hex');
}
function validateEntry(p) {
  if (!record(p) || !agentList(p.targets) || !agentList(p.compatible) || !record(p.requires) || !/^[a-f0-9]{64}$/.test(p.digest) || Object.keys(p).some(k => !['targets','compatible','requires','digest'].includes(k))) throw new Error('invalid skill policy');
  for (const [a,deps] of Object.entries(p.requires)) if (!AGENTS.includes(a) || !Array.isArray(deps) || !deps.every(validName)) throw new Error('invalid skill dependencies');
}
function load(loc) {
  const policy = readJsonSnapshot(loc.policy, {}), state = readJsonSnapshot(loc.state, {version:1,links:{}});
  if (!record(policy.value) || ('skills' in policy.value && !record(policy.value.skills))) throw new Error('invalid skills policy');
  for (const [n,p] of Object.entries(policy.value.skills ?? {})) { if (!validName(n)) throw new Error('invalid skill name in policy'); validateEntry(p); }
  if (!record(state.value) || state.value.version !== 1 || !record(state.value.links)) throw new Error('invalid skill ownership state');
  for (const [n,agents] of Object.entries(state.value.links)) if (!validName(n) || !agentList(agents)) throw new Error('invalid skill ownership state');
  return {policy,state};
}
export const readPolicies = options => load(policyLocations(options)).policy.value.skills ?? {};
const matches = (file,dest) => stat(file)?.isSymbolicLink() && path.resolve(path.dirname(file),fs.readlinkSync(file)) === path.resolve(dest);

// Compatibility discovery is a property of the receiving application, not a link
// EAG can revoke. Never create an owned link that a known unapproved receiver sees.
export function indirectConsumers(agent, loc) {
  const user = loadSource(scopePaths('user')).agents;
  const project = loc.scope === 'project' ? loadSource(scopePaths('project',loc.root)).agents : {};
  const known = (id,dir) => exists(dir) || user.targets?.[id] === true || project.targets?.[id] === true || exists(path.dirname(loc.agents[id].dir));
  return [
    ...(['claude','codex'].includes(agent) && known('cursor',CURSOR_HOME) ? ['cursor'] : []),
    ...(agent === 'claude' && known('opencode',OPENCODE_HOME) ? ['opencode'] : []),
  ];
}
export function discoveryConsumers(skill, { root = projectRoot() } = {}) {
  if (skill.origin === 'library' || skill.broken) return [];
  // Shared is intentionally a multi-provider discovery location, even when the
  // receiver has not yet been installed. This is exposure, not sharing approval.
  if (skill.origin === 'shared') return ['codex','cursor','opencode',...(skill.scope === 'project' ? ['antigravity'] : [])];
  return indirectConsumers(skill.origin,policyLocations({scope:skill.scope,root}));
}
function exposureReason(agent,loc,policy) {
  const missing = indirectConsumers(agent,loc).filter(a => !policy.targets.includes(a) || !policy.compatible.includes(a));
  return missing.length ? `also discoverable by ${missing.join(', ')}; explicit target permission and compatibility review required` : null;
}

function available(loc,name,agent,policies,stack) {
  const key = `${agent}:${name}`;
  if (stack.has(key)) return false;
  const native = path.join(loc.agents[agent].dir,name);
  if (Object.hasOwn(policies,name)) {
    if (stat(native) && !matches(native,path.join(loc.library,name))) return false;
    return !blocked(loc,name,agent,policies,new Set([...stack,key]));
  }
  if (exists(native) && physicalPath(native).startsWith(loc.library + path.sep)) return false;
  return exists(path.join(native,'SKILL.md')) || (agent === 'codex' && exists(path.join(CODEX_HOME,'skills','.system',name,'SKILL.md')));
}
function blocked(loc,name,agent,policies,stack = new Set()) {
  const p = policies[name];
  if (!p?.targets.includes(agent)) return 'not authorized';
  if (!p.compatible.includes(agent)) return 'compatibility not approved';
  const exposure = exposureReason(agent,loc,p); if (exposure) return exposure;
  try { if (fingerprint(path.join(loc.library,name)) !== p.digest) return 'content changed; review and approve again'; } catch (e) { return e.message; }
  for (const dep of p.requires[agent] ?? []) if (!available(loc,dep,agent,policies,stack)) return `missing or unapproved dependency: ${dep}`;
  return null;
}

// Ordinary failures roll back completed steps without overwriting concurrent edits.
// A killed process can leave content in the library; no source tree is deleted.
function transaction(fn) {
  const undo = [];
  try { return fn(undo); } catch (e) {
    const failures = [];
    for (const restore of undo.reverse()) try { restore(); } catch (r) { failures.push(r.message); }
    throw new Error(`${e.message}; ${failures.length ? `rollback incomplete: ${failures.join('; ')}` : 'original files restored'}`);
  }
}
function changeLink(file,dest,want,undo,expected=null) {
  const old = stat(file) ? fs.readlinkSync(file) : null;
  if (old !== expected) throw new Error(`skill link changed since planning: ${file}`);
  if (old !== null) fs.unlinkSync(file);
  undo.push(() => {
    if (stat(file)) { if (!matches(file,dest)) throw new Error(`concurrent edit preserved at ${file}`); fs.unlinkSync(file); }
    if (old !== null) fs.symlinkSync(old,file);
  });
  if (want) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.symlinkSync(path.relative(path.dirname(file),dest),file); }
}
function save(file,snapshot,value,undo) {
  const text = JSON.stringify(value,null,2)+'\n';
  if (text === snapshot.text) return;
  writeFileAtomic(file,text,0o600,{expected:snapshot.text});
  undo.push(() => {
    if (fs.readFileSync(file,'utf8') !== text) throw new Error(`concurrent edit preserved at ${file}`);
    if (snapshot.text === null) fs.unlinkSync(file); else writeFileAtomic(file,snapshot.text,0o600,{expected:text});
  });
}

export function share(name,{scope,root=projectRoot(),from='library',targets,compatible,requires={},dryRun=false}={}) {
  if (!scope) throw new Error('--scope user|project is required for skill changes');
  if (!validName(name)) throw new Error('invalid or reserved skill name');
  if (!agentList(targets) || !agentList(compatible)) throw new Error('explicit --to and --compatible lists are required (or none)');
  validateEntry({targets,compatible,requires,digest:'0'.repeat(64)});
  if (targets.some(a => !compatible.includes(a))) throw new Error('every target must have reviewed compatibility');
  if (Object.values(requires).some(deps => deps.includes(name))) throw new Error('self-referencing dependency');
  const run = () => {
    const loc = policyLocations({scope,root}); guard(loc);
    for (const a of targets) { const reason = exposureReason(a,loc,{targets,compatible}); if (reason) throw new Error(`${a}: ${reason}`); }
    if (!['library','shared',...AGENTS].includes(from)) throw new Error('--from must be library, shared, claude, codex or pi');
    const sourceDir = from === 'library' ? loc.library : from === 'shared' ? loc.shared : loc.agents[from].dir;
    const source = path.join(sourceDir,name), dest = path.join(loc.library,name);
    if (isNative(sourceDir,name)) throw new Error('native skill must stay with its provider');
    const digest = fingerprint(source), snapshots = load(loc);
    if (source !== dest && (stat(dest) || Object.hasOwn(snapshots.policy.value.skills ?? {},name))) throw new Error('managed source already exists');
    const policy = structuredClone(snapshots.policy.value); policy.skills ??= {};
    policy.skills[name] = {targets,compatible,requires,digest};
    const state = structuredClone(snapshots.state.value), owned = new Set(state.links[name] ?? []), oldLinks = [];
    for (const a of AGENTS) {
      const file = path.join(loc.agents[a].dir,name);
      if (file === source || !stat(file)) continue;
      if (source !== dest ? matches(file,source) : owned.has(a) && matches(file,dest)) oldLinks.push([a,file,fs.readlinkSync(file)]);
      else throw new Error(`${a}: existing skill path is unowned or modified; left untouched`);
    }
    const shared = path.join(loc.shared,name);
    if (shared !== source && stat(shared)) throw new Error('same-name shared source remains independently discoverable; resolve it first');
    for (const a of targets) for (const dep of requires[a] ?? []) if (!available(loc,dep,a,policy.skills,new Set())) throw new Error(`${a}: missing or unapproved dependency: ${dep}`);
    const result = {name,scope,from,source,library:dest,targets,compatible,requires,digest,dryRun,removedLinks:oldLinks.filter(([a])=>!targets.includes(a)).map(([,f])=>f)};
    if (dryRun) return result;
    return transaction(undo => {
      guard(loc);
      if (fingerprint(source) !== digest) throw new Error('skill changed since review; retry');
      if (source !== dest) {
        fs.mkdirSync(loc.library,{recursive:true});
        if (stat(dest)) throw new Error('library destination changed since planning');
        fs.renameSync(source,dest);
        undo.push(() => { if (stat(source)) throw new Error(`source path changed; recover skill from ${dest}`); fs.renameSync(dest,source); });
      }
      for (const [,file,expected] of oldLinks) changeLink(file,dest,false,undo,expected);
      for (const a of targets) changeLink(path.join(loc.agents[a].dir,name),dest,true,undo);
      state.links[name] = [...targets];
      save(loc.policy,snapshots.policy,policy,undo); save(loc.state,snapshots.state,state,undo);
      return result;
    });
  };
  return dryRun ? run() : withMutationLock(run);
}

export function syncLinks({scope='user',root=projectRoot(),dryRun=false,target=null}={}) {
  const run = () => {
    const loc = policyLocations({scope,root}); guard(loc);
    const snapshots = load(loc), policies = snapshots.policy.value.skills ?? {}, state = structuredClone(snapshots.state.value);
    const result = [], actions = [];
    const libraryNames = exists(loc.library) ? fs.readdirSync(loc.library).filter(validName) : [];
    for (const name of new Set([...Object.keys(policies),...Object.keys(state.links),...libraryNames])) {
      const dest = path.join(loc.library,name), owned = new Set(state.links[name] ?? []);
      for (const a of AGENTS) {
        if (target && !target.includes(a)) {
          // A receiver launch must also revoke an owned link in another vendor's
          // folder when that receiver would discover it without permission. Never
          // create other vendors' links as a side effect of this safety check.
          if (!owned.has(a) || !policies[name] || !exposureReason(a,loc,policies[name]) || !indirectConsumers(a,loc).some(id=>target.includes(id))) continue;
        }
        const file = path.join(loc.agents[a].dir,name), reason = blocked(loc,name,a,policies);
        const present = stat(file), exact = matches(file,dest);
        if (present && (!owned.has(a) || !exact)) { result.push({name,agent:a,op:'conflict',message:`${name}: ${a} path is unowned or modified; left untouched`}); continue; }
        if (reason) {
          if (owned.has(a) && exact) { actions.push({file,dest,want:false,expected:fs.readlinkSync(file)}); result.push({name,agent:a,op:'unlink',message:`${name}: ${a} link revoked (${reason}); source preserved`}); }
          else if (policies[name]?.targets.includes(a)) result.push({name,agent:a,op:'blocked',message:`${name}: ${a} ${reason}`});
          owned.delete(a);
        } else if (!present) {
          actions.push({file,dest,want:true}); owned.add(a);
          result.push({name,agent:a,op:'link',path:file,message:`${name}: approved ${a} link`});
        }
      }
      state.links[name] = [...owned];
    }
    if (exists(loc.shared)) for (const name of fs.readdirSync(loc.shared).filter(validName)) {
      if (!exists(path.join(loc.shared,name,'SKILL.md'))) continue;
      result.push({name,op:'blocked',message:`${name}: legacy shared location; compatibility/permission unknown, native agents may still discover it. Review with eag skills share NAME --from shared --scope ${scope}`});
    }
    if (!dryRun) transaction(undo => {
      guard(loc);
      for (const a of actions) changeLink(a.file,a.dest,a.want,undo,a.expected ?? null);
      if (actions.length || JSON.stringify(state) !== JSON.stringify(snapshots.state.value)) save(loc.state,snapshots.state,state,undo);
    });
    return result;
  };
  return dryRun ? run() : withMutationLock(run);
}
