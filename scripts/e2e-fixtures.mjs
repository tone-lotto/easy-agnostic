import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(repo, 'test', 'fixtures');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'eag-fixture-e2e-'));
const bin = path.join(scratch, 'bin');
for (const dir of [bin, path.join(scratch, 'cc'), path.join(scratch, 'codex')]) fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.join(fixture, 'claude.json'), path.join(scratch, 'cc', '.claude.json'));
fs.copyFileSync(path.join(fixture, 'codex.toml'), path.join(scratch, 'codex', 'config.toml'));
for (const agent of ['claude', 'codex']) {
  fs.copyFileSync(path.join(fixture, 'agent-cli.cjs'), path.join(bin, agent));
  fs.chmodSync(path.join(bin, agent), 0o755);
}
fs.symlinkSync(path.join(repo, 'bin', 'eag.js'), path.join(bin, 'eag'));
const env = {
  ...process.env,
  PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  CLAUDE_CONFIG_DIR: path.join(scratch, 'cc'), CODEX_HOME: path.join(scratch, 'codex'),
  EAG_SECRET_BACKEND: 'file', EAG_NO_UPDATE: '1', npm_config_prefix: scratch,
};
delete env.EAG_PROJECT;
delete env.KEEP_SANDBOX;
console.log('Fixture integration: fake agent CLIs, file secret backend, no personal configs.');
const child = spawn('/bin/bash', [path.join(repo, 'scripts', 'e2e.sh'), path.join(scratch, 'run')], { env, cwd: repo, stdio: 'inherit' });
const result = await new Promise((resolve) => {
  child.once('error', () => resolve(1));
  child.once('exit', (code) => resolve(code ?? 1));
});
if (result === 0) fs.rmSync(scratch, { recursive: true, force: true });
else console.error(`Fixture integration failed; diagnostic fixtures retained at ${scratch}`);
process.exitCode = result;
