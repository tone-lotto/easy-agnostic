import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write, read } from './helpers.js';

const dir = sandbox();
const { scopePaths, assertProjectScope } = await import('../src/paths.js');
const { loadSource, saveMcp, saveAgents } = await import('../src/source.js');
const { buildPlan, applyPlan } = await import('../src/plan.js');
const user = scopePaths('user');
const native = path.join(process.env.CODEX_HOME, 'config.toml');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture() {
  write(user.mcp, '{"mcpServers":{"demo":{"command":"node"}}}');
  write(user.agents, '{"targets":{"codex":true}}');
  write(native, '# native\n');
  write(path.join(user.state, 'codex-user.json'), '{"servers":{}}');
}

test('source, policy, native, and state changes invalidate an apply plan without writing', () => {
  for (const [file, replacement] of [
    [user.mcp, '{"mcpServers":{"other":{"command":"node"}}}'],
    [user.agents, '{"targets":{"codex":false}}'],
    [native, '# hand edit\n'],
    [path.join(user.state, 'codex-user.json'), '{"servers":{"other":{"command":"node"}}}'],
  ]) {
    fixture();
    const plan = buildPlan('codex-user');
    write(file, replacement);
    const before = read(native);
    assert.throws(() => applyPlan(plan), /changed since planning/);
    assert.equal(read(native), before);
    assert.equal(read(file), replacement);
    assert.equal(fs.existsSync(path.join(user.state, 'backup')), false);
  }
});

test('source writers preserve edits made after loading', () => {
  fixture();
  const paths = scopePaths('user');
  const source = loadSource(paths);
  write(paths.mcp, '{"mcpServers":{},"handEdit":true}');
  assert.throws(() => saveMcp(paths, {}, source.mcp), /changed before replacement/);
  assert.equal(JSON.parse(read(paths.mcp)).handEdit, true);
  write(paths.agents, '{"targets":{"claude":false}}');
  assert.throws(() => saveAgents(paths, { targets: { codex: true } }), /changed before replacement/);
  assert.deepEqual(JSON.parse(read(paths.agents)), { targets: { claude: false } });
});

test('project scope refuses aliases of user source, policy, or native directories', () => {
  fixture();
  for (const [name, destination] of [['.mcp.json', user.mcp], ['.agents', process.env.EAG_HOME], ['.codex', process.env.CODEX_HOME]]) {
    const root = fs.mkdtempSync(path.join(dir, 'alias-'));
    fs.symlinkSync(destination, path.join(root, name));
    const paths = scopePaths('project', root);
    assert.equal(paths.collides, true);
    assert.throws(() => assertProjectScope(paths), /overlaps a user-level/);
    assert.throws(() => saveMcp(paths, {}), /overlaps a user-level/);
  }
});

test('a directory alias created after planning is rechecked before a source write', () => {
  fixture();
  const root = fs.mkdtempSync(path.join(dir, 'late-alias-'));
  const paths = scopePaths('project', root);
  loadSource(paths);
  fs.symlinkSync(process.env.EAG_HOME, path.join(root, '.agents'));
  assert.throws(() => saveAgents(paths, { targets: { codex: false } }), /overlaps a user-level/);
  assert.deepEqual(JSON.parse(read(user.agents)), { targets: { codex: true } });
});
