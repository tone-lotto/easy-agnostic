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
  assert.equal(ops.claude, 'collision', 'the first copy is not an arbitrary winner');
  assert.equal(ops.codex, 'collision', 'the second is a different skill with the same name');
  skills.apply(p);
  assert.match(fs.readFileSync(path.join(codex, 'deploy', 'SKILL.md'), 'utf8'), /Vercel/, 'the clashing skill is left exactly where it was');
  assert.match(fs.readFileSync(path.join(claude, 'deploy', 'SKILL.md'), 'utf8'), /Railway/);
  assert.equal(fs.existsSync(path.join(skills.SHARED, 'deploy')), false);
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

// Only what the user added moves. What ships with a tool stays where the tool put it.
test('tool-native skills are never adopted', () => {
  reset();
  mk(codex, '.system', '---\nname: sys\n---\n');                                  // Codex bundled dir
  mk(codex, 'hatch-pet');                                                        // Codex curated name
  fs.mkdirSync(path.join(codex, 'vendor_imports'), { recursive: true });
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'vendor_imports'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'vendor_imports', 'skills-curated-cache.json'), JSON.stringify({ skills: [{ name: 'hatch-pet' }] }));
  mk(codex, 'mine');                                                             // user-added
  const eagDir = mk(skills.SHARED, 'eag'); fs.writeFileSync(path.join(eagDir, '.eag-managed'), '');
  const p = skills.plan();
  assert.deepEqual(p.map((i) => i.name), ['mine'], 'only the user-added skill is planned');
  assert.equal(skills.isNative(codex, 'hatch-pet'), true);
  assert.equal(skills.isNative(codex, '.system'), true);
  assert.equal(skills.isNative(codex, 'mine'), false);
});

test('a whole agent directory linked to shared skills is already shared, never deduplicated', () => {
  reset();
  mk(skills.SHARED, 'safe');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.symlinkSync(skills.SHARED, claude);
  assert.deepEqual(skills.plan(), []);
  assert.ok(fs.existsSync(path.join(skills.SHARED, 'safe', 'SKILL.md')));
});

test('adoption and deduplication restore the original directory after link failure', () => {
  for (const duplicate of [false, true]) {
    reset();
    mk(claude, 'restore');
    if (duplicate) mk(skills.SHARED, 'restore');
    const plan = skills.plan();
    const symlink = fs.symlinkSync;
    fs.symlinkSync = () => { throw Object.assign(new Error('injected failure'), { code: 'EACCES' }); };
    try { assert.throws(() => skills.apply(plan), /restored/); }
    finally { fs.symlinkSync = symlink; }
    assert.ok(fs.lstatSync(path.join(claude, 'restore')).isDirectory());
    assert.ok(fs.existsSync(path.join(claude, 'restore', 'SKILL.md')));
    assert.equal(fs.existsSync(path.join(skills.SHARED, 'restore')), duplicate);
    assert.equal(fs.readdirSync(claude).some((n) => n.startsWith('.eag-skill-')), false);
    skills.apply(skills.plan());
    assert.ok(fs.lstatSync(path.join(claude, 'restore')).isSymbolicLink());
  }
});
