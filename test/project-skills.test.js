import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sandbox,write,read} from './helpers.js';
const base=sandbox();
const skills=await import('../src/skills.js');
const {share,syncLinks,policyLocations}=await import('../src/skill-policy.js');
const cli=path.resolve('bin/eag.js'); let serial=0;
function fixture(){const root=path.join(base,`project-${serial++}`);fs.mkdirSync(root);const options={scope:'project',root};return {root,options,...policyLocations(options)};}
const make=(dir,name,body=name)=>write(path.join(dir,name,'SKILL.md'),body);
const approve=(p,name='demo')=>share(name,{...p.options,from:'codex',targets:['codex','claude'],compatible:['codex','claude']});
const run=(p,...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,EAG_PROJECT:p.root,PATH:'/nonexistent',EAG_SHELL_RC:path.join(base,'rc')},encoding:'utf8',timeout:20000});
test.after(()=>fs.rmSync(base,{recursive:true,force:true}));

test('project sharing never moves inherited user skills or writes global policy',()=>{
  const p=fixture(); const global=make(skills.AGENT_DIRS.codex.dir,'global-only');make(p.agents.codex.dir,'demo');approve(p);
  assert.equal(read(global),'global-only');assert.equal(fs.existsSync(path.join(skills.SHARED,'demo')),false);
  assert.equal(fs.existsSync(path.join(process.env.EAG_HOME,'agents.json')),false);
  assert.throws(()=>share('global-only',{...p.options,from:'codex',targets:['claude'],compatible:['claude']}),/SKILL/);
});
test('project inventory keeps origins and inherited same-name entries distinct',()=>{
  const p=fixture();make(p.agents.codex.dir,'global-only');approve(p,'global-only');
  const rows=skills.inventory(p.options);
  assert.ok(rows.some(r=>r.name==='global-only'&&r.scope==='user'&&r.inherited));
  assert.ok(rows.some(r=>r.name==='global-only'&&r.origin==='library'&&r.sameNameInUserScope));
});
test('all four project directory aliases are refused without changing global content',()=>{
  for(const folder of ['.claude','.codex','.pi','.agents']){
    const p=fixture(); const global=path.join(base,`global-${serial}`);fs.mkdirSync(global);fs.symlinkSync(global,path.join(p.root,folder));
    assert.throws(()=>syncLinks(p.options),/symlinks|overlaps/);
    assert.deepEqual(fs.readdirSync(global),[]);
  }
});
test('library, policy, and state symlink attacks are refused',()=>{
  for(const key of ['library','policy','state']){
    const p=fixture();make(p.agents.codex.dir,'demo');const outside=write(path.join(p.root,'external'),'untouched');fs.mkdirSync(path.dirname(p[key]),{recursive:true});fs.symlinkSync(outside,p[key]);
    assert.throws(()=>approve(p),/symlinks/);assert.equal(read(outside),'untouched');
  }
});
test('CLI requires explicit scope and compatibility; previews are read-only',()=>{
  const p=fixture();make(p.agents.codex.dir,'demo');
  const args=['skills','share','demo','--from','codex','--to','codex,claude','--compatible','codex,claude'];
  assert.equal(run(p,...args).status,1);
  assert.equal(run(p,...args,'--scope','project','--dry-run','--json').status,0);
  assert.equal(fs.existsSync(p.library),false);
  const changed=run(p,...args,'--scope','project','--json');assert.equal(changed.status,0,changed.stderr||changed.stdout);
  const list=run(p,'skills','ls','--scope','project','--json');assert.equal(list.status,0,list.stderr);
  assert.ok(JSON.parse(list.stdout).skills.some(s=>s.origin==='library'&&s.approval.targets.includes('claude')));
  assert.equal(run(p,'skills','ls','--to','claude').status,1);
  assert.equal(run(p,'skills','sync','--scope','invalid').status,1);
});
test('CLI dependency validation prevents writes and none revokes all owned links',()=>{
  const p=fixture();make(p.agents.codex.dir,'demo');
  const args=['skills','share','demo','--scope','project','--from','codex','--to','claude','--compatible','claude'];
  assert.equal(run(p,...args,'--requires','claude:missing').status,1);assert.equal(fs.existsSync(p.library),false);
  assert.equal(run(p,...args).status,0);
  assert.equal(run(p,'skills','share','demo','--scope','project','--to','none','--compatible','none').status,0);
  assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'demo')),false);assert.equal(read(path.join(p.library,'demo','SKILL.md')),'demo');
});
test('legacy adopt CLI is diagnostic only, including dry-run',()=>{
  const p=fixture();const file=make(p.agents.codex.dir,'demo');
  for(const extra of [[],['--dry-run']])assert.equal(run(p,'adopt','skills','--scope','project',...extra).status,0);
  assert.equal(read(file),'demo');assert.equal(fs.existsSync(p.library),false);assert.equal(fs.existsSync(p.shared),false);
});
test('doctor --fix does not share unknown skills or deduplicate independent copies',()=>{
  const p=fixture();const a=make(p.shared,'unknown');const b=make(p.agents.codex.dir,'unknown');
  write(path.join(process.env.EAG_HOME,'mcp.json'),'{"mcpServers":{}}');
  const result=run(p,'doctor','--fix','--scope','project','--json');assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(read(a),'unknown');assert.equal(read(b),'unknown');assert.equal(fs.existsSync(p.agents.claude.dir),false);
  assert.ok(JSON.parse(result.stdout).checks.some(r=>r.level==='warn'&&r.msg.includes('unknown')));
});
test('doctor repairs approved project links but leaves user links alone',()=>{
  const p=fixture();make(p.agents.codex.dir,'demo');approve(p);fs.unlinkSync(path.join(p.agents.claude.dir,'demo'));
  const global=make(skills.SHARED,'unreviewed-global');
  const result=run(p,'doctor','--fix','--scope','project','--json');assert.equal(result.status,0,result.stderr||result.stdout);
  assert.equal(read(path.join(p.agents.claude.dir,'demo','SKILL.md')),'demo');assert.equal(read(global),'unreviewed-global');assert.equal(fs.existsSync(path.join(skills.AGENT_DIRS.claude.dir,'unreviewed-global')),false);
});
test('launch apply repairs approved skills-only projects and honors explicit user scope',()=>{
  const p=fixture();make(p.agents.codex.dir,'demo');approve(p);const link=path.join(p.agents.claude.dir,'demo');fs.unlinkSync(link);
  assert.equal(run(p,'apply','--scope','user','--json').status,0);assert.equal(fs.existsSync(link),false);
  const preview=run(p,'apply','--scope','project','--dry-run','--json');assert.equal(preview.status,0,preview.stderr||preview.stdout);assert.equal(fs.existsSync(link),false);
  const applied=run(p,'apply','--scope','project','--json');assert.equal(applied.status,0,applied.stderr||applied.stdout);assert.equal(read(path.join(link,'SKILL.md')),'demo');
});
test('generated SessionStart launcher links only approved skills and never enrolls unknown ones',async()=>{
  const {renderLauncher}=await import('../src/hooks.js');const p=fixture();make(p.agents.codex.dir,'demo');approve(p);make(p.shared,'unknown');fs.unlinkSync(path.join(p.agents.claude.dir,'demo'));
  const binDir=path.join(p.root,'bin');write(path.join(binDir,'eag'),`import ${JSON.stringify(cli)};`);
  const launcher=write(path.join(p.root,'eag-sync'),renderLauncher({entry:cli,binDir}));
  const result=spawnSync('/bin/sh',[launcher],{cwd:p.root,env:{...process.env,EAG_PROJECT:p.root,PATH:'/nonexistent'},encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(read(path.join(p.agents.claude.dir,'demo','SKILL.md')),'demo');assert.equal(fs.existsSync(path.join(p.agents.claude.dir,'unknown')),false);
});
test('orphaned links remain visible in inventory and doctor without retargeting',()=>{
  const p=fixture();fs.mkdirSync(p.agents.claude.dir,{recursive:true});const link=path.join(p.agents.claude.dir,'orphan');fs.symlinkSync('gone',link);
  const row=skills.inventory(p.options).find(r=>r.name==='orphan');assert.equal(row.broken,true);assert.equal(row.conflict,false);assert.equal(fs.readlinkSync(link),'gone');
});
test('same-name policy in another project cannot authorize a link',()=>{
  const p=fixture(),q=fixture();make(p.agents.codex.dir,'demo');approve(p);make(q.shared,'demo');syncLinks(q.options);
  assert.equal(fs.existsSync(q.agents.claude.dir),false);assert.equal(fs.existsSync(q.policy),false);
});
test('curated user skill names do not prevent independent project skills of the same name',()=>{
  const p=fixture();write(path.join(process.env.CODEX_HOME,'vendor_imports','skills-curated-cache.json'),'{"skills":[{"name":"demo"}]}');make(p.agents.codex.dir,'demo');approve(p);
  assert.ok(fs.existsSync(path.join(p.library,'demo','SKILL.md')));
});
