import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const skills = await import('../src/skills.js');

const mk = (base, name, body = `---\nname: ${name}\n---\nbody\n`) => { const d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), body); return d; };
const claude = skills.AGENT_DIRS.claude.dir;
const codex = skills.AGENT_DIRS.codex.dir;
const reset = () => { for (const d of [skills.SHARED, claude, codex]) fs.rmSync(d, { recursive: true, force: true }); };

test('a skill only one agent has is adopted; Claude keeps a link, Codex keeps nothing', () => {
  reset();
  mk(claude, 'onlyclaude'); mk(codex, 'onlycodex');
  const p = skills.plan();
  assert.deepEqual(p.map((i) => [i.agent, i.name, i.op]).sort(), [['claude', 'onlyclaude', 'adopt'], ['codex', 'onlycodex', 'adopt']]);
  skills.apply(p);
  assert.ok(fs.existsSync(path.join(skills.SHARED, 'onlyclaude', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skills.SHARED, 'onlycodex', 'SKILL.md')));
  assert.ok(fs.lstatSync(path.join(claude, 'onlyclaude')).isSymbolicLink(), 'Claude reads only its own dir, so it needs the link');
  assert.equal(fs.readFileSync(path.join(claude, 'onlyclaude', 'SKILL.md'), 'utf8').includes('onlyclaude'), true, 'the link resolves');
  assert.equal(fs.existsSync(path.join(codex, 'onlycodex')), false, 'Codex reads the shared dir itself; a copy would list it twice');
});

test('an identical copy of a shared skill is dropped, not moved over the shared one', () => {
  reset();
  mk(skills.SHARED, 'shared'); mk(codex, 'shared'); mk(claude, 'shared');
  const p = skills.plan();
  assert.ok(p.every((i) => i.op === 'duplicate'));
  skills.apply(p);
  assert.equal(fs.existsSync(path.join(codex, 'shared')), false);
  assert.ok(fs.lstatSync(path.join(claude, 'shared')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(skills.SHARED, 'shared', 'SKILL.md')), 'the shared one is untouched');
});

// Two different skills with one name cannot both become ~/.agents/skills/<name>. eag must
// not pick, and must not leave the loser half-moved.
test('a name clash between agents is reported and nothing is touched', () => {
  reset();
  mk(claude, 'deploy', '---\nname: deploy\n---\nvia Railway\n');
  mk(codex, 'deploy', '---\nname: deploy\n---\nvia Vercel\n');
  const p = skills.plan();
  const ops = Object.fromEntries(p.map((i) => [i.agent, i.op]));
  assert.equal(ops.claude, 'adopt', 'the first one seen would be adopted');
  assert.equal(ops.codex, 'collision', 'the second is a different skill with the same name');
  skills.apply(p);
  assert.match(fs.readFileSync(path.join(codex, 'deploy', 'SKILL.md'), 'utf8'), /Vercel/, 'the clashing skill is left exactly where it was');
  assert.match(fs.readFileSync(path.join(skills.SHARED, 'deploy', 'SKILL.md'), 'utf8'), /Railway/);
});

test('a clash against a skill already shared is reported and left alone', () => {
  reset();
  mk(skills.SHARED, 'x', '---\nname: x\n---\nA\n'); mk(codex, 'x', '---\nname: x\n---\nB\n');
  const p = skills.plan();
  assert.equal(p[0].op, 'collision');
  skills.apply(p);
  assert.equal(fs.readFileSync(path.join(codex, 'x', 'SKILL.md'), 'utf8'), '---\nname: x\n---\nB\n');
});

test('links, dotfiles and directories without SKILL.md are ignored', () => {
  reset();
  mk(skills.SHARED, 'linked'); fs.mkdirSync(claude, { recursive: true }); fs.symlinkSync(path.join(skills.SHARED, 'linked'), path.join(claude, 'linked'));
  fs.mkdirSync(path.join(codex, '.system'), { recursive: true }); fs.writeFileSync(path.join(codex, '.system', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(codex, 'notaskill'), { recursive: true });
  assert.deepEqual(skills.plan(), []);
});

test('dry run plans everything and moves nothing', () => {
  reset();
  mk(codex, 'dry');
  const p = skills.plan();
  skills.apply(p, { dryRun: true });
  assert.ok(fs.existsSync(path.join(codex, 'dry', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(skills.SHARED, 'dry')), false);
});
