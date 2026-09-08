import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write, read } from './helpers.js';
const base = sandbox();
const { share, syncLinks, policyLocations, fingerprint } = await import('../src/skill-policy.js');
const { plan, apply, inventory, AGENT_DIRS, SHARED } = await import('../src/skills.js');
let serial = 0;
function fixture() {
  const root = path.join(base,`scope-${serial++}`); fs.mkdirSync(root);
  const options = {scope:'project',root}; const loc = policyLocations(options);
  const make = (origin,name='demo',text=name) => write(path.join(origin==='shared'?loc.shared:origin==='library'?loc.library:loc.agents[origin].dir,name,'SKILL.md'),text);
  const approve = (extra={}) => share('demo',{...options,from:'codex',targets:['codex','claude'],compatible:['codex','claude'],...extra});
  return {...loc,root,options,make,approve};
}
test.after(()=>fs.rmSync(base,{recursive:true,force:true}));

test('bulk adoption and launch sync do not infer consent from agent-local skills',()=>{
  const p=fixture(); const file=p.make('codex');
  const items=plan(p.options); assert.equal(items[0].op,'blocked'); apply(items); syncLinks(p.options);
  assert.equal(read(file),'demo'); assert.equal(fs.existsSync(p.library),false); assert.equal(fs.existsSync(p.agents.claude.dir),false);
  assert.throws(()=>apply([{op:'adopt'}]),/disabled/);
});
test('legacy shared skills are reported but neither linked nor moved automatically',()=>{
  const p=fixture(); const file=p.make('shared');
  assert.equal(syncLinks(p.options)[0].op,'blocked'); assert.equal(read(file),'demo'); assert.equal(fs.existsSync(p.agents.claude.dir),false);
});
test('explicit sharing uses neutral library and only approved agents',()=>{
  const p=fixture(); p.make('codex'); p.approve();
  for(const a of ['codex','claude']) assert.equal(read(path.join(p.agents[a].dir,'demo','SKILL.md')),'demo');
  assert.equal(fs.existsSync(path.join(p.shared,'demo')),false); assert.equal(fs.existsSync(p.agents.pi.dir),false);
  assert.equal(read(path.join(p.library,'demo','SKILL.md')),'demo'); assert.deepEqual(syncLinks(p.options),[]);
});
test('Claude-only sharing never exposes content through the Codex/Pi common directory',()=>{
  const p=fixture(); p.make('claude'); p.approve({from:'claude',targets:['claude'],compatible:['claude']});
  assert.equal(fs.existsSync(p.shared),false); assert.equal(fs.existsSync(p.agents.codex.dir),false); assert.equal(fs.existsSync(p.agents.pi.dir),false);
});
test('Pi-only sharing does not touch other agents',()=>{
  const p=fixture(); p.make('pi'); p.approve({from:'pi',targets:['pi'],compatible:['pi']});
  assert.equal(read(path.join(p.agents.pi.dir,'demo','SKILL.md')),'demo');
  assert.equal(fs.existsSync(p.agents.codex.dir),false); assert.equal(fs.existsSync(p.agents.claude.dir),false); assert.equal(fs.existsSync(p.shared),false);
});
test('compatibility is not consent, and consent without compatibility is refused',()=>{
  const p=fixture(); p.make('codex');
  assert.throws(()=>p.approve({compatible:['codex']}),/reviewed compatibility/);
  p.approve({targets:['codex'],compatible:['codex','claude','pi']});
  syncLinks(p.options); assert.equal(fs.existsSync(p.agents.claude.dir),false); assert.equal(fs.existsSync(p.agents.pi.dir),false);
});
test('scope, targets, compatibility and dependency names are validated before mutation',()=>{
  const p=fixture(); const file=p.make('codex');
  for(const bad of [{scope:undefined},{scope:'all'},{targets:undefined},{compatible:undefined},{targets:['other']},{targets:['codex','codex']},{requires:{bad:['tool']}},{requires:{codex:['../escape']}},{requires:{codex:['demo']}}]) assert.throws(()=>p.approve(bad));
  for(const name of ['../escape','.system','constructor','eag','synced','Synced','EAG']) assert.throws(()=>share(name,{...p.options,targets:[],compatible:[]}));
  assert.equal(read(file),'demo'); assert.equal(fs.existsSync(p.library),false);
});
test('preview neither moves content nor creates policy, state or links',()=>{
  const p=fixture(); const file=p.make('codex'); p.approve({dryRun:true});
  assert.equal(read(file),'demo'); for(const f of [p.library,p.policy,p.state,p.agents.claude.dir]) assert.equal(fs.existsSync(f),false);
});
test('independent identical copies and conflicting copies are both preserved',()=>{
  for(const text of ['demo','different']) {
    const p=fixture(); const a=p.make('codex'); const b=p.make('claude','demo',text);
    assert.throws(()=>p.approve(),/unowned/); assert.equal(read(a),'demo'); assert.equal(read(b),text); assert.equal(fs.existsSync(p.library),false);
  }
});
test('broken and foreign destination links are never overwritten',()=>{
  const p=fixture(); p.make('codex'); fs.mkdirSync(p.agents.claude.dir,{recursive:true}); const link=path.join(p.agents.claude.dir,'demo'); fs.symlinkSync('missing',link);
  assert.throws(()=>p.approve(),/unowned/); assert.equal(fs.readlinkSync(link),'missing');
});
test('native markers, plugin manifests, source links and hidden system names stay provider-owned',()=>{
  for(const marker of ['.bundled','.codex-managed','.eag-managed','.claude-plugin/plugin.json','.codex-plugin/plugin.json']) {
    const p=fixture(); const file=p.make('codex'); write(path.join(p.agents.codex.dir,'demo',marker),'{}'); assert.throws(()=>p.approve(),/native|vendor/); assert.equal(read(file),'demo');
  }
  const p=fixture(); const file=p.make('library'); fs.mkdirSync(p.agents.codex.dir,{recursive:true}); fs.symlinkSync(path.dirname(file),path.join(p.agents.codex.dir,'demo'));
  assert.throws(()=>p.approve(),/link/); assert.equal(read(file),'demo');
});
test('internal symlinks and hardlinks cannot smuggle vendor files into another agent',()=>{
  for(const hard of [false,true]) {
    const p=fixture(); p.make('codex'); const outside=write(path.join(p.root,'private'),'private'); const link=path.join(p.agents.codex.dir,'demo','external');
    if(hard)fs.linkSync(outside,link);else fs.symlinkSync(outside,link);
    assert.throws(()=>p.approve(),/link/); assert.equal(read(outside),'private');
  }
});
test('explicit legacy migration removes only exact links to the selected shared source',()=>{
  const p=fixture(); p.make('shared'); fs.mkdirSync(p.agents.claude.dir,{recursive:true}); fs.symlinkSync(path.join(p.shared,'demo'),path.join(p.agents.claude.dir,'demo'));
  const result=p.approve({from:'shared',targets:['codex'],compatible:['codex']});
  assert.equal(result.removedLinks.length,1); assert.equal(fs.existsSync(path.join(p.shared,'demo')),false); assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'demo')),false);
  assert.equal(read(path.join(p.agents.codex.dir,'demo','SKILL.md')),'demo');
});
test('legacy migration with a foreign same-name link is all-or-nothing',()=>{
  const p=fixture(); const file=p.make('shared'); fs.mkdirSync(p.agents.claude.dir,{recursive:true}); fs.symlinkSync('missing',path.join(p.agents.claude.dir,'demo'));
  assert.throws(()=>p.approve({from:'shared'}),/unowned/); assert.equal(read(file),'demo'); assert.equal(fs.existsSync(p.library),false);
});
test('declared missing dependencies prevent sharing; installed dependencies permit it',()=>{
  const p=fixture(); const file=p.make('codex');
  assert.throws(()=>p.approve({requires:{claude:['computer-use']}}),/missing or unapproved dependency/);
  assert.equal(read(file),'demo'); p.make('claude','computer-use'); p.approve({requires:{claude:['computer-use']}});
  assert.equal(read(path.join(p.agents.claude.dir,'demo','SKILL.md')),'demo');
});
test('loss of a dependency revokes only the affected owned link and preserves source',()=>{
  const p=fixture(); p.make('codex'); const dependency=p.make('claude','tool'); p.approve({requires:{claude:['tool']}}); fs.unlinkSync(dependency);
  assert.ok(syncLinks(p.options).some(r=>r.agent==='claude'&&r.op==='unlink'));
  assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'demo')),false); assert.equal(read(path.join(p.agents.codex.dir,'demo','SKILL.md')),'demo'); assert.equal(read(path.join(p.library,'demo','SKILL.md')),'demo');
});
test('instruction or script edits invalidate approval until explicitly reviewed again',()=>{
  const p=fixture(); p.make('codex'); p.approve(); write(path.join(p.library,'demo','script.sh'),'echo changed');
  const preview=syncLinks({...p.options,dryRun:true}); assert.equal(preview.filter(r=>r.op==='unlink').length,2); assert.ok(fs.existsSync(path.join(p.agents.claude.dir,'demo')));
  syncLinks(p.options); assert.equal(fs.existsSync(path.join(p.agents.codex.dir,'demo')),false);
  p.approve({from:'library'}); assert.equal(read(path.join(p.agents.claude.dir,'demo','script.sh')),'echo changed');
});
test('revocation preserves content and does not re-enable itself on another sync',()=>{
  const p=fixture(); p.make('codex'); p.approve(); p.approve({from:'library',targets:[],compatible:[]}); syncLinks(p.options);
  for(const a of ['codex','claude']) assert.equal(fs.existsSync(path.join(p.agents[a].dir,'demo')),false);
  assert.equal(read(path.join(p.library,'demo','SKILL.md')),'demo');
});
test('editing policy to remove compatibility revokes an owned link',()=>{
  const p=fixture(); p.make('codex'); p.approve(); const policy=JSON.parse(read(p.policy)); policy.skills.demo.compatible=['codex']; write(p.policy,JSON.stringify(policy)); syncLinks(p.options);
  assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'demo')),false); assert.ok(fs.existsSync(path.join(p.agents.codex.dir,'demo')));
});
test('policy deletion revokes owned links while foreign replacements remain untouched',()=>{
  const p=fixture(); p.make('codex'); p.approve(); const cl=path.join(p.agents.claude.dir,'demo'); fs.unlinkSync(cl); p.make('claude','demo','private replacement'); fs.unlinkSync(p.policy);
  const result=syncLinks(p.options); assert.ok(result.some(r=>r.op==='conflict')); assert.equal(read(path.join(cl,'SKILL.md')),'private replacement'); assert.equal(fs.existsSync(path.join(p.agents.codex.dir,'demo')),false);
});
test('missing ownership never authorizes removal of existing links',()=>{
  const p=fixture(); p.make('codex'); p.approve(); fs.unlinkSync(p.state); fs.unlinkSync(p.policy);
  assert.equal(syncLinks(p.options).filter(r=>r.op==='conflict').length,2); assert.ok(fs.existsSync(path.join(p.agents.claude.dir,'demo')));
});
test('malformed policy and state fail without touching existing links',()=>{
  for(const which of ['policy','state']) {
    const p=fixture(); p.make('codex'); p.approve(); write(p[which],'[]'); assert.throws(()=>syncLinks(p.options),/invalid/); assert.equal(read(path.join(p.agents.claude.dir,'demo','SKILL.md')),'demo');
  }
});
test('failed initial linking restores the original directory and policy',()=>{
  const p=fixture(); const file=p.make('codex'); const original=fs.symlinkSync; fs.symlinkSync=()=>{throw new Error('injected failure');};
  try {assert.throws(()=>p.approve(),/original files restored/);} finally {fs.symlinkSync=original;}
  assert.equal(read(file),'demo'); assert.equal(fs.lstatSync(path.dirname(file)).isDirectory(),true); assert.equal(fs.existsSync(p.policy),false); assert.equal(fs.existsSync(path.join(p.library,'demo')),false);
});
test('failed policy persistence rolls back new links and source movement',()=>{
  const p=fixture(); const file=p.make('codex'); const original=fs.renameSync; fs.renameSync=(a,b)=>{if(b===p.policy)throw new Error('injected policy failure'); return original(a,b);};
  try {assert.throws(()=>p.approve(),/original files restored/);} finally {fs.renameSync=original;}
  assert.equal(read(file),'demo'); assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'demo')),false);
});
test('policy and state files are private and unrelated MCP policy is preserved',()=>{
  const p=fixture(); p.make('codex'); write(p.policy,JSON.stringify({servers:{test:{targets:{codex:false}}}})); p.approve();
  assert.equal(JSON.parse(read(p.policy)).servers.test.targets.codex,false);
  for(const f of [p.policy,p.state]) assert.equal(fs.statSync(f).mode&0o777,0o600);
});
test('managed dependency cycles fail closed without recursion overflow',()=>{
  const p=fixture(); p.make('codex'); p.make('codex','other'); p.approve({targets:['codex'],compatible:['codex']});
  share('other',{...p.options,from:'codex',targets:['codex'],compatible:['codex']});
  const policy=JSON.parse(read(p.policy)); policy.skills.demo.requires={codex:['other']}; policy.skills.other.requires={codex:['demo']}; write(p.policy,JSON.stringify(policy));
  assert.equal(syncLinks(p.options).filter(r=>r.op==='unlink').length,2);
});
test('fingerprinting is stable and includes executable scripts',()=>{
  const p=fixture(); p.make('codex'); const dir=path.join(p.agents.codex.dir,'demo'); const first=fingerprint(dir); assert.equal(fingerprint(dir),first);
  const script=write(path.join(dir,'run.sh'),'echo safe'); const next=fingerprint(dir); assert.notEqual(next,first); fs.chmodSync(script,0o700); assert.notEqual(fingerprint(dir),next);
});

test('fingerprint content cannot impersonate file boundaries',()=>{
  const p=fixture(); p.make('codex'); const dir=path.join(p.agents.codex.dir,'demo');
  const a=write(path.join(dir,'a'),'A'),b=write(path.join(dir,'b'),'B');const original=fingerprint(dir);
  write(a,'A'+JSON.stringify(['/b','file',0])+'\nB');fs.unlinkSync(b);
  assert.notEqual(fingerprint(dir),original);
});
test('a foreign replacement of an enrolled dependency blocks the dependent skill',()=>{
  const p=fixture();p.make('codex');p.make('codex','dep');share('dep',{...p.options,from:'codex',targets:['codex'],compatible:['codex']});
  p.approve({targets:['codex'],compatible:['codex'],requires:{codex:['dep']}});
  fs.unlinkSync(path.join(p.agents.codex.dir,'dep'));p.make('codex','dep','foreign');
  const result=syncLinks(p.options);assert.ok(result.some(r=>r.name==='demo'&&r.op==='unlink'));assert.equal(read(path.join(p.agents.codex.dir,'dep','SKILL.md')),'foreign');
});
test('target-filtered reconciliation does not mutate other agent links',()=>{
  const p=fixture();p.make('codex');p.approve();write(path.join(p.library,'demo','SKILL.md'),'changed');
  syncLinks({...p.options,target:['codex']});assert.equal(fs.existsSync(path.join(p.agents.codex.dir,'demo')),false);assert.equal(read(path.join(p.agents.claude.dir,'demo','SKILL.md')),'changed');
});
test('user-scope sharing keeps curated and plugin-owned sources untouched',()=>{
  write(path.join(process.env.CODEX_HOME,'vendor_imports','skills-curated-cache.json'),'{"skills":[{"name":"curated"}]}');
  const curated=write(path.join(AGENT_DIRS.codex.dir,'curated','SKILL.md'),'native');
  assert.throws(()=>share('curated',{scope:'user',from:'codex',targets:['claude'],compatible:['claude']}),/native/);assert.equal(read(curated),'native');
  const privateFile=write(path.join(AGENT_DIRS.codex.dir,'personal','SKILL.md'),'personal');
  const result=share('personal',{scope:'user',from:'codex',targets:['codex'],compatible:['codex']});
  assert.equal(read(privateFile),'personal');assert.equal(fs.lstatSync(path.dirname(privateFile)).isSymbolicLink(),true);
  assert.equal(fs.existsSync(path.join(SHARED,'personal')),false);assert.equal(fs.existsSync(path.join(AGENT_DIRS.claude.dir,'personal')),false);assert.equal(read(path.join(result.library,'SKILL.md')),'personal');
});
