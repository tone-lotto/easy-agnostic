import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { hasDrift } from '../src/merge.js';
import { sandbox, write, read, opOf } from './helpers.js';

// src/paths.js resolves every path from the environment AT IMPORT TIME, so the sandbox has
// to exist before plan.js (and the adapters it pulls in) is reached. Static imports are
// hoisted above this line, which is why plan.js arrives through a dynamic import instead.
// smol-toml and merge.js are pure and may come in statically.
const dir = sandbox();
const HOME = process.env.EAG_HOME;
const CODEX = process.env.CODEX_HOME;
const PROJECT = process.env.EAG_PROJECT;
const CLAUDE_JSON = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const { buildPlan, applyPlan, targetsForScope, backupDirFor } = await import('../src/plan.js');

const userMcp = path.join(HOME, 'mcp.json');
const userAgents = path.join(HOME, 'agents.json');
const userState = (targetId) => path.join(HOME, '.state', `${targetId}.json`);
const codexToml = path.join(CODEX, 'config.toml');
const projMcp = path.join(PROJECT, '.mcp.json');
const projAgents = path.join(PROJECT, '.agents', 'agents.json');
const projToml = path.join(PROJECT, '.codex', 'config.toml');

// The block markers are part of the on-disk format, so they are spelled out here rather
// than imported: a test that moved with a rename would stop testing the contract.
const OPEN = '# >>> easy-agnostic managed >>>';
const CLOSE = '# <<< easy-agnostic managed <<<';

const json = (o) => JSON.stringify(o, null, 2);
const CODEX_ON = json({ targets: { claude: false, codex: true, pi: false } });
const CLAUDE_ON = json({ targets: { claude: true, codex: false, pi: false } });

// One sandbox for the whole file (paths are frozen at import), so every test starts by
// emptying the four roots it writes into.
function reset() {
  for (const p of [HOME, CODEX, path.dirname(CLAUDE_JSON), PROJECT]) {
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
  }
}

// applyPlan shells out to `claude` for the claude-user target. This stub takes its place on
// PATH: it logs the subcommand, edits the sandbox .claude.json the way the real CLI would,
// and can be told to fail a given subcommand.
const binDir = path.join(dir, 'bin');
const claudeLog = path.join(binDir, 'claude.log');
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
function stubClaude({ failRemove = false, failAdd = false } = {}) {
  const impl = path.join(binDir, 'claude-impl.cjs');
  write(impl, `const fs = require('node:fs');
const [, , group, action, name, payload] = process.argv;
fs.appendFileSync(${JSON.stringify(claudeLog)}, [group, action, name].join(' ') + '\\n');
if ((action === 'remove' && ${failRemove}) || (action === 'add-json' && ${failAdd})) {
  process.stderr.write('stub claude refused to ' + action + ' ' + name + '\\n');
  process.exit(1);
}
const file = ${JSON.stringify(CLAUDE_JSON)};
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
data.mcpServers = data.mcpServers || {};
if (action === 'remove') delete data.mcpServers[name];
if (action === 'add-json') data.mcpServers[name] = JSON.parse(payload);
fs.writeFileSync(file, JSON.stringify(data, null, 2));
`);
  write(path.join(binDir, 'claude'), `#!/bin/sh\nexec node ${JSON.stringify(impl)} "$@"\n`);
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);
  fs.rmSync(claudeLog, { force: true });
}
const claudeCalls = () => read(claudeLog).trim().split('\n');

// Regression C1: after a successful write the snapshot was refreshed from a fresh read for
// EVERY name in it, not only the ones this run wrote. A name reported as a conflict had the
// user's hand edit absorbed into the snapshot, so the NEXT apply read it as "the source
// changed" and destroyed the edit while exiting 0.
test('regression C1: a conflicting name keeps its original snapshot entry when another name is written', () => {
  reset();
  stubClaude();
  const KEEP = { type: 'http', url: 'https://keep' };
  const HAND = { type: 'http', url: 'https://keep-edited-by-hand' };
  const OLD = { type: 'http', url: 'https://moving-old' };
  const NEW = { type: 'http', url: 'https://moving-new' };
  write(userAgents, CLAUDE_ON);
  write(userMcp, json({ mcpServers: { keep: KEEP, moving: NEW } }));
  write(CLAUDE_JSON, json({ mcpServers: { keep: HAND, moving: OLD } }));
  write(userState('claude-user'), json({ servers: { keep: KEEP, moving: OLD } }));

  const first = buildPlan('claude-user');
  assert.equal(opOf(first.actions, 'keep'), 'conflict');
  assert.equal(opOf(first.actions, 'moving'), 'update');
  const res = applyPlan(first, { backupDir: backupDirFor(first) });
  assert.deepEqual(res.failures, []);
  assert.deepEqual(claudeCalls(), ['mcp remove moving', 'mcp add-json moving']);

  const snap = JSON.parse(read(userState('claude-user'))).servers;
  assert.deepEqual(snap.keep, KEEP, 'the hand edit must not be absorbed into the snapshot');

  const second = buildPlan('claude-user');
  assert.equal(opOf(second.actions, 'keep'), 'conflict', 'still a conflict, never an update that would destroy the edit');
  assert.equal(opOf(second.actions, 'moving'), 'noop');
});

// Regression A5: a delete whose command failed used to lose its snapshot entry, so the next
// run classified the still-present server as `unmanaged` — invisible, because printPlan
// hides it, hasDrift excludes it and `status --exit-code` then returns 0.
test('regression A5: a delete whose command fails keeps its snapshot entry and is planned again', () => {
  reset();
  stubClaude({ failRemove: true });
  const GONE = { type: 'http', url: 'https://gone' };
  write(userAgents, CLAUDE_ON);
  write(userMcp, json({ mcpServers: {} }));
  write(CLAUDE_JSON, json({ mcpServers: { gone: GONE } }));
  write(userState('claude-user'), json({ servers: { gone: GONE } }));

  const first = buildPlan('claude-user');
  assert.equal(opOf(first.actions, 'gone'), 'delete');
  const res = applyPlan(first, { backupDir: backupDirFor(first) });
  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].name, 'gone');
  assert.match(res.failures[0].error, /stub claude refused/);

  const snap = JSON.parse(read(userState('claude-user'))).servers;
  assert.deepEqual(snap.gone, GONE, 'a delete that did not happen must stay tracked');

  const second = buildPlan('claude-user');
  assert.equal(opOf(second.actions, 'gone'), 'delete', 'never downgraded to the invisible unmanaged');
  assert.equal(hasDrift(second.actions), true);
});

// Regression C2: the managed block is regenerated from `entries` alone. A table inside it
// that no action covers — a name absent from .state, which is what a second machine or a
// snapshot lost with the dotfiles looks like — was dropped by the first write that happened
// for any other reason, while the same run printed it as untouched.
test('regression C2: a managed table no action covers survives a write made for another name', () => {
  reset();
  write(userAgents, CODEX_ON);
  write(userMcp, json({ mcpServers: {
    alpha: { type: 'http', url: 'https://alpha' },
    beta: { type: 'http', url: 'https://beta' },
    gamma: { type: 'http', url: 'https://gamma' },
  } }));
  write(codexToml, [
    'model = "gpt-5"',
    '',
    OPEN,
    '',
    '[mcp_servers.alpha]',
    'url = "https://alpha-edited"',
    '',
    '[mcp_servers.beta]',
    'url = "https://beta"',
    '',
    '[mcp_servers.delta]',
    'command = "delta-cmd"',
    CLOSE,
    '',
  ].join('\n'));
  // and deliberately no .state/codex-user.json

  const plan = buildPlan('codex-user');
  assert.equal(opOf(plan.actions, 'alpha'), 'conflict');
  assert.equal(opOf(plan.actions, 'beta'), 'adopt');
  assert.equal(opOf(plan.actions, 'gamma'), 'create');
  assert.equal(opOf(plan.actions, 'delta'), 'unmanaged');
  const res = applyPlan(plan, { backupDir: backupDirFor(plan) });
  assert.equal(res.changed, true);

  const after = parse(read(codexToml)).mcp_servers;
  assert.deepEqual(Object.keys(after).sort(), ['alpha', 'beta', 'delta', 'gamma']);
  assert.equal(after.delta.command, 'delta-cmd', 'a table the plan reported as untouched must survive the write');
  assert.equal(after.alpha.url, 'https://alpha-edited', 'the conflicting table keeps the hand edit');
  assert.equal(after.gamma.url, 'https://gamma');
});

// Regression A1: a name that IS in .state but was moved by hand OUTSIDE the block is both
// locked and conflict. The conflict branch re-emitted its table inside the block, defining
// [mcp_servers.X] twice: invalid TOML, a throw out of codex.write, and every target after
// this one in the run skipped.
test('regression A1: a locked conflict is never re-emitted inside the block', () => {
  reset();
  write(userAgents, CODEX_ON);
  write(userMcp, json({ mcpServers: {
    moved: { type: 'http', url: 'https://moved' },
    other: { type: 'http', url: 'https://other' },
    fresh: { type: 'http', url: 'https://fresh' },
  } }));
  write(codexToml, [
    '[mcp_servers.moved]',
    'url = "https://moved-by-hand"',
    '',
    OPEN,
    '',
    '[mcp_servers.other]',
    'url = "https://other"',
    CLOSE,
    '',
  ].join('\n'));
  write(userState('codex-user'), json({ servers: {
    moved: { url: 'https://moved-when-eag-wrote-it' },
    other: { url: 'https://other' },
  } }));

  const plan = buildPlan('codex-user');
  const moved = plan.actions.find((a) => a.name === 'moved');
  assert.equal(moved.op, 'conflict');
  assert.equal(moved.locked, true);
  assert.equal(opOf(plan.actions, 'fresh'), 'create', 'a write must happen, or nothing regenerates the block');
  assert.doesNotThrow(() => applyPlan(plan, { backupDir: backupDirFor(plan) }));

  const text = read(codexToml);
  assert.equal(text.match(/^\[mcp_servers\.moved\]/gm).length, 1, 'a second definition would be invalid TOML');
  assert.equal(text.indexOf('[mcp_servers.moved]') < text.indexOf(OPEN), true, 'it stays where the user put it');
  const after = parse(text).mcp_servers;
  assert.equal(after.moved.url, 'https://moved-by-hand');
  assert.equal(after.fresh.url, 'https://fresh');
  assert.equal(after.other.url, 'https://other');
});

// Regression A6: a project with a .mcp.json but no .agents/agents.json got DEFAULT_AGENTS
// spread over the user's switches, re-enabling machine-wide an agent the user turned off.
test('regression A6: a project without its own agents.json keeps the user target switches', () => {
  reset();
  write(userAgents, json({ targets: { claude: true, codex: false, pi: false } }));
  write(userMcp, json({ mcpServers: { u1: { type: 'http', url: 'https://u1' } } }));
  write(projMcp, json({ mcpServers: { p1: { type: 'http', url: 'https://p1' } } }));
  assert.equal(fs.existsSync(projAgents), false);

  const plan = buildPlan('codex-project', { root: PROJECT });
  assert.match(plan.skipped ?? '', /codex/);
  assert.equal(plan.actions, undefined);
  assert.deepEqual(applyPlan(plan), { skipped: plan.skipped });
  assert.equal(fs.existsSync(projToml), false, 'a skipped target must not generate a config');

  // the project can still opt in for itself, explicitly
  write(projAgents, json({ targets: { codex: true } }));
  const opted = buildPlan('codex-project', { root: PROJECT });
  assert.equal(opted.skipped, undefined);
  assert.deepEqual(opted.actions.map((a) => a.name), ['p1'], 'the project block holds only the project own servers');
});

test('a project agents.json overrides only the keys it sets', () => {
  reset();
  write(userAgents, json({
    targets: { claude: true, codex: false, pi: false },
    servers: { p1: { targets: { codex: false } } },
  }));
  write(userMcp, json({ mcpServers: { u1: { type: 'http', url: 'https://u1' } } }));
  write(projMcp, json({ mcpServers: {
    p1: { type: 'http', url: 'https://p1' },
    p2: { type: 'http', url: 'https://p2' },
  } }));
  write(projAgents, json({ targets: { codex: true } }));

  const plan = buildPlan('codex-project', { root: PROJECT });
  assert.equal(plan.skipped, undefined, 'the project switch wins for codex');
  assert.deepEqual(plan.skippedByPolicy, ['p1'], 'the user per-server policy survives the merge');
  assert.deepEqual(plan.actions.map((a) => a.name), ['p2']);
});

test('a delete removes the table from the block instead of being reseeded from it', () => {
  reset();
  write(userAgents, CODEX_ON);
  write(userMcp, json({ mcpServers: { keep: { type: 'http', url: 'https://keep' } } }));
  write(codexToml, [
    OPEN,
    '',
    '[mcp_servers.keep]',
    'url = "https://keep"',
    '',
    '[mcp_servers.old]',
    'url = "https://old"',
    CLOSE,
    '',
  ].join('\n'));
  write(userState('codex-user'), json({ servers: {
    keep: { url: 'https://keep' },
    old: { url: 'https://old' },
  } }));

  const plan = buildPlan('codex-user');
  assert.equal(opOf(plan.actions, 'old'), 'delete');
  applyPlan(plan, { backupDir: backupDirFor(plan) });

  const text = read(codexToml);
  assert.equal(text.includes('[mcp_servers.old]'), false, 'the deleted table must actually leave the block');
  assert.deepEqual(Object.keys(parse(text).mcp_servers), ['keep']);
  assert.equal(Object.hasOwn(JSON.parse(read(userState('codex-user'))).servers, 'old'), false);
});

test('forget leaves a native table that --prefer native decided to keep', () => {
  reset();
  write(userAgents, CODEX_ON);
  write(userMcp, json({ mcpServers: {
    other: { type: 'http', url: 'https://other' },
    brandnew: { type: 'http', url: 'https://brandnew' },
  } }));
  write(codexToml, [
    OPEN,
    '',
    '[mcp_servers.other]',
    'url = "https://other"',
    '',
    '[mcp_servers.x]',
    'url = "https://x-edited-by-hand"',
    CLOSE,
    '',
  ].join('\n'));
  write(userState('codex-user'), json({ servers: {
    other: { url: 'https://other' },
    x: { url: 'https://x-when-eag-wrote-it' },
  } }));

  const plan = buildPlan('codex-user', { prefer: 'native' });
  assert.equal(opOf(plan.actions, 'x'), 'forget');
  applyPlan(plan, { backupDir: backupDirFor(plan) });

  const after = parse(read(codexToml)).mcp_servers;
  assert.equal(after.x.url, 'https://x-edited-by-hand', 'the table the user asked to keep stays in the file');
  assert.equal(after.brandnew.url, 'https://brandnew');
  const snap = JSON.parse(read(userState('codex-user'))).servers;
  assert.equal(Object.hasOwn(snap, 'x'), false, 'only the snapshot entry is dropped');
  assert.deepEqual(Object.keys(snap).sort(), ['brandnew', 'other']);
});

test('a damaged managed block becomes a plan error instead of a throw', () => {
  reset();
  write(userAgents, CODEX_ON);
  write(userMcp, json({ mcpServers: { one: { type: 'http', url: 'https://one' } } }));
  write(codexToml, [
    OPEN,
    '',
    '[mcp_servers.one]',
    'url = "https://one"',
    '',
    '# the CLOSE marker was lost in a dotfiles merge',
    '',
  ].join('\n'));

  const plan = buildPlan('codex-user');
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /managed block is damaged/);
  assert.ok(Array.isArray(plan.actions), 'the plan is still built, so apply.js can report it as not applied');
});

test('project targets appear only where a project source exists', () => {
  reset();
  assert.deepEqual(targetsForScope('all', PROJECT), ['claude-user', 'codex-user']);
  assert.deepEqual(targetsForScope('project', PROJECT), []);
  assert.deepEqual(targetsForScope('user', PROJECT), ['claude-user', 'codex-user']);

  write(projMcp, json({ mcpServers: {} }));
  assert.deepEqual(targetsForScope('all', PROJECT), ['claude-user', 'codex-user', 'codex-project']);
  assert.deepEqual(targetsForScope('project', PROJECT), ['codex-project']);
  assert.deepEqual(targetsForScope('user', PROJECT), ['claude-user', 'codex-user']);
});
