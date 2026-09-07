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
