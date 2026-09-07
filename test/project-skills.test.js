import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, write, read } from './helpers.js';

const base = sandbox();
const skills = await import('../src/skills.js');
const cli = path.resolve('bin/eag.js');
let serial = 0;
function project() {
  const root = path.join(base, `project-${serial++}`); fs.mkdirSync(root);
  const options = { scope: 'project', root };
  return { root, options, ...skills.locations(options) };
}
const make = (dir, name, body = name) => write(path.join(dir, name, 'SKILL.md'), body);
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('project adoption shares both agent sources, wires Claude, and leaves global skills intact', () => {
  const p = project();
  const global = make(skills.AGENT_DIRS.claude.dir, 'global-only', 'Global');
  make(p.agents.claude.dir, 'local-claude'); make(p.agents.codex.dir, 'local-codex');
  const plan = skills.plan(p.options);
  skills.apply(plan, { ...p.options, dryRun: true });
  assert.equal(fs.existsSync(p.shared), false);
  skills.apply(plan, p.options);
  for (const name of ['local-claude', 'local-codex']) {
    assert.equal(read(path.join(p.shared, name, 'SKILL.md')), name);
    assert.ok(fs.lstatSync(path.join(p.agents.claude.dir, name)).isSymbolicLink());
    assert.equal(read(path.join(p.agents.claude.dir, name, 'SKILL.md')), name);
  }
  assert.equal(fs.existsSync(path.join(p.agents.codex.dir, 'local-codex')), false);
  assert.equal(read(global), 'Global');
  assert.equal(fs.existsSync(path.join(p.shared, 'global-only')), false);
  assert.deepEqual(skills.plan(p.options), []);
});

test('different agent copies both remain in place on collision', () => {
  const p = project();
  const a = make(p.agents.claude.dir, 'clash', 'A'); const b = make(p.agents.codex.dir, 'clash', 'B');
  const plan = skills.plan(p.options);
  assert.ok(plan.every((i) => i.op === 'collision'));
  skills.apply(plan, p.options);
  assert.equal(read(a), 'A'); assert.equal(read(b), 'B');
  assert.equal(fs.existsSync(p.shared), false);
});

test('existing shared skills get links and identical local duplicates are removed', () => {
  const p = project(); make(p.shared, 'existing'); make(p.agents.codex.dir, 'existing');
  skills.apply(skills.plan(p.options), p.options);
  assert.equal(read(path.join(p.agents.claude.dir, 'existing', 'SKILL.md')), 'existing');
  assert.equal(fs.existsSync(path.join(p.agents.codex.dir, 'existing')), false);
});

test('project inventory labels inherited skills and same-name entries without mutating them', () => {
  const p = project(); make(p.shared, 'global-only', 'Project');
  const rows = skills.inventory(p.options);
  assert.ok(rows.some((r) => r.name === 'global-only' && r.scope === 'user' && r.inherited));
  assert.ok(rows.some((r) => r.name === 'global-only' && r.scope === 'project' && !r.inherited && r.sameNameInUserScope));
  assert.equal(fs.existsSync(p.agents.claude.dir), false);
});

test('symlinked project directories cannot move global skills', () => {
  const p = project(); fs.symlinkSync(path.dirname(skills.AGENT_DIRS.claude.dir), path.join(p.root, '.claude'));
  assert.throws(() => skills.plan(p.options), /symlinks|overlaps/);
  assert.equal(read(path.join(skills.AGENT_DIRS.claude.dir, 'global-only', 'SKILL.md')), 'Global');
});

test('a duplicate edited after planning is preserved', () => {
  const p = project(); make(p.shared, 'duplicate'); const file = make(p.agents.codex.dir, 'duplicate');
  const plan = skills.plan(p.options); write(file, 'Changed');
  assert.throws(() => skills.apply(plan, p.options), /changed since planning/);
  assert.equal(read(file), 'Changed');
});

test('project skills are not filtered by machine-wide curated names', () => {
  const p = project();
  write(path.join(process.env.CODEX_HOME, 'vendor_imports', 'skills-curated-cache.json'), '{"skills":[{"name":"custom"}]}');
  make(p.agents.codex.dir, 'custom');
  assert.ok(skills.plan(p.options).some((i) => i.name === 'custom' && i.op === 'adopt'));
});

test('CLI supports project scope, previews, JSON listing, and invalid scope rejection', () => {
  const p = project(); make(p.agents.codex.dir, 'cli');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, EAG_PROJECT: p.root }, encoding: 'utf8' });
  assert.equal(run('adopt', 'skills', '--scope', 'project', '--dry-run').status, 0);
  assert.equal(fs.existsSync(p.shared), false);
  assert.equal(run('adopt', 'skills', '--scope', 'invalid').status, 1);
  const applied = run('adopt', 'skills', '--scope', 'project');
  assert.equal(applied.status, 0, applied.stderr);
  const listed = run('skills', 'ls', '--scope', 'project', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(JSON.parse(listed.stdout).skills.some((s) => s.name === 'cli' && s.origin === 'shared' && s.scope === 'project'));
  assert.equal(run('skills', 'ls', '--scope', 'invalid', '--json').status, 1);
});

test('project-scoped doctor repairs project links without deduplicating global skills', () => {
  const p = project(); make(p.shared, 'doctor-local');
  make(skills.SHARED, 'doctor-global'); const global = make(skills.AGENT_DIRS.codex.dir, 'doctor-global');
  write(path.join(process.env.EAG_HOME, 'mcp.json'), '{"mcpServers":{}}');
  const r = spawnSync(process.execPath, [cli, 'doctor', '--fix', '--scope', 'project', '--json'], {
    env: { ...process.env, EAG_PROJECT: p.root, EAG_SHELL_RC: path.join(base, 'rc'), PATH: '/nonexistent' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(read(global), 'doctor-global');
  assert.ok(fs.lstatSync(path.join(p.agents.claude.dir, 'doctor-local')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(skills.AGENT_DIRS.claude.dir, 'doctor-global')), false);
});
