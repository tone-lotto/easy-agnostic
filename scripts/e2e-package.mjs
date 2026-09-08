// Verify the published shape, not imports from the checkout. Synthetic inputs only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../',import.meta.url));
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'eag-package-e2e-'));
const project = path.join(scratch,'project'), prefix = path.join(scratch,'install');
fs.mkdirSync(project); fs.mkdirSync(prefix);
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(npm_config_|npm_token$|node_auth_token$|node_options$|node_path$)/i.test(key)) delete env[key];
Object.assign(env,{
  EAG_HOME:path.join(scratch,'eag'),EAG_PROJECT:project,EAG_SECRET_BACKEND:'file',EAG_NO_UPDATE:'1',
  CLAUDE_CONFIG_DIR:path.join(scratch,'claude'),CODEX_HOME:path.join(scratch,'codex'),PI_CODING_AGENT_DIR:path.join(scratch,'pi'),
  CURSOR_CONFIG_DIR:path.join(scratch,'cursor'),ANTIGRAVITY_CONFIG_DIR:path.join(scratch,'antigravity'),OPENCODE_CONFIG_DIR:path.join(scratch,'opencode'),
});
const userConfig = path.join(scratch,'user.npmrc'), globalConfig = path.join(scratch,'global.npmrc');
fs.writeFileSync(userConfig,'',{mode:0o600}); fs.writeFileSync(globalConfig,'',{mode:0o600});
const npmArgs = ['--ignore-scripts','--registry=https://registry.npmjs.org',`--userconfig=${userConfig}`,`--globalconfig=${globalConfig}`,`--cache=${path.join(scratch,'cache')}`];
const npm = args => execFileSync('npm',[...args,...npmArgs],{cwd:repo,env,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
try {
  const [packed] = JSON.parse(npm(['pack','--json','--pack-destination',scratch]));
  const members = new Set(packed.files.map(f=>f.path));
  for (const file of ['bin/eag-session-hook.js','src/adapters/cursor.js','src/adapters/antigravity.js','src/adapters/opencode.js','docs/agents.md','skills/eag/SKILL.md']) assert.ok(members.has(file),`missing packaged ${file}`);
  assert.ok([...members].every(file=>!file.startsWith('test/') && !file.startsWith('.agents/') && !file.startsWith('.codex/')));
  npm(['install','--prefix',prefix,'--no-audit','--no-fund',path.join(scratch,packed.filename)]);
  const entry = path.join(prefix,'node_modules/easy-agnostic/bin/eag.js');
  const cli = args => execFileSync(process.execPath,[entry,...args],{cwd:project,env,encoding:'utf8',timeout:15000});
  assert.equal(cli(['--version']).trim(),JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).version);
  const enrollment = JSON.parse(cli(['agents','ls','--scope','project','--json']));
  for (const agent of ['cursor','antigravity','opencode']) assert.equal(enrollment.agents.find(a=>a.agent===agent).enabled,false);
  cli(['mcp','add','fixture','--command','node','--arg=--version','--scope','project']);
  const metadata = {cursor:'.cursor/mcp.json',antigravity:'.agents/mcp_config.json',opencode:'opencode.json'};
  for (const agent of Object.keys(metadata)) {
    cli(['agents','enable',agent,'--scope','project']);
    cli(['apply','--scope','project','--target',agent]);
    const file = path.join(project,metadata[agent]);
    assert.equal(fs.statSync(file).mode & 0o777,0o600);
    const snapshot = fs.readFileSync(file,'utf8');
    cli(['apply','--scope','project','--target',agent]); assert.equal(fs.readFileSync(file,'utf8'),snapshot);
    cli(['hook','install','--target',agent,'--scope','project']);
    assert.equal(JSON.parse(cli(['hook','status','--target',agent,'--scope','project','--json'])).current,true);
    cli(['hook','uninstall','--target',agent,'--scope','project']);
  }
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Shared fixture instructions.\n');
  cli(['instructions','--target','antigravity']);
  assert.match(fs.readFileSync(path.join(project,'.agent/rules/eag-project.md'),'utf8'),/@\.\.\/\.\.\/AGENTS\.md/);
  const transcript = path.join(scratch,'export.json');
  fs.writeFileSync(transcript,JSON.stringify({info:{id:'ses_package',directory:project},messages:[{info:{role:'user'},parts:[{type:'text',text:'Package fixture evidence'}]}]}));
  cli(['history','import','opencode','--file',transcript,'--project',project]);
  assert.equal(JSON.parse(cli(['history','list','--vendor','opencode','--json'])).total,1);
  assert.equal(JSON.parse(cli(['history','list','--vendor','opencode','--project',scratch,'--json'])).total,0);
  for (const key of ['CURSOR_CONFIG_DIR','ANTIGRAVITY_CONFIG_DIR','OPENCODE_CONFIG_DIR']) assert.equal(fs.existsSync(env[key]),false,'project workflow created a user directory');
  assert.equal(fs.existsSync(path.join(env.EAG_HOME,'mcp.json')),false);
  console.log('Package integration passed: real npm tarball install, three isolated project adapters/hooks, instructions and project-filtered history.');
  fs.rmSync(scratch,{recursive:true,force:true}); // only our uniquely created synthetic fixture
} catch (error) {
  console.error(`Package integration failed; synthetic fixtures retained at ${scratch}`);
  throw error;
}
