import { inventory } from '../skills.js';
import { projectRoot } from '../paths.js';
import { share, syncLinks, AGENTS, readPolicies, discoveryConsumers } from '../skill-policy.js';

function agents(value, flag) {
  if (typeof value !== 'string') throw new Error(`--${flag} requires an explicit comma-separated agent list (or none)`);
  const list = value === 'none' ? [] : value.split(',');
  if (list.some(a => !AGENTS.includes(a)) || new Set(list).size !== list.length) throw new Error(`invalid --${flag} agent list`);
  return list;
}

export async function run(args, flags) {
  try {
    const [command, name] = args;
    const specific = command === 'share' ? ['from','to','compatible','requires'] : [];
    for (const flag of Object.keys(flags)) if (!['scope','json',...(command === 'ls' ? [] : ['dry-run']),...specific].includes(flag)) throw new Error(`--${flag} is not valid for skills ${command}`);
    if (command === 'share' && args.length === 2) {
      const requires = {};
      for (const dep of [].concat(flags.requires ?? [])) {
        if (typeof dep !== 'string' || dep.split(':').length !== 2) throw new Error('--requires expects AGENT:SKILL (repeatable)');
        const [a, skill] = dep.split(':');
        if (!AGENTS.includes(a)) throw new Error('unknown dependency agent');
        (requires[a] ??= []).push(skill);
      }
      const result = share(name, {scope:flags.scope,root:projectRoot(),from:flags.from,targets:agents(flags.to,'to'),compatible:agents(flags.compatible,'compatible'),requires,dryRun:!!flags['dry-run']});
      if (flags.json) console.log(JSON.stringify(result,null,2));
      else console.log(`${result.dryRun ? 'would configure' : 'configured'} ${name} (${result.scope}): ${result.targets.join(', ') || 'no agents'}; source ${result.library}${result.removedLinks.length ? `; ${result.removedLinks.length} old link(s) removed, source preserved` : ''}`);
      return 0;
    }
    if (command === 'sync' && args.length === 1) {
      if (!flags.scope) throw new Error('--scope user|project is required for skill changes');
      const results = syncLinks({scope:flags.scope,root:projectRoot(),dryRun:!!flags['dry-run']});
      const exit = results.some(r=>r.op==='conflict') ? 3 : results.some(r=>r.op==='blocked') ? 2 : 0;
      if (flags.json) console.log(JSON.stringify({scope:flags.scope,skills:results,exit},null,2));
      else for (const r of results) console.log(`${r.op}: ${r.message}`);
      return exit;
    }
    if (args.length !== 1 || command !== 'ls') throw new Error('usage: eag skills ls|share NAME|sync (see --help)');
    const scope = flags.scope ?? 'user';
    const skills = inventory({ scope, root: projectRoot() });
    const policies = new Map();
    for (const s of skills) {
      if (!policies.has(s.scope)) policies.set(s.scope, readPolicies({scope:s.scope,root:projectRoot()}));
      s.approval = Object.hasOwn(policies.get(s.scope),s.name) ? policies.get(s.scope)[s.name] : null;
      s.alsoDiscoverableBy = discoveryConsumers(s);
    }
    if (flags.json) console.log(JSON.stringify({ scope, skills }, null, 2));
    else if (!skills.length) console.log('no skills found');
    else for (const s of skills) console.log(`${s.inherited ? 'inherited' : s.scope} ${s.origin} ${s.name}${s.broken ? ' [broken link]' : s.linked ? ' [link]' : ''}${s.conflict ? ' [conflict]' : ''}${s.sameNameInUserScope ? ' [also in user scope]' : ''}${s.approval ? ` [targets: ${s.approval.targets.join(',') || 'none'}; compatible: ${s.approval.compatible.join(',') || 'unknown'}]` : ' [no sharing approval]'}${s.alsoDiscoverableBy.length ? ` [native discovery: ${s.alsoDiscoverableBy.join(',')}]` : ''} ${s.path}`);
    return 0;
  } catch (e) {
    if (!flags.json) throw e;
    console.log(JSON.stringify({ error: e.message, exit: 1 }));
    return 1;
  }
}
