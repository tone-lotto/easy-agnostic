import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write, read } from './helpers.js';
import { redactConfig, processFailure } from '../src/redact.js';
import { readJson } from '../src/util.js';

const dir = sandbox();
const claude = await import('../src/adapters/claude.js');
const { toJson } = await import('../src/commands/status.js');
const { buildPlan, applyPlan, backupDirFor } = await import('../src/plan.js');
const native = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const bin = path.join(dir, 'bin');
const originalPath = process.env.PATH;
test.after(() => { process.env.PATH = originalPath; fs.rmSync(dir, { recursive: true, force: true }); });

test('unindexed credentials never appear in structured config output', () => {
  const source = { command: 'node', env: { FOO: 'short-private-value', REF: '${TOKEN}', MIXED: '${HOST}:literal' }, args: ['--password', 'arg-private'], headers: { X: 'header-private', Authorization: 'Bearer ${TOKEN}' } };
  const safe = JSON.stringify(redactConfig(source));
  for (const value of ['short-private-value', 'literal', 'arg-private', 'header-private']) assert.equal(safe.includes(value), false);
  assert.ok(safe.includes('${TOKEN}'));
  assert.equal(processFailure('claude', { message: 'secret', stderr: 'secret', status: 2 }), 'claude exited 2');
});

test('URLs redact userinfo, query values, and fragments while keeping references', () => {
  const safe = redactConfig({ url: 'https://user:password@example.com/mcp?key=short&ref=${TOKEN}#private' }).url;
  assert.ok(safe.includes('example.com/mcp'));
  assert.ok(safe.includes('${TOKEN}'));
  for (const value of ['password', 'short', '#private']) assert.equal(safe.includes(value), false);
});

test('status sanitizes both source and native without a secret index', () => {
  const entry = { headers: { Authorization: 'Bearer unindexed-value' }, env: { KEY: 'short' } };
  const result = JSON.stringify(toJson({ actions: [{ name: 'x', op: 'conflict', source: entry, native: entry }], native: {}, errors: [], skippedByPolicy: [] }, []));
  assert.equal(result.includes('unindexed-value'), false);
  assert.equal(result.includes('short'), false);
});

test('malformed JSON error messages do not quote sensitive source text', () => {
  const file = write(path.join(dir, 'bad.json'), '{"key":"private-value" invalid}');
  assert.throws(() => readJson(file), (e) => /invalid JSON/.test(e.message) && !e.message.includes('private-value'));
});

function stub(mode = 'replacement') {
  const script = write(path.join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
const file = ${JSON.stringify(native)};
const [,, ,op,name,payload] = process.argv;
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000); }
else {
 const data = JSON.parse(fs.readFileSync(file, 'utf8'));
 if (op === 'remove') { delete data.mcpServers[name]; fs.writeFileSync(file, JSON.stringify(data)); }
 else if (payload.includes('new-private') || ${JSON.stringify(mode)} === 'all-adds-fail') { process.stderr.write(payload); process.exit(2); }
 else { data.mcpServers[name] = JSON.parse(payload); fs.writeFileSync(file, JSON.stringify(data)); }
}
`);
  fs.chmodSync(script, 0o755); process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
}

test('failed Claude replacement rolls back, preserves tracking, and hides stderr credentials', () => {
  stub();
  const old = { type: 'http', url: 'https://example.com', headers: { Authorization: 'old-private' } };
  write(native, JSON.stringify({ mcpServers: { demo: old } }));
  write(path.join(process.env.EAG_HOME, 'mcp.json'), JSON.stringify({ mcpServers: { demo: { ...old, headers: { Authorization: 'new-private' } } } }));
  write(path.join(process.env.EAG_HOME, 'agents.json'), '{"targets":{"claude":true}}');
  write(path.join(process.env.EAG_HOME, '.state/claude-user.json'), JSON.stringify({ servers: { demo: old } }));
  const plan = buildPlan('claude-user');
  const result = applyPlan(plan, { backupDir: backupDirFor(plan) });
  assert.equal(result.failures[0].rollback, 'restored');
  assert.equal(JSON.stringify(result).includes('new-private'), false);
  assert.deepEqual(JSON.parse(read(native)).mcpServers.demo, old);
  assert.equal(buildPlan('claude-user').actions[0].op, 'update');
  assert.ok(fs.readdirSync(backupDirFor(plan)).length);
});

test('hung Claude subprocess is terminated with a bounded, sanitized error', () => {
  stub('hang');
  const start = Date.now();
  const r = claude.write([{ name: 'demo', op: 'create', desired: { command: 'node' } }], { timeout: 50 });
  assert.match(r.failures[0].error, /timed out/);
  assert.ok(Date.now() - start < 2000);
});

test('failed Claude rollback is explicit and preserves the recovery snapshot and backup', () => {
  stub('all-adds-fail');
  const old = { type: 'http', url: 'https://example.com', headers: { Authorization: 'old-private' } };
  write(native, JSON.stringify({ mcpServers: { demo: old } }));
  write(path.join(process.env.EAG_HOME, 'mcp.json'), JSON.stringify({ mcpServers: { demo: { ...old, headers: { Authorization: 'new-private' } } } }));
  write(path.join(process.env.EAG_HOME, 'agents.json'), '{"targets":{"claude":true}}');
  const stateFile = path.join(process.env.EAG_HOME, '.state/claude-user.json');
  write(stateFile, JSON.stringify({ servers: { demo: old } }));
  const plan = buildPlan('claude-user');
  const result = applyPlan(plan, { backupDir: backupDirFor(plan) });
  assert.equal(result.failures[0].rollback, 'failed');
  assert.deepEqual(JSON.parse(read(stateFile)).servers.demo, old);
  assert.equal(JSON.parse(read(native)).mcpServers.demo, undefined);
  assert.ok(fs.readdirSync(backupDirFor(plan)).some((file) => JSON.parse(read(path.join(backupDirFor(plan), file))).mcpServers?.demo?.headers?.Authorization === 'old-private'));
  assert.equal(JSON.stringify(result).includes('old-private'), false);
  assert.equal(JSON.stringify(result).includes('new-private'), false);
});
