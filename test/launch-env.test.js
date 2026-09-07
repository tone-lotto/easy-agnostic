import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandbox, write } from './helpers.js';
import { shellQuote } from '../src/util.js';

const dir = sandbox();
const shell = await import('../src/shell.js');
const { referencedNames, run } = await import('../src/commands/env.js');
const root = process.env.EAG_PROJECT;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('launch references respect user, project, and target policy plus native env pointers', () => {
  write(path.join(process.env.EAG_HOME, 'mcp.json'), JSON.stringify({ mcpServers: {
    shared: { command: 'node', env: { A: '${SHARED}' } },
    excluded: { command: 'node', env: { A: '${EXCLUDED}' } },
  } }));
  write(path.join(process.env.EAG_HOME, 'agents.json'), JSON.stringify({ targets: { codex: true }, servers: { excluded: { targets: { codex: false } }, shared: { codex: { env_vars: ['POINTER'] } } } }));
  write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node', env: { A: '${PROJECT_ONLY}' } } } }));
  assert.deepEqual([...referencedNames('codex')].sort(), ['POINTER', 'PROJECT_ONLY', 'SHARED']);
  write(path.join(root, '.agents/agents.json'), '{"targets":{"codex":false}}');
  assert.deepEqual([...referencedNames('codex')].sort(), ['POINTER', 'SHARED']);
  assert.throws(() => referencedNames('wrong'), /--target must/);
});

test('missing launch credentials emit no partial export payload', async () => {
  const log = console.log; const error = console.error;
  const lines = [];
  console.log = (line) => lines.push(line); console.error = () => {};
  process.env.SHARED = 'present';
  try { assert.equal(await run([], { target: 'codex' }), 1); assert.deepEqual(lines, []); }
  finally { console.log = log; console.error = error; delete process.env.SHARED; }
});

test('wrappers resolve on every launch without exporting to the parent or executing secret text', () => {
  const bin = path.join(dir, "bin 'quoted $literal `literal`");
  const valueFile = write(path.join(dir, 'value'), "first ' $(touch INJECTED) `touch INJECTED`\nline");
  const eag = write(path.join(bin, 'eag'), `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv[2] === 'env') { const value = fs.readFileSync(${JSON.stringify(valueFile)}, 'utf8'); console.log('export LAUNCH_SECRET=' + "'" + value.replace(/'/g, "'\\\\''") + "'"); }
`);
  fs.chmodSync(eag, 0o755);
  const agent = write(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({secret:process.env.LAUNCH_SECRET,args:process.argv.slice(2)}));`);
  fs.chmodSync(agent, 0o755);
  const init = write(path.join(dir, "init 'quoted $literal.sh"), shell.render(['claude'], { binDir: bin }));
  const script = `. "$1"
printf 'parent:%s\\n' "\${LAUNCH_SECRET-unset}"
claude 'argument with spaces' '$literal'
printf second > "$2"
claude
printf 'parent:%s\\n' "\${LAUNCH_SECRET-unset}"
`;
  const env = { ...process.env }; delete env.LAUNCH_SECRET;
  const output = execFileSync('/bin/sh', ['-c', script, 'sh', init, valueFile], { env, cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.equal(output[0], 'parent:unset');
  assert.deepEqual(JSON.parse(output[1]), { secret: "first ' $(touch INJECTED) `touch INJECTED`\nline", args: ['argument with spaces', '$literal'] });
  assert.equal(JSON.parse(output[2]).secret, 'second');
  assert.equal(output[3], 'parent:unset');
  assert.equal(fs.existsSync(path.join(dir, 'INJECTED')), false);
  const snippet = shell.rcSnippet(init);
  execFileSync('/bin/sh', ['-c', snippet], { cwd: dir, env });
  assert.equal(fs.existsSync(path.join(dir, 'INJECTED')), false);
});

test('shell quoting round-trips metacharacters literally', () => {
  const value = "'\"$HOME`id`$(id)\nnext";
  assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }), value);
});

test('failed credential resolution prevents launch; Pi does not run apply', () => {
  const bin = path.join(dir, 'failure-bin');
  const eag = write(path.join(bin, 'eag'), '#!/bin/sh\n[ "$1" = apply ] && exit 99\nexit 1\n');
  fs.chmodSync(eag, 0o755);
  const pi = write(path.join(bin, 'pi'), '#!/bin/sh\nprintf launched\n');
  fs.chmodSync(pi, 0o755);
  const init = write(path.join(dir, 'failure-init'), shell.render(['pi'], { binDir: bin }));
  const result = spawnSync('/bin/sh', ['-c', '. "$1"; pi', 'sh', init], { encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(shell.render(['pi']).includes('__eag_sync;'), false);
});

test('shell tracing does not print resolved credentials in sh, bash, or zsh', () => {
  const init = path.join(dir, "init 'quoted $literal.sh");
  write(path.join(dir, 'value'), 'trace-private-value');
  for (const binary of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((f) => fs.existsSync(f))) {
    const result = spawnSync(binary, ['-x', '-c', '. "$1"; claude', 'sh', init], { encoding: 'utf8', cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).secret, 'trace-private-value');
    assert.equal(result.stderr.includes('trace-private-value'), false, binary);
  }
});
