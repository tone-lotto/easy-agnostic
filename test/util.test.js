import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeFileAtomic, writeJson, readJson, exists, backup, sortKeys, deepEqual, isEmpty, prune, refsIn, mapStrings, looksLikeSecret, sameTree, redactKnown } from '../src/util.js';
import { sandbox, write, read, mode } from './helpers.js';

// util.js is pure (no path resolution, no env at import time) so a static import is safe.
// sandbox() is still where every file these tests touch lives.
const ROOT = sandbox();
const UMASK = process.umask();
const dir = (name) => fs.mkdtempSync(path.join(ROOT, `${name}-`));
const temps = (d) => fs.readdirSync(d).filter((f) => f.includes('.eag-tmp-'));
const withUmask = (mask, fn) => { const old = process.umask(mask); try { fn(); } finally { process.umask(old); } };

test.after(() => { process.umask(UMASK); });

test('writeFileAtomic creates a file that was not there', () => {
  const d = dir('create');
  const f = path.join(d, 'nested', 'config.toml');
  writeFileAtomic(f, 'hello\n');
  assert.equal(read(f), 'hello\n');
  assert.deepEqual(temps(path.dirname(f)), []);
});

test('writeFileAtomic replaces the contents of an existing file', () => {
  const d = dir('replace');
  const f = write(path.join(d, 'config.toml'), 'old\n');
  writeFileAtomic(f, 'new\n');
  assert.equal(read(f), 'new\n');
  assert.deepEqual(temps(d), []);
});

test('conditional replacement refuses stale content and concurrent creation', () => {
  const d = dir('stale');
  const f = write(path.join(d, 'config'), 'external edit');
  assert.throws(() => writeFileAtomic(f, 'replacement', 0o600, { expected: 'planned value' }), /changed before replacement/);
  assert.throws(() => writeFileAtomic(f, 'replacement', 0o600, { expected: null }), /changed before replacement/);
  assert.equal(read(f), 'external edit');
  assert.deepEqual(temps(d), []);
  writeFileAtomic(f, 'replacement', 0o600, { expected: 'external edit' });
  assert.equal(read(f), 'replacement');
});

test('a dangling config symlink is refused, not detached', () => {
  const d = dir('dangling');
  const f = path.join(d, 'config');
  fs.symlinkSync(path.join(d, 'absent'), f);
  assert.throws(() => writeFileAtomic(f, 'replacement'), /dangling config symlink/);
  assert.ok(fs.lstatSync(f).isSymbolicLink());
  assert.deepEqual(temps(d), []);
});

// The temp holds the whole payload, secrets included: a throw between open and rename must
// not leave it lying around under a predictable name. The rename is the case that matters,
// because by then the temp exists and is full; aiming the write at a directory is the one
// way to reach it without stubbing fs (rename onto a directory is EISDIR).
test('a failed write leaves no temp file behind and does not touch the target', () => {
  const d = dir('fail');
  const f = write(path.join(d, 'config.toml'), 'old\n');
  assert.throws(() => writeFileAtomic(f, 42), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(read(f), 'old\n', 'the original must survive a failed rewrite');

  const asDir = path.join(d, 'config.d');
  fs.mkdirSync(asDir);
  assert.throws(() => writeFileAtomic(asDir, 'secret = "abc"\n'));
  assert.deepEqual(fs.readdirSync(asDir), [], 'the directory in the way is left untouched');

  assert.deepEqual(temps(d), [], 'neither failure may leave the payload on disk');
  assert.deepEqual(fs.readdirSync(d).sort(), ['config.d', 'config.toml']);
});

test('a write whose parent directory is really a file throws and creates nothing', () => {
  const d = dir('notdir');
  write(path.join(d, 'blocker'), 'i am a file\n');
  assert.throws(() => writeFileAtomic(path.join(d, 'blocker', 'config.toml'), 'x'));
  assert.deepEqual(temps(d), []);
  assert.deepEqual(fs.readdirSync(d), ['blocker']);
  assert.equal(read(path.join(d, 'blocker')), 'i am a file\n');
});

// open()'s mode argument applies only on creation and is narrowed by the umask, so an
// asked-for 0600 used to come out as whatever the umask allowed. fchmod on the descriptor
// is what makes it exact.
test('an explicit mode is exact even under a permissive umask', () => {
  const d = dir('mode-explicit');
  withUmask(0o022, () => {
    for (const want of [0o600, 0o640, 0o666]) {
      const f = path.join(d, `m-${want.toString(8)}.toml`);
      writeFileAtomic(f, 'x\n', want);
      assert.equal(mode(f), want, `new file asked for ${want.toString(8)}`);
      writeFileAtomic(f, 'y\n', want);
      assert.equal(mode(f), want, `rewrite asked for ${want.toString(8)}`);
    }
  });
  withUmask(0o077, () => {
    const f = path.join(d, 'public.toml');
    writeFileAtomic(f, 'x\n', 0o644);
    assert.equal(mode(f), 0o644, 'a restrictive umask must not narrow an explicit mode');
  });
});

// A rewrite must restore the file's own mode exactly: the umask is the user's default for
// NEW files and must never silently tighten (or widen) a config they chose to chmod.
test('a rewrite with no explicit mode keeps the file own mode exactly', () => {
  const d = dir('mode-keep');
  const f = write(path.join(d, 'config.toml'), 'old\n');
  fs.chmodSync(f, 0o640);
  withUmask(0o077, () => writeFileAtomic(f, 'new\n'));
  assert.equal(mode(f), 0o640);
  assert.equal(read(f), 'new\n');
  fs.chmodSync(f, 0o600);
  withUmask(0o022, () => writeFileAtomic(f, 'newer\n'));
  assert.equal(mode(f), 0o600, 'a private file must stay private after a rewrite');
});

test('a brand new file with no mode is 0644 minus the umask', () => {
  const d = dir('mode-new');
  for (const [mask, want] of [[0o022, 0o644], [0o027, 0o640], [0o077, 0o600]]) {
    const f = path.join(d, `u-${mask.toString(8)}.toml`);
    withUmask(mask, () => writeFileAtomic(f, 'x\n'));
    assert.equal(mode(f), want, `umask ${mask.toString(8)}`);
  }
});

// temp + rename replaces the inode, which would detach a config kept in a dotfiles repo.
// The write has to resolve the link first and land on the real file.
test('a write through a symlink follows the link instead of replacing it', () => {
  const d = dir('symlink');
  const real = write(path.join(d, 'store', 'config.toml'), 'old\n');
  fs.chmodSync(real, 0o600);
  const link = path.join(d, 'config.toml');
  fs.symlinkSync(real, link);

  writeFileAtomic(link, 'new\n');

  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink must survive the write');
  assert.equal(fs.readlinkSync(link), real, 'and must still point at the same target');
  assert.equal(read(real), 'new\n', 'the target is what gets the new content');
  assert.equal(mode(real), 0o600, 'the target keeps its own mode');
  assert.deepEqual(temps(path.dirname(real)), []);
  assert.deepEqual(temps(d), []);
});

// Legacy predictable names may belong to another process. New writers neither use
// nor delete them; exclusive UUID names protect their own payload.
test('a symlink planted at the legacy temp path is neither followed nor removed', () => {
  const d = dir('temp-symlink');
  const victim = write(path.join(d, 'victim.txt'), 'untouched\n');
  const f = write(path.join(d, 'config.toml'), 'old\n');
  const tmp = `${f}.eag-tmp-${process.pid}`;
  fs.symlinkSync(victim, tmp);

  writeFileAtomic(f, 'new\n');

  assert.equal(read(f), 'new\n');
  assert.equal(read(victim), 'untouched\n', 'the planted symlink target must not be written');
  assert.ok(fs.lstatSync(tmp).isSymbolicLink());
  assert.deepEqual(temps(d), [path.basename(tmp)]);
});

test('a stale temp file left by an earlier crash does not block the next write', () => {
  const d = dir('stale-temp');
  const f = write(path.join(d, 'config.toml'), 'old\n');
  write(`${f}.eag-tmp-${process.pid}`, 'garbage\n');
  writeFileAtomic(f, 'new\n');
  assert.equal(read(f), 'new\n');
  assert.equal(read(`${f}.eag-tmp-${process.pid}`), 'garbage\n');
  assert.deepEqual(temps(d), [`config.toml.eag-tmp-${process.pid}`]);
});

test('writeJson writes indented json with a trailing newline and the mode asked for', () => {
  const d = dir('writejson');
  const f = path.join(d, 'mcp.json');
  withUmask(0o022, () => writeJson(f, { b: 1, a: { c: [1, 2] } }, 0o600));
  assert.equal(read(f), '{\n  "b": 1,\n  "a": {\n    "c": [\n      1,\n      2\n    ]\n  }\n}\n');
  assert.equal(mode(f), 0o600);
  assert.deepEqual(readJson(f), { b: 1, a: { c: [1, 2] } });
});

test('readJson returns the fallback only for a missing file', () => {
  const d = dir('readjson');
  assert.deepEqual(readJson(path.join(d, 'nope.json'), { mcpServers: {} }), { mcpServers: {} });
  assert.equal(readJson(path.join(d, 'nope.json')), undefined);
  const bad = write(path.join(d, 'bad.json'), '{ not json');
  // a corrupt file must be reported, never silently replaced by the fallback
  assert.throws(() => readJson(bad, { mcpServers: {} }), (e) => e.message.startsWith(`${bad}: `));
});

test('backup returns null for a file that is not there', () => {
  const d = dir('backup-missing');
  assert.equal(backup(path.join(d, 'config.toml'), path.join(d, 'backup'), 'codex'), null);
  assert.equal(exists(path.join(d, 'backup')), false, 'no backup dir for a file that does not exist');
});

test('backup copies the file 0600 under its label and keeps the extension', () => {
  const d = dir('backup-copy');
  const f = write(path.join(d, 'config.toml'), 'secret = "abc"\n');
  fs.chmodSync(f, 0o644);
  const bdir = path.join(d, 'backup');
  let dest;
  withUmask(0o022, () => { dest = backup(f, bdir, 'codex-user'); });
  assert.equal(read(dest), 'secret = "abc"\n');
  assert.equal(mode(dest), 0o600, 'a backup can hold literal credentials: it must be private');
  assert.equal(path.dirname(dest), bdir);
  assert.match(path.basename(dest), /^codex-user-.*\.toml$/);
});

test('backup keeps the ten newest per label and deletes the rest', () => {
  const d = dir('backup-prune');
  const f = write(path.join(d, 'config.toml'), 'new\n');
  const bdir = path.join(d, 'backup');
  // Twelve older backups, named the way backup() names them (sorted lexicographically ==
  // chronologically), plus one for another label that must not be counted or deleted.
  const older = [];
  for (let i = 1; i <= 12; i++) {
    const name = `codex-2020-01-01T00-00-${String(i).padStart(2, '0')}-000Z.toml`;
    older.push(name);
    write(path.join(bdir, name), `old ${i}\n`);
  }
  write(path.join(bdir, 'claude-2020-01-01T00-00-01-000Z.json'), 'other label\n');

  const dest = backup(f, bdir, 'codex');

  const kept = fs.readdirSync(bdir).filter((n) => n.startsWith('codex-'));
  assert.equal(kept.length, 10);
  assert.ok(kept.includes(path.basename(dest)), 'the backup just taken is one of the ten');
  for (const gone of older.slice(0, 3)) assert.ok(!kept.includes(gone), `${gone} should be pruned`);
  for (const stays of older.slice(3)) assert.ok(kept.includes(stays), `${stays} should survive`);
  assert.equal(exists(path.join(bdir, 'claude-2020-01-01T00-00-01-000Z.json')), true, 'another label is not pruned');
});

test('sortKeys orders keys at every depth and keeps arrays in order', () => {
  const v = sortKeys({ url: 'u', headers: { b: '2', a: '1' }, args: [{ z: 1, y: 2 }, 'x'] });
  assert.deepEqual(Object.keys(v), ['args', 'headers', 'url']);
  assert.deepEqual(Object.keys(v.headers), ['a', 'b']);
  assert.deepEqual(Object.keys(v.args[0]), ['y', 'z']);
  assert.deepEqual(v.args, [{ y: 2, z: 1 }, 'x']);
  assert.equal(sortKeys(null), null);
  assert.deepEqual(sortKeys([3, 1, 2]), [3, 1, 2], 'sorting keys must never sort array elements');
});

test('deepEqual ignores key order and respects array order', () => {
  const cases = [
    [{ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }, { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }, true],
    [{ args: ['a', 'b'] }, { args: ['b', 'a'] }, false],
    [{ a: 1 }, { a: '1' }, false],
    [{ a: 1 }, { a: 1, b: undefined }, true],
    [[1, [2, 3]], [1, [2, 3]], true],
    [null, null, true],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(deepEqual(a, b), want, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('isEmpty is true only for null, undefined and empty containers', () => {
  for (const v of [null, undefined, [], {}]) assert.equal(isEmpty(v), true, JSON.stringify(v) ?? 'undefined');
  for (const v of [0, false, '', 'x', [0], { a: undefined }]) assert.equal(isEmpty(v), false, JSON.stringify(v) ?? 'undefined');
});

// A naive falsy filter would drop env: { DEBUG: 0 }, disabled: false and an intentionally
// empty string; only genuinely absent values may go.
test('prune drops empty containers and null but keeps 0, false and the empty string', () => {
  const out = prune({
    zero: 0, no: false, blank: '', url: 'https://a',
    nothing: null, missing: undefined, emptyObj: {}, emptyArr: [], list: ['a'], obj: { a: 1 },
  });
  assert.deepEqual(Object.keys(out).sort(), ['blank', 'list', 'no', 'obj', 'url', 'zero']);
  assert.equal(out.zero, 0);
  assert.equal(out.no, false);
  assert.equal(out.blank, '');
});

test('refsIn finds every ${NAME} nested in arrays and objects', () => {
  const refs = refsIn({
    url: 'https://${HOST}/mcp',
    headers: { Authorization: 'Bearer ${TOKEN}', 'X-Two': '${A}-${B}' },
    args: ['--key', '${TOKEN}', { deep: ['${NESTED}'] }],
    port: 8080,
    on: true,
    nothing: null,
  });
  assert.deepEqual([...refs].sort(), ['A', 'B', 'HOST', 'NESTED', 'TOKEN']);
  assert.deepEqual([...refsIn('plain string')], []);
  assert.deepEqual([...refsIn(undefined)], []);
});

test('refsIn ignores a placeholder that is not a valid identifier', () => {
  assert.deepEqual([...refsIn('${1BAD} ${with-dash} ${} ${with space} ${OK}')], ['OK']);
  assert.deepEqual([...refsIn('$NOTBRACED and {NOTDOLLAR}')], []);
});

test('mapStrings rewrites strings at every depth and leaves other types alone', () => {
  const out = mapStrings({
    url: '${HOST}', headers: { a: 'x-${T}' }, args: ['${T}', ['${T}']], n: 7, b: false, z: null,
  }, (s) => s.replace(/\$\{(\w+)\}/g, (_m, name) => `<${name}>`));
  assert.deepEqual(out, {
    url: '<HOST>', headers: { a: 'x-<T>' }, args: ['<T>', ['<T>']], n: 7, b: false, z: null,
  });
  assert.equal(mapStrings('a', (s) => s + s), 'aa');
  assert.equal(mapStrings(5, () => 'never'), 5);
});

test('looksLikeSecret flags literal credentials', () => {
  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx',
    'sk-proj-abcdefghijklmnopqrst',
    `ghp_${'A1b2c3d4e5f6'.repeat(3)}`,
    'gho_0123456789abcdefghij',
    'xoxb-1234567890-abcdefghijklm',
    'github_pat_11ABCDEFG0abcdefghijklmn',
    `Bearer ${'a'.repeat(32)}`,
    'bearer 0123456789abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'https://user:pass@example.com/mcp',
    'postgres://admin:hunter2@db.internal:5432/app',
    'a'.repeat(40),
    '0123456789abcdef0123456789abcdef',
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  ];
  for (const s of secrets) assert.equal(looksLikeSecret(s), true, JSON.stringify(s));
});

test('looksLikeSecret stays quiet for ordinary config values', () => {
  const clean = [
    'https://api.example.com/mcp',
    'https://mcp.example.com/v1/sse?project=demo',
    '/usr/local/bin/mcp-server',
    './node_modules/.bin/some-mcp',
    'npx',
    '-y',
    '@modelcontextprotocol/server-filesystem',
    'stdio',
    'production',
    'Bearer token',
    'sk-short',
    '',
  ];
  for (const s of clean) assert.equal(looksLikeSecret(s), false, JSON.stringify(s));
  for (const v of [undefined, null, 42, true, { a: 1 }, ['a']]) {
    assert.equal(looksLikeSecret(v), false, `non-string ${String(v)}`);
  }
});

// A ${NAME} reference is exactly what the tool wants people to write; flagging it would
// make doctor shout at a correctly configured server.
test('looksLikeSecret never flags a string that holds a ${NAME} reference', () => {
  const refs = ['${TOKEN}', 'Bearer ${TOKEN}', 'https://user:${PASS}@example.com/mcp', `${'x'.repeat(40)}\${T}`];
  for (const s of refs) assert.equal(looksLikeSecret(s), false, JSON.stringify(s));
});

// Three cases the length-and-charset rules get wrong on their own: an AWS key id is under
// the 32-char floor, and both a deep path and a uuid satisfy the blob rule. Each has its
// own clause now.
test('looksLikeSecret catches a short cloud key id and spares a deep capitalised path', () => {
  assert.equal(looksLikeSecret('AKIAIOSFODNN7EXAMPLE'), true, 'AWS access key id is 20 chars');
  assert.equal(looksLikeSecret('/Users/me/Library/Caches/v2/binary'), false, 'a filesystem path is not a blob');
  assert.equal(looksLikeSecret('550e8400-e29b-41d4-a716-446655440000'), false, 'a uuid is not a credential');
});

// COLOR is read once at import time, so each state needs its own process.
const paintedIn = (env) => {
  const script = "import(process.argv[1]).then((m) => process.stdout.write(m.c.ok('ok') + m.c.bad('bad') + m.c.dim('dim')))";
  const child = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete child[k];
  return execFileSync(process.execPath, ['-e', script, new URL('../src/util.js', import.meta.url).href], { env: child, encoding: 'utf8' });
};

test('NO_COLOR and TERM=dumb strip every escape sequence', () => {
  for (const env of [{ NO_COLOR: '1', FORCE_COLOR: undefined }, { TERM: 'dumb', FORCE_COLOR: undefined }]) {
    const out = paintedIn(env);
    assert.equal(out, 'okbaddim', JSON.stringify(env));
    assert.ok(!out.includes('\x1b'), 'no escape sequence may reach a piped or NO_COLOR consumer');
  }
});

test('FORCE_COLOR paints even when stdout is a pipe', () => {
  const out = paintedIn({ FORCE_COLOR: '1', NO_COLOR: undefined });
  assert.equal(out, '\x1b[32mok\x1b[0m\x1b[31mbad\x1b[0m\x1b[2mdim\x1b[0m');
});

test('FORCE_COLOR beats NO_COLOR, as the comment in util.js promises', () => {
  assert.ok(paintedIn({ FORCE_COLOR: '1', NO_COLOR: '1' }).includes('\x1b[32m'));
});

// sameTree is what tells "the same skill, copied" from "a different skill with the same
// name": the first can be replaced with a link, the second must be reported and left alone.
test('sameTree compares directory trees byte for byte', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eag-tree-'));
  const mk = (name, files) => { const d = path.join(base, name); for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); } return d; };
  const a = mk('a', { 'SKILL.md': '# one\n', 'sub/x.txt': 'x' });
  const same = mk('same', { 'SKILL.md': '# one\n', 'sub/x.txt': 'x' });
  const diffContent = mk('diff', { 'SKILL.md': '# two\n', 'sub/x.txt': 'x' });
  const extraFile = mk('extra', { 'SKILL.md': '# one\n', 'sub/x.txt': 'x', 'more.txt': '' });
  const sameSize = mk('samesize', { 'SKILL.md': '# ONE\n', 'sub/x.txt': 'x' });
  assert.equal(sameTree(a, same), true);
  assert.equal(sameTree(a, diffContent), false);
  assert.equal(sameTree(a, extraFile), false, 'an extra file is a different tree');
  assert.equal(sameTree(a, sameSize), false, 'same size, different bytes');
  assert.equal(sameTree(a, path.join(base, 'missing')), false);
  // a link to the same place counts as the same tree
  const link = path.join(base, 'link'); fs.symlinkSync(a, link);
  assert.equal(sameTree(a, link), true);
});

// Native entries can hold resolved values (Claude user scope does), and --json goes to logs.
test('redactKnown puts ${NAME} back wherever a known secret value appears', () => {
  const pairs = [['TOK', 'sk-live-abc123'], ['OTHER', 'zzz']];
  const obj = { headers: { Authorization: 'Bearer sk-live-abc123' }, args: ['--key', 'sk-live-abc123'], url: 'https://x' };
  assert.deepEqual(redactKnown(obj, pairs), { headers: { Authorization: 'Bearer ${TOK}' }, args: ['--key', '${TOK}'], url: 'https://x' });
  assert.deepEqual(redactKnown('plain', pairs), 'plain');
  assert.deepEqual(redactKnown({ a: 'x' }, [['EMPTY', ''], ['UNSET', undefined]]), { a: 'x' }, 'an empty or unset value must not match everything');
});
