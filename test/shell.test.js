import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, write, read } from './helpers.js';

// src/paths.js resolves EAG_HOME at import time, so the sandbox has to exist first.
const dir = sandbox();
const shell = await import('../src/shell.js');

const rc = () => path.join(dir, 'rc');
const setRc = (text) => { process.env.EAG_SHELL_RC = write(rc(), text); return rc(); };

test('the generated file is valid POSIX shell', () => {
  const f = path.join(dir, 'check-init.sh');
  write(f, shell.render(['claude', 'codex']));
  execFileSync('sh', ['-n', f]); // throws if it does not parse
});

test('it wraps exactly the binaries it is given, and calls through with command', () => {
  const text = shell.render(['claude', 'codex']);
  assert.match(text, /^ {2}claude\(\) \( __eag_sync; .*command claude "\$@"; \)/m);
  assert.match(text, /^ {2}codex\(\) \( __eag_sync; .*command codex "\$@"; \)/m);
  assert.equal(/\bpi\(\)/.test(text), false, 'unrequested binaries are not wrapped');
  // `command` is what stops the wrapper calling itself forever.
  assert.match(text, /command claude/);
});

test('everything is guarded on eag still being installed', () => {
  // A shell must not break because someone uninstalled the package.
  const text = shell.render(['claude']);
  assert.match(text, /if command -v eag >\/dev\/null 2>&1; then/);
  assert.match(text, /\nfi\n/);
});

test('the secret values are never written into the generated file', () => {
  const text = shell.render(['claude']);
  assert.match(text, /command eag env --target claude/, 'credentials are resolved inside the launch subshell');
  assert.equal(/export [A-Z_]+=/.test(text), false, 'no literal export belongs in a file on disk');
});

test('with no agent installed it does not resolve or export secrets', () => {
  const text = shell.render([]);
  assert.equal(text.includes('command eag env'), false);
  assert.equal(/__eag_sync/.test(text), false);
  assert.match(text, /no agent binary on PATH yet/);
});

test('wrappableBins only returns what is actually on PATH', () => {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const before = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(shell.wrappableBins(), []);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    assert.deepEqual(shell.wrappableBins(), ['codex']);
    // present but not executable does not count
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o644 });
    assert.deepEqual(shell.wrappableBins(), ['codex']);
  } finally { process.env.PATH = before; }
});

test('installRc keeps what the user already had and appends one guarded block', () => {
  setRc('# mine\nexport FOO=bar\n');
  const r = shell.installRc();
  assert.equal(r.changed, true);
  const text = read(rc());
  assert.match(text, /^# mine\nexport FOO=bar\n/);
  assert.match(text, /\[ -f '[^']*shell-init\.sh' \] && \. '[^']*shell-init\.sh'/);
  assert.equal(text.split(shell.BEGIN).length - 1, 1);
});

test('installRc is idempotent: running it again changes nothing', () => {
  setRc('# mine\n');
  shell.installRc();
  const first = read(rc());
  const second = shell.installRc();
  assert.equal(second.changed, false);
  assert.equal(read(rc()), first);
});

// The README used to tell people to add this line by hand. The generated file does it now,
// and leaving both would just pay for a second keychain read on every shell start.
test('installRc replaces the bare eval "$(eag env)" line it supersedes', () => {
  setRc('export A=1\neval "$(eag env)"\nexport B=2\n');
  const r = shell.installRc();
  assert.equal(r.replacedLegacy, true);
  const text = read(rc());
  assert.equal(/^\s*eval\s+"\$\(\s*eag env\s*\)"\s*$/m.test(text), false);
  assert.match(text, /export A=1/);
  assert.match(text, /export B=2/);
});

// Removing the line but leaving the comment that describes it is litter in someone's rc.
test('installRc takes the comment that described the legacy line with it', () => {
  setRc('export A=1\n\n# Easy Agnostic: resolve ${NAME} references (eag env reads the keychain)\neval "$(eag env)"\n\nexport B=2\n');
  shell.installRc();
  const text = read(rc());
  assert.equal(/Easy Agnostic: resolve/.test(text), false, 'the orphaned comment must go too');
  assert.match(text, /export A=1/);
  assert.match(text, /export B=2/);
  assert.equal(text.includes('# unrelated'), false);
});

test('installRc leaves a comment that has nothing to do with eag alone', () => {
  setRc('# my own note about eagerness\nexport A=1\n');
  shell.installRc();
  assert.match(read(rc()), /my own note about eagerness/);
});

test('uninstallRc removes the block and nothing else', () => {
  setRc('# mine\nexport FOO=bar\n');
  shell.installRc();
  const r = shell.uninstallRc();
  assert.equal(r.changed, true);
  const text = read(rc());
  assert.equal(text.includes(shell.BEGIN), false);
  assert.match(text, /# mine/);
  assert.match(text, /export FOO=bar/);
  assert.equal(shell.uninstallRc().changed, false, 'a second removal is a no-op');
});

test('rcState reports whether the rc is wired', () => {
  setRc('# nothing yet\n');
  assert.equal(shell.rcState().linked, false);
  shell.installRc();
  assert.equal(shell.rcState().linked, true);
});

test('writeInit only touches the file when the content would change', () => {
  const a = shell.writeInit(['claude']);
  assert.equal(a.changed, true);
  const mtime = fs.statSync(shell.INIT_FILE).mtimeMs;
  const b = shell.writeInit(['claude']);
  assert.equal(b.changed, false);
  assert.equal(fs.statSync(shell.INIT_FILE).mtimeMs, mtime, 'an unchanged rewrite must not touch mtime');
  assert.equal(shell.writeInit(['claude', 'codex']).changed, true);
});

// Someone who never ran `eag hook install` has not asked eag to touch their shell, so a
// plain `eag apply` must not create the file behind their back.
test('refreshInit updates an existing file but never creates one', () => {
  fs.rmSync(shell.INIT_FILE, { force: true });
  assert.equal(shell.refreshInit(), null);
  assert.equal(fs.existsSync(shell.INIT_FILE), false);
  shell.writeInit([]);
  fs.writeFileSync(shell.INIT_FILE, '# stale\n');
  const r = shell.refreshInit();
  assert.equal(r.changed, true);
  assert.match(read(shell.INIT_FILE), /Generated by eag/);
});

test('binsInFile reads back what the generated file wraps', () => {
  shell.writeInit(['claude', 'codex']);
  assert.deepEqual(shell.binsInFile(), ['claude', 'codex']);
  shell.writeInit([]);
  assert.deepEqual(shell.binsInFile(), []);
});

// The SessionStart launcher runs `eag apply` with the minimal PATH a GUI launch has, where
// no agent binary is visible. Rebuilding the list from that would silently delete every
// wrapper and stop terminal launches syncing — found by running it for real, not in a test.
test('refreshInit never drops a wrapper just because PATH cannot see the binary', () => {
  shell.writeInit(['claude', 'codex']);
  const before = process.env.PATH;
  try {
    process.env.PATH = '/nonexistent';
    assert.deepEqual(shell.wrappableBins(), [], 'the premise: nothing is visible');
    shell.refreshInit();
    assert.deepEqual(shell.binsInFile(), ['claude', 'codex'], 'the wrappers must survive');
  } finally { process.env.PATH = before; }
});

test('refreshInit does add a binary that appeared since', () => {
  shell.writeInit(['claude']);
  const bin = path.join(dir, 'newbin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const before = process.env.PATH;
  try {
    process.env.PATH = bin;
    shell.refreshInit();
    assert.deepEqual(shell.binsInFile(), ['claude', 'codex']);
  } finally { process.env.PATH = before; }
});

test('rcPath honours EAG_SHELL_RC, then picks by $SHELL', () => {
  process.env.EAG_SHELL_RC = '/tmp/explicit-rc';
  assert.equal(shell.rcPath(), '/tmp/explicit-rc');
  delete process.env.EAG_SHELL_RC;
  const realShell = process.env.SHELL;
  try {
    process.env.SHELL = '/bin/bash';
    assert.match(shell.rcPath(), /\.bashrc$/);
    process.env.SHELL = '/opt/homebrew/bin/fish';
    assert.match(shell.rcPath(), /config\.fish$/);
    assert.equal(shell.isFish(shell.rcPath()), true);
    process.env.SHELL = '/bin/zsh';
    assert.match(shell.rcPath(), /\.zshrc$/);
    assert.equal(shell.isFish(shell.rcPath()), false);
  } finally { process.env.SHELL = realShell; process.env.EAG_SHELL_RC = rc(); }
});

// An npx-only user has no `eag` on PATH, so the generated file used to skip everything —
// no exports, no wrappers — while doctor said sync-on-launch was wired.
test('the generated file puts the global bin dir on PATH before looking for eag', () => {
  const text = shell.render(['codex'], { binDir: '/g/bin' });
  const add = text.indexOf('PATH=\'/g/bin\':"$PATH"');
  const look = text.indexOf('command -v eag');
  assert.ok(add > 0 && add < look, 'PATH is fixed before eag is looked up');
  assert.match(text, /case ":\$PATH:" in \*':\/g\/bin:'\*\)/, 'and not added twice');
  shell.writeInit(['codex'], { binDir: '/g/bin' });
  assert.equal(shell.binDirInFile(), '/g/bin');
  shell.refreshInit();
  assert.equal(shell.binDirInFile(), '/g/bin', 'a refresh keeps the bin dir it was installed with');
});
