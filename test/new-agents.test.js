import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sandbox,write,read,mode} from './helpers.js';

const dir = sandbox(), root = process.env.EAG_PROJECT, home = process.env.EAG_HOME;
const {JSON_ADAPTERS} = await import('../src/adapters/registry.js');
const {buildPlan,applyPlan} = await import('../src/plan.js');
const {parseConfig} = await import('../src/json-config.js');
const {setSecret} = await import('../src/secrets.js');
const {share,syncLinks} = await import('../src/skill-policy.js');
const {providerHook} = await import('../src/provider-hooks.js');
const {main} = await import('../src/cli.js');
const {render} = await import('../src/shell.js');
const {referencedNames} = await import('../src/commands/env.js');
const {normalizeExport,importHistory} = await import('../src/history/import.js');
const history = await import('../src/history/index.js');
const {redactConfig} = await import('../src/redact.js');
const {instructionRule,RULE} = await import('../src/instruction-rule.js');
const {discoveryConsumers} = await import('../src/skill-policy.js');
const {binsInFile,writeInit} = await import('../src/shell.js');
const {mergeAgentPolicies} = await import('../src/source.js');
const agents = Object.keys(JSON_ADAPTERS);
const json = value => JSON.stringify(value,null,2);
function source(scope,servers={},enabled=agents) {
  const base = scope === 'user' ? home : path.join(root,'.agents');
  write(scope === 'user' ? path.join(home,'mcp.json') : path.join(root,'.mcp.json'),json({mcpServers:servers}));
  write(path.join(base,'agents.json'),json({targets:{claude:false,codex:false,pi:false,...Object.fromEntries(enabled.map(a=>[a,true]))},servers:{}}));
}
beforeEach(()=>{
  for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir,file),{recursive:true,force:true});
  for (const file of [home,root,process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR,process.env.PI_CODING_AGENT_DIR]) fs.mkdirSync(file,{recursive:true});
  source('user',{},[]);
});

test('project policy preserves other receivers denials and credential restrictions',()=>{
  const user = {targets:{cursor:true,opencode:true},servers:{demo:{targets:{cursor:false},opencode:{timeout:9}}}};
  const project = {servers:{demo:{targets:{opencode:false}}}};
  assert.deepEqual({...mergeAgentPolicies(user,project).servers.demo.targets},{cursor:false,opencode:false});
  write(path.join(home,'agents.json'),json(user));
  write(path.join(root,'.agents/agents.json'),json(project));
  write(path.join(root,'.mcp.json'),json({mcpServers:{demo:{command:'node',env:{TOKEN:'${DO_NOT_EXPORT}'}}}}));
  assert.equal(buildPlan('cursor-project',{root}).desired.size,0);
  assert.equal(referencedNames('cursor',root).size,0);
});

test('project enrollment listing matches inherited effective policy without creating overrides',async()=>{
  source('user',{},['cursor']);
  let output; const log = console.log; console.log = value=>{output=value;};
  try { assert.equal(await main(['agents','ls','--scope','project','--json']),0); } finally {console.log=log;}
  const rows = JSON.parse(output).agents;
  assert.equal(rows.find(r=>r.agent==='cursor').enabled,true);
  assert.equal(rows.find(r=>r.agent==='cursor').inherited,true);
  assert.equal(rows.find(r=>r.agent==='codex').enabled,false);
  assert.equal(fs.existsSync(path.join(root,'.agents/agents.json')),false);
});

test('project mcp target on explicitly overrides an inherited off',async()=>{
  source('user',{},['cursor']);
  write(path.join(home,'agents.json'),json({targets:{cursor:true},servers:{demo:{targets:{cursor:false,opencode:false}}}}));
  write(path.join(root,'.mcp.json'),json({mcpServers:{demo:{command:'node'}}}));
  await main(['mcp','target','demo','cursor','on','--scope','project']);
  const plan = buildPlan('cursor-project',{root});
  assert.equal(plan.desired.size,1); assert.equal(plan.agents.servers.demo.targets.opencode,false);
  assert.equal(JSON.parse(read(path.join(root,'.agents/agents.json'))).targets,undefined);
});

test('adopting a project server cannot re-enable globally disabled receivers',async()=>{
  write(path.join(root,'.mcp.json'),json({mcpServers:{}}));
  const native = JSON_ADAPTERS.cursor.file('project',root);
  write(native,json({mcpServers:{demo:{command:'node'}}}));
  await main(['adopt','cursor','--scope','project']);
  assert.equal(JSON.parse(read(path.join(root,'.agents/agents.json'))).targets,undefined);
  assert.ok(buildPlan('codex-project',{root}).skipped);
  assert.ok(buildPlan('cursor-project',{root}).skipped);
});

for (const agent of agents) for (const command of ['install','uninstall']) test(`${agent}: ${command} rolls back native changes when ownership recording fails`,()=>{
  const options = {scope:'project',root};
  const spec = providerHook(agent,options);
  if (command === 'uninstall') providerHook(agent,{...options,command:'install'});
  else if (agent !== 'opencode') write(spec.file,'{\n  // foreign settings\n  "foreign": true\n}\n');
  const before = fs.existsSync(spec.file) ? read(spec.file) : null;
  const stateFile = path.join(root,'.agents/.state',`hook-${agent}.json`);
  const stateBefore = fs.existsSync(stateFile) ? read(stateFile) : null;
  const rename = fs.renameSync;
  fs.renameSync = (from,to) => { if (to === stateFile) throw new Error('synthetic ownership write failure'); return rename(from,to); };
  try { assert.throws(()=>providerHook(agent,{...options,command}),/synthetic ownership/); } finally {fs.renameSync=rename;}
  assert.equal(fs.existsSync(spec.file) ? read(spec.file) : null,before);
  assert.equal(fs.existsSync(stateFile) ? read(stateFile) : null,stateBefore);
});

for (const agent of agents) test(`${agent}: uninstall forgets an already removed native hook without recreating files`,()=>{
  const options = {scope:'project',root};
  const installed = providerHook(agent,{...options,command:'install'});
  fs.unlinkSync(installed.file);
  providerHook(agent,{...options,command:'uninstall'});
  assert.equal(fs.existsSync(installed.file),false);
});

test('Cursor hooks with an unknown schema version are never changed',()=>{
  const file = write(path.join(root,'.cursor/hooks.json'),'{"version":2,"hooks":{}}');
  assert.throws(()=>providerHook('cursor',{scope:'project',root,command:'install'}),/unsupported Cursor hooks version/);
  assert.equal(read(file),'{"version":2,"hooks":{}}');
});

test('hook rollback never replaces a concurrent native edit',()=>{
  const options = {scope:'project',root,command:'install'};
  const file = path.join(root,'.cursor/hooks.json'), stateFile = path.join(root,'.agents/.state/hook-cursor.json');
  const rename = fs.renameSync;
  fs.renameSync = (from,to) => {
    if (to === stateFile) { fs.writeFileSync(file,'{"foreign":"concurrent"}'); throw new Error('synthetic failure'); }
    return rename(from,to);
  };
  try { assert.throws(()=>providerHook('cursor',options),/rollback withheld/); } finally {fs.renameSync=rename;}
  assert.equal(read(file),'{"foreign":"concurrent"}');
});

test('provider hooks refuse project destinations that equal a user destination',()=>{
  for (const [agent,envKey,folder] of [['cursor','CURSOR_CONFIG_DIR','.cursor'],['antigravity','ANTIGRAVITY_CONFIG_DIR','.agents'],['opencode','OPENCODE_CONFIG_DIR','.opencode']]) {
    assert.throws(()=>execFileSync(process.execPath,[path.resolve('bin/eag.js'),'hook','install','--target',agent,'--scope','project'],{
      cwd:root,env:{...process.env,[envKey]:path.join(root,folder)},stdio:'pipe',timeout:15000,
    }),error=>/overlaps a user configuration/.test(error.stderr.toString()));
  }
});

test('Antigravity hook ignores Cursor workspace environment and requires fixed project binding',()=>{
  const marker = path.join(dir,'hook-root.txt');
  const entry = write(path.join(dir,'fake-eag.cjs'),`require('fs').writeFileSync(${JSON.stringify(marker)},process.env.EAG_PROJECT);`);
  const handler = path.resolve('bin/eag-session-hook.js');
  execFileSync(process.execPath,[handler,'antigravity','user',entry],{cwd:root,env:{...process.env,CURSOR_PROJECT_DIR:dir,ANTIGRAVITY_PROJECT_DIR:root}});
  assert.equal(read(marker),root); fs.unlinkSync(marker);
  execFileSync(process.execPath,[handler,'antigravity','project',entry],{cwd:root,env:{...process.env}});
  assert.equal(fs.existsSync(marker),false);
});

test('new MCP targets are off by default and previews do not create native files',async()=>{
  source('user',{demo:{url:'https://example.test/mcp'}},[]);
  for (const agent of agents) {
    const plan = buildPlan(`${agent}-user`,{root}); assert.ok(plan.skipped);
    assert.equal(fs.existsSync(JSON_ADAPTERS[agent].file('user',root)),false);
  }
  assert.equal(await main(['agents','enable','cursor','--scope','project','--dry-run']),0);
  assert.equal(fs.existsSync(path.join(root,'.agents/agents.json')),false);
});

for (const agent of agents) {
  test(`${agent}: isolated user/project apply, idempotence, native conflicts and delete`,()=>{
    source('user',{global:{url:'https://global.test/mcp'}},[agent]);
    source('project',{local:{url:'https://local.test/mcp'}},[agent]);
    const adapter = JSON_ADAPTERS[agent];
    for (const scope of ['user','project']) {
      const plan = buildPlan(`${agent}-${scope}`,{root}); assert.deepEqual(plan.errors,[]);
      assert.equal(plan.actions.filter(a=>a.op === 'create').length,1);
      applyPlan(plan,{});
      const native = adapter.read(scope,root); assert.deepEqual([...native.servers.keys()],[scope === 'user' ? 'global' : 'local']);
      assert.equal(mode(native.file),0o600);
      assert.equal(applyPlan(buildPlan(`${agent}-${scope}`,{root}),{}).changed,false);
    }
    const native = adapter.read('project',root);
    write(native.file,read(native.file).replace('local.test','manual.test'));
    const conflict = buildPlan(`${agent}-project`,{root}); assert.ok(conflict.actions.some(a=>a.op === 'conflict'));
    applyPlan(conflict,{}); assert.match(read(native.file),/manual.test/);
    applyPlan(buildPlan(`${agent}-project`,{root,prefer:'source'}),{}); assert.match(read(native.file),/local.test/);
    source('project',{},[agent]); applyPlan(buildPlan(`${agent}-project`,{root}),{});
    assert.equal(adapter.read('project',root).servers.size,0);
    assert.equal(adapter.read('user',root).servers.size,1);
  });

  test(`${agent}: secrets resolve privately, missing credentials block and dry-run is redacted`,async()=>{
    source('project',{private:{url:'https://example.test/mcp',headers:{Authorization:'Bearer ${DEMO_TOKEN}'}}},[agent]);
    let plan = buildPlan(`${agent}-project`,{root}); assert.equal(plan.errors.length,1);
    setSecret('DEMO_TOKEN','short-secret');
    plan = buildPlan(`${agent}-project`,{root}); assert.deepEqual(plan.errors,[]);
    const {toJson} = await import('../src/commands/status.js');
    assert.doesNotMatch(json(toJson(plan)),/short-secret/);
    applyPlan(plan,{dryRun:true}); assert.equal(fs.existsSync(JSON_ADAPTERS[agent].file('project',root)),false);
    applyPlan(plan,{}); assert.match(read(JSON_ADAPTERS[agent].file('project',root)),/short-secret/);
  });

  test(`${agent}: stale plans, malformed files and path aliases fail closed`,()=>{
    source('project',{demo:{url:'https://example.test'}},[agent]);
    const adapter = JSON_ADAPTERS[agent], nativeFile = adapter.file('project',root);
    const plan = buildPlan(`${agent}-project`,{root}); write(nativeFile,'{"manual":true}');
    assert.throws(()=>applyPlan(plan,{}),/changed/);
    write(nativeFile,'{"broken":'); assert.throws(()=>buildPlan(`${agent}-project`,{root}),/invalid/);
    fs.unlinkSync(nativeFile); const foreign = write(path.join(dir,`${agent}-foreign.json`),'{}'); fs.symlinkSync(foreign,nativeFile);
    assert.throws(()=>buildPlan(`${agent}-project`,{root}),/alias/); assert.equal(read(foreign),'{}');
  });

  test(`${agent}: explicit native adoption round trips without enabling other agents`,async()=>{
    source('project',{},[]);
    const adapter = JSON_ADAPTERS[agent], obj = adapter.render('local',{command:'node',args:['server.js']},{secrets:'literal'});
    write(adapter.file('project',root),json({[agent === 'opencode' ? 'mcp' : 'mcpServers']:{local:obj}}));
    assert.equal(await main(['adopt',agent,'--scope','project']),0);
    assert.deepEqual(JSON.parse(read(path.join(root,'.mcp.json'))).mcpServers.local,{command:'node',args:['server.js']});
    const policy = JSON.parse(read(path.join(root,'.agents/agents.json'))); assert.notEqual(policy.targets[agent],true);
  });
}

test('JSONC edits preserve unrelated settings, comments and foreign MCP entries',()=>{
  source('project',{demo:{url:'https://example.test'}},['cursor']);
  const file = JSON_ADAPTERS.cursor.file('project',root);
  write(file,'{\n  // keep this comment\n  "other": {"custom": true},\n  "mcpServers": {\n    // native server note\n    "foreign": {"url":"https://foreign.test"},\n  },\n}\n');
  applyPlan(buildPlan('cursor-project',{root}),{});
  const after = read(file); assert.match(after,/keep this comment/); assert.match(after,/native server note/);
  assert.equal(parseConfig(after).other.custom,true); assert.equal(parseConfig(after).mcpServers.foreign.url,'https://foreign.test');
});

test('duplicate/reserved keys, non-object roots and invalid JSONC are refused',()=>{
  for (const input of ['{"mcp":{},"mcp":{}}','{"__proto__":{}}','null','[]','{"a": NaN}']) assert.throws(()=>parseConfig(input));
});

test('OpenCode JSONC and existing v2 nested servers preserve sibling policy',()=>{
  source('project',{demo:{url:'https://example.test'}},['opencode']);
  const file = path.join(root,'opencode.jsonc');
  write(file,'{ // v2 fixture\n "permission": {"bash":"ask"}, "mcp": {"servers":{},"timeout":1000}}');
  applyPlan(buildPlan('opencode-project',{root}),{});
  const result = parseConfig(read(file)); assert.ok(result.mcp.servers.demo); assert.equal(result.mcp.timeout,1000); assert.equal(result.permission.bash,'ask');
  write(path.join(root,'opencode.json'),'{}'); assert.throws(()=>buildPlan('opencode-project',{root}),/both opencode/);
});

test('native short credentials and OpenCode command arguments are masked',()=>{
  const safe = json(redactConfig({environment:{TOKEN:'abc'},command:['node','--secret','xyz'],serverUrl:'https://u:p@example.test/path?token=foo'}));
  for (const secret of ['abc','xyz','u:p','token=foo']) assert.ok(!safe.includes(secret));
});

test('Cursor/OpenCode env reference mapping is reversible; Antigravity cwd bridge does not execute args as code',()=>{
  for (const agent of ['cursor','opencode']) {
    const original = {command:'node',args:['server.js'],env:{TOKEN:'${TOKEN}'}};
    const native = JSON_ADAPTERS[agent].render('demo',original,{secrets:'env'});
    assert.deepEqual(JSON_ADAPTERS[agent].toSource(native).entry,original);
  }
  const original = {command:process.execPath,args:['-e','process.stdout.write(process.argv[1])','$(do-not-execute)'],cwd:root};
  const native = JSON_ADAPTERS.antigravity.render('demo',original,{});
  assert.equal(execFileSync(native.command,native.args,{encoding:'utf8'}),'$(do-not-execute)');
  assert.deepEqual(JSON_ADAPTERS.antigravity.toSource(native).entry,original);
});

test('new agents receive no credentials before enrollment and only allowed references afterward',()=>{
  source('user',{demo:{command:'node',env:{TOKEN:'${TOKEN}'}}},[]);
  assert.equal(referencedNames('opencode',root).size,0);
  source('project',{project:{command:'node',env:{PROJECT_TOKEN:'${PROJECT_TOKEN}'}}},['opencode']);
  assert.deepEqual([...referencedNames('opencode',root)],['PROJECT_TOKEN']);
});

test('skill links use per-agent directories and Antigravity avoids the shared discovery folder',()=>{
  const from = write(path.join(root,'.agents/skills/demo/SKILL.md'),'---\nname: demo\ndescription: Demo\n---\nportable');
  share('demo',{scope:'project',root,from:'shared',targets:agents,compatible:agents});
  for (const folder of ['.cursor','.agent','.opencode']) assert.ok(fs.lstatSync(path.join(root,folder,'skills/demo')).isSymbolicLink());
  assert.equal(fs.existsSync(from),false); assert.equal(fs.existsSync(path.join(home,'skills/demo')),false);
});

test('known indirect consumers require approval before a skill can be linked',()=>{
  fs.mkdirSync(process.env.CURSOR_CONFIG_DIR);
  write(path.join(root,'.codex/skills/demo/SKILL.md'),'demo');
  assert.throws(()=>share('demo',{scope:'project',root,from:'codex',targets:['codex'],compatible:['codex']}),/also discoverable by cursor/);
  assert.ok(fs.existsSync(path.join(root,'.codex/skills/demo/SKILL.md')));
  share('demo',{scope:'project',root,from:'codex',targets:['codex','cursor'],compatible:['codex','cursor']});
  assert.ok(fs.lstatSync(path.join(root,'.cursor/skills/demo')).isSymbolicLink());
});

test('new receiver discovery suspends existing owned links without deleting skill source',()=>{
  write(path.join(root,'.codex/skills/demo/SKILL.md'),'demo');
  share('demo',{scope:'project',root,from:'codex',targets:['codex'],compatible:['codex']});
  fs.mkdirSync(process.env.CURSOR_CONFIG_DIR);
  assert.ok(syncLinks({scope:'project',root,target:['cursor']}).some(r=>r.op === 'unlink'));
  assert.equal(fs.existsSync(path.join(root,'.codex/skills/demo')),false);
  assert.equal(read(path.join(root,'.agents/skill-library/demo/SKILL.md')),'demo');
});

for (const agent of agents) test(`${agent}: provider hooks install, status, idempotence, edit protection and uninstall`,()=>{
  const options = {scope:'project',root};
  const preview = providerHook(agent,{...options,command:'install',dryRun:true}); assert.equal(fs.existsSync(preview.file),false);
  const installed = providerHook(agent,{...options,command:'install'}); assert.ok(fs.existsSync(installed.file));
  assert.equal(providerHook(agent,options).current,true);
  assert.equal(providerHook(agent,{...options,command:'install'}).changed,false);
  const original = read(installed.file); write(installed.file,original.replace('eag-session-hook.js','edited-hook.js').replace('No transcript collection','User edited plugin'));
  assert.throws(()=>providerHook(agent,{...options,command:'uninstall'}),/changed|modified/);
  write(installed.file,original); providerHook(agent,{...options,command:'uninstall'});
  assert.equal(providerHook(agent,options).current,false);
});

test('OpenCode plugin executes only a session-created event in the correct project',async()=>{
  const mark = path.join(dir,'invocation.json'), entry = write(path.join(dir,'fake-eag.cjs'),`require('fs').writeFileSync(${JSON.stringify(mark)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));`);
  write(path.join(root,'package.json'),'{"type":"module"}');
  const installed = providerHook('opencode',{scope:'project',root,command:'install',entry});
  const {EasyAgnostic} = await import(pathToFileURL(installed.file));
  const plugin = await EasyAgnostic({directory:dir});
  await plugin.event({event:{type:'message.updated'}}); assert.equal(fs.existsSync(mark),false);
  await plugin.event({event:{type:'session.created'}});
  const actual = JSON.parse(read(mark)); assert.equal(actual.cwd,root); assert.ok(actual.args.includes('opencode')); assert.ok(actual.args.includes('project'));
});

test('new terminal wrappers use correct target IDs and project-aware sync',()=>{
  const shell = render(['cursor-agent','agy','opencode']);
  for (const agent of agents) assert.match(shell,new RegExp(`env --target ${agent}`));
  assert.doesNotMatch(shell,/env --target agy|env --target cursor-agent/);
  assert.match(shell,/apply --scope all --target cursor/);
});

test('OpenCode export retains visible messages, omits reasoning and enforces project/session metadata',()=>{
  const data = {info:{id:'ses_test',directory:root},messages:[{info:{role:'assistant',sessionID:'ses_test'},parts:[{type:'reasoning',text:'hidden'},{type:'text',text:'visible'}]}]};
  const records = normalizeExport('opencode',json(data),{project:root}); assert.equal(records[1].text,'visible'); assert.equal(records.length,2);
  assert.throws(()=>normalizeExport('opencode',json(data),{project:dir,bindProject:true}),/does not match/);
  data.messages[0].info.sessionID = 'another'; assert.throws(()=>normalizeExport('opencode',json(data),{project:root}),/mixed sessions/);
});

test('Cursor and Antigravity unbound exports require explicit attestation, ignore reasoning headings and preserve code fences',()=>{
  const md = '# User\nQuestion\n# Thinking\nhidden\n# Assistant\nAnswer\n```md\n# User\ncode example\n```';
  for (const vendor of ['cursor','antigravity']) {
    assert.throws(()=>normalizeExport(vendor,md,{project:root}),/bind-project/);
    const records = normalizeExport(vendor,md,{project:root,bindProject:true});
    assert.equal(records[0].binding,'user-attested'); assert.equal(records.length,3);
    assert.doesNotMatch(json(records),/hidden/); assert.match(records[2].text,/# User/);
  }
});

test('imported history is private, project-filtered, queryable and never overwrites an output',()=>{
  const file = write(path.join(dir,'export.md'),'# User\nFind this evidence\n# Assistant\nRecorded answer');
  const result = importHistory('cursor',{file,project:root,bindProject:true}); assert.equal(mode(result.output),0o600);
  let ctx = history.context({project:root,vendor:'cursor'}), sessions = history.discover(ctx);
  assert.equal(sessions.length,1); assert.equal(sessions[0].binding,'user-attested');
  assert.equal(history.load(ctx,sessions[0]).events.length,2);
  ctx = history.context({project:dir,vendor:'cursor'}); assert.equal(history.discover(ctx).length,0);
  assert.throws(()=>importHistory('cursor',{file,project:root,bindProject:true,output:result.output}),/EEXIST/);
});

test('OpenCode v2 is selectable for a new configuration and a v1 server named servers is not misclassified',async()=>{
  source('project',{demo:{command:'node'}},[]);
  assert.equal(await main(['agents','enable','opencode','--scope','project','--mcp-format','v2']),0);
  applyPlan(buildPlan('opencode-project',{root}),{});
  const file = JSON_ADAPTERS.opencode.file('project',root);
  assert.equal(JSON.parse(read(file)).mcp.servers.demo.type,'local');
  write(file,json({mcp:{servers:{type:'local',command:['node']}}}));
  assert.deepEqual([...JSON_ADAPTERS.opencode.read('project',root).servers.keys()],['servers']);
  assert.throws(()=>buildPlan('opencode-project',{root}),/format differs/);
});

test('enrolling a new project receiver does not re-enable unrelated globally disabled agents',async()=>{
  assert.equal(await main(['agents','enable','cursor','--scope','project']),0);
  assert.deepEqual(JSON.parse(read(path.join(root,'.agents/agents.json'))).targets,{cursor:true});
  write(path.join(root,'.mcp.json'),json({mcpServers:{demo:{command:'node'}}}));
  assert.ok(buildPlan('codex-project',{root}).skipped);
});

test('new JSON adapters reject hardlinks and tighten a widened native file on no-op',()=>{
  source('project',{demo:{command:'node'}},['cursor']);
  applyPlan(buildPlan('cursor-project',{root}),{});
  const file = JSON_ADAPTERS.cursor.file('project',root);
  fs.chmodSync(file,0o644); applyPlan(buildPlan('cursor-project',{root}),{}); assert.equal(mode(file),0o600);
  fs.linkSync(file,path.join(dir,'alias.json'));
  assert.throws(()=>JSON_ADAPTERS.cursor.read('project',root),/non-linked/);
});

test('Antigravity rules are project-only, explicitly activated, removable and edit protected',()=>{
  write(path.join(root,'AGENTS.md'),'Shared content');
  write(path.join(root,'CLAUDE.md'),'Private Claude-only content');
  const preview = instructionRule(root,{dryRun:true}); assert.equal(preview.op,'sync');
  const file = path.join(root,'.agent/rules/eag-project.md'); assert.equal(fs.existsSync(file),false);
  instructionRule(root); assert.equal(read(file),RULE); assert.equal(mode(file),0o600);
  assert.match(instructionRule(root,{status:true}).activation,/Always On/);
  assert.equal(instructionRule(root).op,'noop');
  assert.doesNotMatch(read(file),/Private Claude/); assert.equal(fs.existsSync(path.join(process.env.ANTIGRAVITY_CONFIG_DIR,'GEMINI.md')),false);
  write(file,RULE+'User edits'); assert.throws(()=>instructionRule(root,{remove:true}),/modified/);
  write(file,RULE); instructionRule(root,{remove:true}); assert.equal(fs.existsSync(file),false);
});

test('instruction bridge refuses unowned files and symlinked rules directories',()=>{
  write(path.join(root,'AGENTS.md'),'Shared');
  const file = write(path.join(root,'.agent/rules/eag-project.md'),'Mine');
  assert.throws(()=>instructionRule(root),/unowned/); assert.equal(read(file),'Mine');
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); fs.symlinkSync(dir,path.dirname(file));
  assert.throws(()=>instructionRule(root),/aliases/);
});

test('wrapper refresh remembers agy and cursor-agent without their executables on PATH',()=>{
  writeInit(['agy','cursor-agent','opencode']);
  assert.deepEqual(binsInFile(),['agy','cursor-agent','opencode']);
});

test('native skill cross-discovery is reported without modifying the unowned source',()=>{
  fs.mkdirSync(process.env.CURSOR_CONFIG_DIR);
  const file = write(path.join(root,'.codex/skills/private/SKILL.md'),'Native');
  assert.deepEqual(discoveryConsumers({scope:'project',origin:'codex'},{root}),['cursor']);
  assert.equal(read(file),'Native');
});

test('ambiguous boolean flags cannot turn an import preview into a write',async()=>{
  const file = write(path.join(dir,'history.md'),'# User\nQuestion');
  assert.equal(await main(['history','import','cursor','--file',file,'--project',root,'--bind-project','--dry-run=false','--json']),1);
  assert.equal(fs.existsSync(path.join(home,'.state/history')),false);
  await assert.rejects(()=>main(['agents','enable','cursor','--scope','project','--dry-run=false']),/boolean/);
});

test('explicit launcher handles a binary alias, forwards arguments and keeps secrets in the child',()=>{
  source('project',{demo:{command:'node',env:{TOKEN:'${LAUNCH_ONLY_TOKEN}'}}},['cursor']);
  setSecret('LAUNCH_ONLY_TOKEN','test-fixture-value');
  const mark = path.join(dir,'launch.json');
  const child = write(path.join(dir,'child.cjs'),`require('fs').writeFileSync(${JSON.stringify(mark)},JSON.stringify({cwd:process.cwd(),token:process.env.LAUNCH_ONLY_TOKEN,args:process.argv.slice(2)}));`);
  execFileSync(process.execPath,[path.resolve('bin/eag.js'),'run','cursor','--binary',process.execPath,'--',child,'--arbitrary','literal ; $()'],{cwd:root,env:{...process.env},timeout:15000});
  const actual = JSON.parse(read(mark)); assert.equal(actual.cwd,root); assert.equal(actual.token,'test-fixture-value');
  assert.deepEqual(actual.args,['--arbitrary','literal ; $()']); assert.equal(process.env.LAUNCH_ONLY_TOKEN,undefined);
});

test('provider-specific interpolation is not adopted as a portable literal',()=>{
  assert.throws(()=>JSON_ADAPTERS.cursor.toSource({command:'node',args:['${workspaceFolder}']}),/not portable/);
  assert.throws(()=>JSON_ADAPTERS.opencode.toSource({type:'local',command:['node'],environment:{TOKEN:'{file:./secret}'}}),/not portable/);
});

for (const agent of agents) test(`${agent}: real CLI workflow in an isolated project`,()=>{
  const cli = args => execFileSync(process.execPath,[path.resolve('bin/eag.js'),...args],{cwd:root,env:{...process.env,EAG_UPDATE_CHECK:'0'},encoding:'utf8',timeout:15000});
  cli(['mcp','add','demo','--command','node','--arg=--version','--scope','project']);
  cli(['agents','enable',agent,'--scope','project']);
  cli(['apply','--scope','project','--target',agent]);
  assert.equal(JSON_ADAPTERS[agent].read('project',root).servers.size,1);
  assert.equal(JSON_ADAPTERS[agent].read('user',root).servers.size,0);
  cli(['hook','install','--target',agent,'--scope','project']);
  assert.equal(JSON.parse(cli(['hook','status','--target',agent,'--scope','project','--json'])).current,true);
  write(path.join(root,'.agents/skills/portable/SKILL.md'),'---\nname: portable\ndescription: Portable test\n---\nInstructions');
  cli(['skills','share','portable','--scope','project','--from','shared','--to',agent,'--compatible',agent]);
  assert.ok(JSON.parse(cli(['skills','ls','--scope','project','--json'])).skills.some(s=>s.origin === agent));
  const file = write(path.join(dir,'export.json'),json(agent === 'opencode' ? {info:{id:'ses_cli',directory:root},messages:[{info:{role:'user'},parts:[{type:'text',text:'Isolated evidence'}]}]}
    : {type:'user',session_id:'ses_cli',cwd:root,text:'Isolated evidence'}));
  cli(['history','import',agent,'--file',file,'--project',root]);
  assert.equal(JSON.parse(cli(['history','list','--vendor',agent,'--json'])).total,1);
  cli(['hook','uninstall','--target',agent,'--scope','project']);
  cli(['agents','disable',agent,'--scope','project']);
  assert.equal(JSON_ADAPTERS[agent].read('project',root).servers.size,1);
});
