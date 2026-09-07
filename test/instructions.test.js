import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandbox, write, read, mode } from './helpers.js';

const dir = sandbox();
const { syncInstructions, instructionPaths, BEGIN, END } = await import('../src/instructions.js');
const cli = path.resolve('bin/eag.js');
let count = 0;
function project() {
  const root = path.join(dir, `instructions-${count++}`);
  fs.mkdirSync(root);
  return { root, a: path.join(root, 'AGENTS.md'), c: path.join(root, 'CLAUDE.md') };
}
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

for (const side of ['a', 'c']) test(`initial adoption from ${side} and edits in both directions`, () => {
  const p = project();
  write(p[side], 'Initial\r\n');
  assert.equal(syncInstructions(p.root).op, 'sync');
  assert.equal(read(p.a), 'Initial\r\n');
  assert.equal(read(p.c), read(p.a));
  write(p.a, 'Edited by Codex\n');
  syncInstructions(p.root);
  assert.equal(read(p.c), 'Edited by Codex\n');
  write(p.c, 'Edited by Claude\n');
  syncInstructions(p.root);
  assert.equal(read(p.a), 'Edited by Claude\n');
  assert.equal(syncInstructions(p.root).op, 'noop');
});

test('different initial files and simultaneous edits are conflicts; explicit winner persists', () => {
  const p = project();
  write(p.a, 'A'); write(p.c, 'C');
  assert.equal(syncInstructions(p.root).op, 'conflict');
  assert.equal(read(p.a), 'A'); assert.equal(read(p.c), 'C');
  syncInstructions(p.root, { prefer: 'agents' });
  write(p.a, 'new A'); write(p.c, 'new C');
  assert.equal(syncInstructions(p.root).op, 'conflict');
  syncInstructions(p.root, { prefer: 'claude' });
  assert.equal(read(p.a), 'new C');
  assert.equal(syncInstructions(p.root).op, 'noop');
});

test('preview creates neither counterpart nor state directories', () => {
  const p = project(); write(p.c, 'Private instructions');
  const paths = instructionPaths(p.root);
  assert.equal(syncInstructions(p.root, { dryRun: true }).op, 'sync');
  assert.equal(fs.existsSync(p.a), false);
  assert.equal(fs.existsSync(paths.dir), false);
});

test('unregistered projects are skipped by automatic sync', () => {
  const p = project(); write(p.c, 'Instructions');
  assert.equal(syncInstructions(p.root, { trackedOnly: true }).op, 'skipped');
  assert.equal(fs.existsSync(p.a), false);
});

test('equal and empty files enroll; deleting one requires explicit resolution', () => {
  const p = project(); write(p.a, ''); write(p.c, '');
  assert.equal(syncInstructions(p.root).op, 'enroll');
  fs.unlinkSync(p.c);
  assert.equal(syncInstructions(p.root).op, 'conflict');
  assert.throws(() => syncInstructions(p.root, { prefer: 'claude' }), /does not exist/);
  syncInstructions(p.root, { prefer: 'agents' });
  assert.equal(read(p.c), '');
});

test('legacy pure import migrates without recursion; mixed imports preserve Claude-only text', () => {
  const p = project(); write(p.a, 'Shared'); write(p.c, '@AGENTS.md\n');
  syncInstructions(p.root);
  assert.equal(read(p.c), 'Shared');
  write(p.c, '@AGENTS.md\n\nClaude-specific');
  assert.equal(syncInstructions(p.root).op, 'sync');
  assert.equal(read(p.a), 'Shared');
  assert.equal(read(p.c), `${BEGIN}\nShared\n${END}\n\nClaude-specific`);
  write(p.c, read(p.c).replace('Shared', 'Shared edit').replace('Claude-specific', 'Local edit'));
  syncInstructions(p.root);
  assert.equal(read(p.a), 'Shared edit');
  assert.ok(read(p.c).endsWith('Local edit'));
  write(p.a, 'Another shared edit');
  syncInstructions(p.root);
  assert.equal(read(p.c), `${BEGIN}\nAnother shared edit\n${END}\n\nLocal edit`);
  assert.equal(syncInstructions(p.root).op, 'noop');
});

test('legacy import migration preserves prefix, suffix, empty content, and CRLF', () => {
  for (const shared of ['', 'Rules\n', 'Rules\r\n']) {
    const p = project(); write(p.a, shared); write(p.c, 'Local prefix\r\n@AGENTS.md\r\nLocal suffix\r\n');
    syncInstructions(p.root);
    assert.equal(read(p.a), shared);
    assert.ok(read(p.c).startsWith('Local prefix\r\n'));
    assert.ok(read(p.c).endsWith('\nLocal suffix\r\n'));
    assert.equal(syncInstructions(p.root).op, 'noop');
  }
});

test('damaged, duplicate, and circular shared blocks never overwrite AGENTS.md', () => {
  const p = project(); write(p.a, 'Keep');
  for (const text of [`${BEGIN}\nRules`, `${END}\n${BEGIN}`, `${BEGIN}\nx\n${END}\n${END}`]) {
    write(p.c, text);
    assert.throws(() => syncInstructions(p.root), /damaged/);
    assert.equal(read(p.a), 'Keep');
  }
  write(p.c, `${BEGIN}\n@AGENTS.md\n${END}`);
  assert.equal(syncInstructions(p.root, { prefer: 'claude' }).op, 'conflict');
  assert.equal(read(p.a), 'Keep');
});

test('counterpart imports in AGENTS.md never get copied', () => {
  const p = project(); write(p.a, '@CLAUDE.md\n');
  assert.equal(syncInstructions(p.root).op, 'conflict');
  assert.equal(fs.existsSync(p.c), false);
});

test('private source modes, private backups, and hash-only state', () => {
  const p = project(); write(p.c, 'old private content'); fs.chmodSync(p.c, 0o600);
  syncInstructions(p.root);
  assert.equal(mode(p.a), 0o600);
  write(p.c, 'new private content'); syncInstructions(p.root);
  const paths = instructionPaths(p.root);
  assert.equal(mode(paths.state), 0o600);
  assert.equal(read(paths.state).includes('private content'), false);
  const backups = fs.readdirSync(path.join(paths.dir, 'backup'));
  const old = path.join(paths.dir, 'backup', backups[0]);
  assert.equal(read(old), 'old private content');
  assert.equal(mode(old), 0o600);
});

test('lock contention and corrupt state do not overwrite files', () => {
  const p = project(); write(p.c, 'Initial'); syncInstructions(p.root);
  const paths = instructionPaths(p.root);
  write(paths.lock, ''); write(p.c, 'Edited');
  assert.throws(() => syncInstructions(p.root), /locked/);
  assert.equal(read(p.a), 'Initial');
  fs.unlinkSync(paths.lock);
  write(paths.state, '{}');
  assert.throws(() => syncInstructions(p.root), /invalid instruction baseline/);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(read(p.a), 'Initial');
  write(paths.state, 'null');
  assert.throws(() => syncInstructions(p.root), /invalid instruction baseline/);
});

test('symlinks are refused without writing through them', () => {
  const p = project(); const external = write(path.join(p.root, 'external.md'), 'External');
  fs.symlinkSync(external, p.c);
  assert.throws(() => syncInstructions(p.root), /regular file/);
  assert.equal(read(external), 'External');
  assert.equal(fs.existsSync(p.a), false);
});

test('CLI previews, resolves conflicts, and apply syncs enrolled projects', () => {
  const p = project(); write(p.c, 'Instructions');
  const env = { ...process.env, EAG_PROJECT: p.root, EAG_NO_UPDATE: '1' };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  let r = run('instructions', '--dry-run', '--json');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).op, 'sync');
  assert.equal(fs.existsSync(p.a), false);
  assert.equal(run('instructions').status, 0);
  write(p.c, 'No MCP required');
  r = run('status', '--json', '--exit-code');
  assert.equal(r.status, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).instructions.op, 'sync');
  assert.equal(read(p.a), 'Instructions');
  r = run('apply', '--dry-run', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(p.a), 'Instructions');
  r = run('apply', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(p.a), 'No MCP required');
  write(path.join(process.env.EAG_HOME, 'mcp.json'), '{"mcpServers":{}}');
  write(path.join(process.env.EAG_HOME, 'agents.json'), '{"targets":{}}');
  write(p.a, 'Changed');
  r = run('apply', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).instructions.op, 'sync');
  assert.equal(read(p.c), 'Changed');
  write(p.a, 'A'); write(p.c, 'C');
  r = run('apply', '--prefer', 'source', '--json');
  assert.equal(r.status, 3, r.stderr);
  assert.equal(read(p.a), 'A'); assert.equal(read(p.c), 'C');
  assert.equal(run('status', '--json', '--exit-code').status, 3);
  r = run('instructions', '--prefer', 'claude', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(p.a), 'C');
  r = run('instructions', '--prefer', 'invalid', '--json');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).op, 'error');
  assert.match(execFileSync(process.execPath, [cli, 'instructions', '--help'], { env, encoding: 'utf8' }), /--prefer agents\|claude/);
});

test('generated session launcher syncs enrolled instructions before returning', async () => {
  const { renderLauncher } = await import('../src/hooks.js');
  const p = project(); write(p.c, 'Initial'); syncInstructions(p.root);
  write(p.c, 'From session hook');
  const launcher = write(path.join(p.root, 'eag-sync'), renderLauncher({ entry: cli, binDir: path.join(p.root, 'bin') }));
  // The generated launcher checks this explicit install location first.
  write(path.join(p.root, 'bin', 'eag'), `import ${JSON.stringify(cli)};`);
  const r = spawnSync('/bin/sh', [launcher], { cwd: p.root,
    env: { ...process.env, EAG_PROJECT: p.root, EAG_NO_UPDATE: '1' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(read(p.a), 'From session hook');
});

test('failed replacement keeps the old file and baseline; a retry converges', (t) => {
  const p = project(); write(p.c, 'Initial'); syncInstructions(p.root);
  const baseline = read(instructionPaths(p.root).state);
  write(p.c, 'Changed');
  const rename = fs.renameSync;
  const stub = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === p.a) throw new Error('simulated disk failure');
    return rename(from, to);
  });
  assert.throws(() => syncInstructions(p.root), /simulated disk failure/);
  assert.equal(read(p.a), 'Initial');
  assert.equal(read(instructionPaths(p.root).state), baseline);
  stub.mock.restore();
  syncInstructions(p.root);
  assert.equal(read(p.a), 'Changed');
});

test('edits detected between planning and writing are preserved', (t) => {
  const p = project(); write(p.c, 'Initial'); syncInstructions(p.root);
  write(p.c, 'Changed');
  const readFile = fs.readFileSync;
  let calls = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === p.a && ++calls === 2) write(p.a, 'Concurrent user edit');
    return readFile(file, ...args);
  });
  assert.throws(() => syncInstructions(p.root), /changed during sync/);
  assert.equal(read(p.a), 'Concurrent user edit');
  assert.equal(read(p.c), 'Changed');
});

test('doctor --fix enrolls a Claude-only project in an isolated environment', () => {
  const p = project(); write(p.c, 'Doctor instructions');
  const r = spawnSync(process.execPath, [cli, 'doctor', '--fix', '--json'], {
    env: { ...process.env, EAG_PROJECT: p.root, EAG_SHELL_RC: path.join(dir, 'unused-rc'), PATH: '/nonexistent', EAG_NO_UPDATE: '1' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(read(p.a), 'Doctor instructions');
  assert.ok(JSON.parse(r.stdout).checks.some((c) => c.level === 'fixed' && c.msg.startsWith('instructions:')));
});
