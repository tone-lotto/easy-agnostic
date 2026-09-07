import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, write, read, mode } from './helpers.js';

const dir = sandbox();
const hooks = await import('../src/hooks.js');

const settings = () => JSON.parse(read(hooks.CLAUDE_SETTINGS));
const writeSettings = (o) => write(hooks.CLAUDE_SETTINGS, `${JSON.stringify(o, null, 2)}\n`);
const reset = () => fs.rmSync(hooks.CLAUDE_SETTINGS, { force: true });

test('the launcher is valid POSIX shell and executable', () => {
  const r = hooks.writeLauncher();
  assert.equal(r.changed, true);
  execFileSync('sh', ['-n', hooks.LAUNCHER]);
  assert.equal(mode(hooks.LAUNCHER) & 0o111, 0o111, 'a hook engine has to be able to execute it');
});

// The whole reason the launcher exists: a GUI-launched agent on macOS starts with
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, where node does not exist. A hook that called `eag`
// (a node shebang script) would silently do nothing there.
test('the launcher hardcodes absolute paths instead of trusting PATH', () => {
  const text = hooks.renderLauncher({ node: '/opt/n/bin/node', entry: '/opt/eag/bin/eag.js' });
  assert.match(text, /^NODE='\/opt\/n\/bin\/node'$/m);
  assert.match(text, /^EAG='\/opt\/eag\/bin\/eag\.js'$/m);
  assert.match(text, /"\$NODE" "\$EAG" apply --quiet/);
});

test('the launcher runs and syncs with no PATH and no shell rc', () => {
  hooks.writeLauncher();
  write(path.join(process.env.EAG_HOME, 'mcp.json'), JSON.stringify({ mcpServers: { probe: { type: 'http', url: 'https://example.com/probe' } } }));
  write(path.join(process.env.EAG_HOME, 'agents.json'), JSON.stringify({ targets: { claude: false, codex: true, pi: false } }));
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
    EAG_HOME: process.env.EAG_HOME, CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    EAG_SECRET_BACKEND: 'file', EAG_SECRET_SERVICE: 'eag-unit-test', EAG_SHELL_RC: path.join(dir, 'rc'),
  };
  const out = execFileSync('/bin/sh', [hooks.LAUNCHER], { env, encoding: 'utf8' });
  assert.equal(out, '', 'a hook must be silent: anything it prints reaches the agent');
  const toml = read(path.join(process.env.CODEX_HOME, 'config.toml'));
  assert.match(toml, /\[mcp_servers\.probe\]/, 'the launcher did not reach eag');
});

test('the launcher exits 0 even when nothing it needs exists', () => {
  const f = path.join(dir, 'broken-sync');
  write(f, hooks.renderLauncher({ node: '/nope/node', entry: '/nope/eag.js' }));
  // PATH without node either, so the fallback search finds nothing to run.
  const r = execFileSync('/bin/sh', [f], { env: { PATH: '/nonexistent', HOME: process.env.HOME }, encoding: 'utf8' });
  assert.equal(r, '', 'a broken install must never print into an agent session');
});

test('installClaude adds one SessionStart entry and touches nothing else', () => {
  reset();
  writeSettings({ model: 'opus', voiceEnabled: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] } });
  const r = hooks.installClaude();
  assert.equal(r.changed, true);
  const s = settings();
  assert.equal(s.model, 'opus');
  assert.equal(s.voiceEnabled, true);
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo other' }] }], 'another tool\'s hook must survive');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.deepEqual(s.hooks.SessionStart[0].hooks, [hooks.claudeEntry()]);
  assert.equal('matcher' in s.hooks.SessionStart[0], false, 'no matcher: it has to fire on every start');
});

// A SessionStart command hook with no timeout blocks session startup for as long as it runs
// — measured at 75s, uncapped. And for SessionStart, "exit code 0 - stdout shown to Claude":
// anything the command prints is injected into the session as context.
test('the entry is bounded and silent by construction', () => {
  const e = hooks.claudeEntry();
  assert.equal(typeof e.timeout, 'number');
  assert.ok(e.timeout > 0 && e.timeout <= 30, `timeout must be set and sane, got ${e.timeout}`);
  assert.match(hooks.renderLauncher(), />\/dev\/null 2>&1/, 'the launcher must swallow its own output');
});

test('installClaude creates the file when there is none', () => {
  reset();
  const r = hooks.installClaude();
  assert.equal(r.created, true);
  assert.deepEqual(Object.keys(settings()), ['hooks']);
});

test('installClaude is idempotent and never duplicates the entry', () => {
  reset();
  hooks.installClaude();
  const first = read(hooks.CLAUDE_SETTINGS);
  assert.equal(hooks.installClaude().changed, false);
  assert.equal(read(hooks.CLAUDE_SETTINGS), first);
  // an entry left by an older eag, with a different command, is replaced not doubled
  const s = settings();
  s.hooks.SessionStart[0].hooks[0].command = `/bin/sh ${hooks.LAUNCHER} --old-flag`;
  writeSettings(s);
  assert.equal(hooks.installClaude().changed, true);
  const after = settings().hooks.SessionStart.flatMap((g) => g.hooks);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0], hooks.claudeEntry());
});

test('uninstallClaude removes only our entry, and prunes what it empties', () => {
  reset();
  writeSettings({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } });
  hooks.installClaude();
  assert.equal(settings().hooks.SessionStart.length, 2);
  hooks.uninstallClaude();
  const s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo theirs' }] }]);
});

test('uninstallClaude drops the hooks key entirely when it was only ours', () => {
  reset();
  writeSettings({ model: 'opus' });
  hooks.installClaude();
  hooks.uninstallClaude();
  assert.deepEqual(settings(), { model: 'opus' }, 'an empty hooks object is litter');
  assert.equal(hooks.uninstallClaude().changed, false, 'a second removal is a no-op');
});

// Comparing only the command left an entry with a stale `timeout` in place — and the
// timeout is what stops a hung sync from blocking session startup.
test('an entry that differs only in timeout counts as out of date', () => {
  reset();
  hooks.installClaude();
  const s = settings();
  s.hooks.SessionStart[0].hooks[0].timeout = 999;
  writeSettings(s);
  assert.equal(hooks.claudeState().current, false);
  assert.equal(hooks.installClaude().changed, true);
  assert.deepEqual(settings().hooks.SessionStart[0].hooks[0], hooks.claudeEntry());
});

test('claudeState reports installed and current separately', () => {
  reset();
  assert.deepEqual([hooks.claudeState().installed, hooks.claudeState().current], [false, false]);
  hooks.installClaude();
  assert.deepEqual([hooks.claudeState().installed, hooks.claudeState().current], [true, true]);
  const s = settings();
  s.hooks.SessionStart[0].hooks[0].command = `/bin/sh ${hooks.LAUNCHER} stale`;
  writeSettings(s);
  assert.deepEqual([hooks.claudeState().installed, hooks.claudeState().current], [true, false]);
});

// Writing over it would destroy whatever the user meant to have there, and eag's whole
// promise is that it never does that.
test('a settings.json that is not a JSON object is refused, not overwritten', () => {
  write(hooks.CLAUDE_SETTINGS, '["not settings"]\n');
  assert.throws(() => hooks.installClaude(), /is not a JSON object/);
  assert.equal(read(hooks.CLAUDE_SETTINGS), '["not settings"]\n', 'the file must be untouched');
});

// ---- Codex -----------------------------------------------------------------------------
// Same shape as Claude's, in $CODEX_HOME/hooks.json, discovered with no pointer in
// config.toml. (The `hooks` key config.toml does accept is a plugin field, not this.)
const cxRead = () => JSON.parse(read(hooks.CODEX_HOOKS));
const cxWrite = (o) => write(hooks.CODEX_HOOKS, `${JSON.stringify(o, null, 2)}\n`);
const cxReset = () => fs.rmSync(hooks.CODEX_HOOKS, { force: true });

test('installCodex writes $CODEX_HOME/hooks.json and nothing in config.toml', () => {
  cxReset();
  const toml = path.join(process.env.CODEX_HOME, 'config.toml');
  write(toml, 'model = "gpt-5"\n');
  hooks.installCodex();
  assert.equal(hooks.CODEX_HOOKS, path.join(process.env.CODEX_HOME, 'hooks.json'));
  assert.deepEqual(cxRead().hooks.SessionStart[0].hooks, [hooks.codexEntry()]);
  assert.equal(read(toml), 'model = "gpt-5"\n', 'config.toml is eag\'s managed-block file; the hook must not touch it');
});

test('the Codex entry is bounded and shows nothing on screen', () => {
  const e = hooks.codexEntry();
  assert.ok(e.timeout > 0 && e.timeout <= 30);
  assert.equal('statusMessage' in e, false, 'statusMessage renders a spinner label; a silent sync must not');
});

test('installCodex keeps another tool\'s hooks and is idempotent', () => {
  cxReset();
  cxWrite({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } });
  hooks.installCodex();
  const f = cxRead();
  assert.equal(f.hooks.SessionStart.length, 2);
  assert.deepEqual(f.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo stop' }] }]);
  assert.equal(hooks.installCodex().changed, false);
});

test('uninstallCodex removes only our entry, and the file when it was only ours', () => {
  cxReset();
  cxWrite({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } });
  hooks.installCodex();
  hooks.uninstallCodex();
  assert.deepEqual(cxRead().hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'echo theirs' }] }]);

  cxReset();
  hooks.installCodex();
  hooks.uninstallCodex();
  assert.equal(fs.existsSync(hooks.CODEX_HOOKS), false, 'a file that held nothing but our hook is litter');
});

test('a hooks.json that is not a JSON object is refused, not overwritten', () => {
  write(hooks.CODEX_HOOKS, '"nope"\n');
  assert.throws(() => hooks.installCodex(), /is not a JSON object/);
  assert.equal(read(hooks.CODEX_HOOKS), '"nope"\n');
  cxReset();
});

// eag cannot grant Codex's trust — it lives in config.toml outside the managed block — so
// the least it must do is ask. Never throwing matters: this runs inside `eag doctor`.
test('codexTrust is best effort and never throws', async () => {
  cxReset();
  assert.equal(await hooks.codexTrust(), null, 'no hooks file, nothing to ask about');
  hooks.installCodex();
  const before = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent';        // no codex to ask
    assert.equal(await hooks.codexTrust({ timeoutMs: 2000 }), null);
  } finally { process.env.PATH = before; }
  cxReset();
});

// ---- the eag skill ---------------------------------------------------------------------
test('the shipped skill is a valid skill: frontmatter with name and description', () => {
  const f = new URL('../skills/eag/SKILL.md', import.meta.url);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /^---\nname: eag\ndescription: .+\n---\n/, 'Claude Code and Codex both need this frontmatter');
  for (const must of ['eag status', 'eag apply', 'eag mcp add', 'eag secret set', 'eag doctor', 'exit', '${NAME}', '--prefer']) {
    assert.ok(text.includes(must), `the skill must teach "${must}"`);
  }
});
