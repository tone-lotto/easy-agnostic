import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { sandbox, write as put, read as slurp, mode, map } from './helpers.js';

// src/paths.js reads CODEX_HOME at import time, so the sandbox must exist before the
// adapter is imported. A static import would be hoisted and would capture the real home.
const dir = sandbox();
const codex = await import('../src/adapters/codex.js');
const { OPEN, CLOSE, HAS_LITERAL } = codex;

// The mode assertions must not be hidden by a strict ambient umask.
process.umask(0o022);

let seq = 0;
// One project root per test: write('project', root, ...) lands in <root>/.codex/config.toml.
const root = () => path.join(dir, `p${++seq}`);
const cfg = (r) => codex.configPath('project', r);
const count = (text, needle) => text.split(needle).length - 1;
const blockOf = (text) => text.slice(text.indexOf(OPEN), text.indexOf(CLOSE) + CLOSE.length);
const ALPHA = map({ alpha: { url: 'https://alpha.example/mcp' } });

test('the exported markers wrap the generated block on lines of their own', () => {
  assert.equal(OPEN, '# >>> easy-agnostic managed >>>');
  assert.equal(CLOSE, '# <<< easy-agnostic managed <<<');
  const project = blockOf(codex.write('project', root(), ALPHA, { dryRun: true }).text).split('\n');
  const user = blockOf(codex.write('user', null, ALPHA, { dryRun: true }).text).split('\n');
  for (const lines of [project, user]) {
    assert.equal(lines[0], OPEN, 'the block opens on a line of its own');
    assert.equal(lines[lines.length - 1], CLOSE, 'and closes on one');
    assert.ok(lines[1].startsWith('#'), 'a header comment says the block is generated');
    assert.ok(lines.includes('[mcp_servers.alpha]'));
    assert.ok(lines.some((l) => l.startsWith('#') && l.includes('eag apply')), 'the block says how to change it');
  }
  // Project scope carries one extra header comment: its block repeats the user servers.
  const comments = (lines) => lines.filter((l) => l.startsWith('#')).length;
  assert.equal(comments(project), comments(user) + 1);
});

test('user scope resolves inside CODEX_HOME', () => {
  const file = codex.configPath('user');
  assert.equal(file, path.join(process.env.CODEX_HOME, 'config.toml'));
  assert.ok(file.startsWith(dir), 'the sandbox must own every path a test writes to');
  codex.write('user', null, map({ user_server: { command: 'echo' } }));
  assert.ok(fs.existsSync(file));
  const after = codex.read('user');
  assert.deepEqual([...after.managed], ['user_server']);
  assert.deepEqual([...after.locked], []);
});

test('read() on a file that does not exist reports nothing managed and nothing locked', () => {
  const cur = codex.read('project', root());
  assert.equal(cur.exists, false);
  assert.equal(cur.text, '');
  assert.equal(cur.hasBlock, false);
  assert.equal(cur.damaged, null);
  assert.equal(cur.servers.size, 0);
  assert.equal(cur.locked.size, 0);
  assert.equal(cur.managed.size, 0);
});

test('write() appends a block to a file that has none and keeps every earlier byte', () => {
  const r = root();
  const before = 'model = "gpt-5"\n\n[mcp_servers.hand]\ncommand = "hand"\n';
  put(cfg(r), before);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.equal(res.changed, true);
  assert.ok(res.text.startsWith(before), 'the pre-existing text must survive as a prefix');
  assert.equal(slurp(cfg(r)), res.text);
  assert.equal(count(res.text, OPEN), 1);
  const parsed = parse(res.text);
  assert.equal(parsed.mcp_servers.hand.command, 'hand');
  assert.deepEqual(parsed.mcp_servers.alpha, { url: 'https://alpha.example/mcp' });
});

test('write() adds the missing final newline before appending to a file without one', () => {
  const r = root();
  const before = 'model = "gpt-5"'; // no trailing newline
  put(cfg(r), before);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.ok(res.text.startsWith(`${before}\n`), 'the marker must never be glued onto the last line');
  assert.equal(res.text.split('\n')[0], 'model = "gpt-5"');
  assert.equal(parse(res.text).model, 'gpt-5');
  assert.equal(parse(res.text).mcp_servers.alpha.url, 'https://alpha.example/mcp');
});

test('write() replaces only the managed region and leaves the text around it byte for byte', () => {
  const r = root();
  const head = '# hand written\nmodel = "gpt-5"\n\n[mcp_servers.above]\ncommand = "above"\n\n';
  const block = `${OPEN}\n\n[mcp_servers.old]\nurl = "https://old"\n${CLOSE}`;
  const tail = '\n\n[mcp_servers.below]\ncommand = "below"\n# trailing comment\n';
  put(cfg(r), head + block + tail);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.ok(res.text.startsWith(head), 'nothing before the OPEN marker may move');
  assert.ok(res.text.endsWith(tail), 'nothing after the CLOSE marker may move');
  assert.equal(count(res.text, OPEN), 1);
  const parsed = parse(res.text);
  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ['above', 'alpha', 'below']);
  assert.equal('old' in parsed.mcp_servers, false, 'the previous block content is replaced, not kept');
});

test('write() keeps CRLF text outside the block untouched', () => {
  const r = root();
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const head = crlf('# hand written\nmodel = "gpt-5"\n\n[mcp_servers.above]\ncommand = "above"\n\n');
  const block = crlf(`${OPEN}\n\n[mcp_servers.old]\nurl = "https://old"\n${CLOSE}\n`);
  const tail = crlf('\n[mcp_servers.below]\ncommand = "below"\n');
  put(cfg(r), head + block + tail);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.ok(res.text.startsWith(head), 'the carriage returns before the block must survive');
  // splitBlock ends the region on the CLOSE line itself, so its own line terminator opens `after`.
  assert.ok(res.text.endsWith(`\n${tail}`), 'the carriage returns after the block must survive');
  const parsed = parse(res.text);
  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ['above', 'alpha', 'below']);
  const after = codex.read('project', r);
  assert.deepEqual([...after.managed], ['alpha']);
  assert.deepEqual([...after.locked].sort(), ['above', 'below']);
});

test('read() reports names inside the block as managed and every other name as locked', () => {
  const r = root();
  put(cfg(r), [
    'model = "gpt-5"',
    '',
    // another tool's own managed block: same style, different text
    '# >>> another-tool managed >>>',
    '[mcp_servers.other_tool]',
    'command = "othertool"',
    '# <<< another-tool managed <<<',
    '',
    '[mcp_servers.hand_written]',
    'command = "hand"',
    '',
    OPEN,
    '',
    '[mcp_servers.mine]',
    'url = "https://mine"',
    CLOSE,
    '',
  ].join('\n'));
  const cur = codex.read('project', r);
  assert.equal(cur.exists, true);
  assert.equal(cur.hasBlock, true);
  assert.equal(cur.damaged, null);
  assert.deepEqual([...cur.managed], ['mine']);
  assert.deepEqual([...cur.locked].sort(), ['hand_written', 'other_tool']);
  assert.deepEqual([...cur.servers.keys()].sort(), ['hand_written', 'mine', 'other_tool']);
  assert.deepEqual(cur.servers.get('mine'), { url: 'https://mine' });
});

test("another tool's block in the same marker style is left alone by write()", () => {
  const r = root();
  const foreign = '# >>> another-tool managed >>>\n[mcp_servers.other_tool]\ncommand = "othertool"\n# <<< another-tool managed <<<\n';
  put(cfg(r), `${foreign}\n${OPEN}\n\n[mcp_servers.old]\nurl = "https://old"\n${CLOSE}\n`);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.ok(res.text.startsWith(foreign), "the other tool's block is not ours to rewrite");
  assert.deepEqual(Object.keys(parse(res.text).mcp_servers).sort(), ['alpha', 'other_tool']);
});

// Regression: the markers used to be found with a raw indexOf, unanchored and unpaired.
// A file whose CLOSE line had been lost (a dotfiles merge, a hand edit) got a SECOND block
// appended, and the next write then took "the OPEN of block one .. the CLOSE of block two"
// as one region and swallowed every hand-written table in between.
test('a file whose CLOSE marker was deleted is damaged and write() refuses to touch it', () => {
  const r = root();
  const text = [
    OPEN,
    '[mcp_servers.mine]',
    'url = "https://mine"',
    '', // the CLOSE line was deleted here
    '[mcp_servers.precious]',
    'command = "precious"',
    '',
  ].join('\n');
  put(cfg(r), text);
  const cur = codex.read('project', r);
  assert.equal(cur.hasBlock, false, 'an orphan OPEN never opens a region');
  assert.throws(
    () => codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') }),
    (e) => e.message.includes(cfg(r)) && /refusing to write/.test(e.message) && /damaged/.test(e.message),
  );
  assert.equal(slurp(cfg(r)), text, 'the file must be left exactly as it was');
  assert.equal(count(slurp(cfg(r)), OPEN), 1, 'appending a second block is exactly the damage');
  assert.equal(fs.existsSync(path.join(r, 'bk')), false, 'nothing was written, so nothing was backed up');
  assert.match(cur.damaged, /damaged/);
});

// Regression: same root cause — two OPEN lines used to resolve to the first indexOf hit.
test('two OPEN marker lines are damaged, never a guessed region', () => {
  const r = root();
  const text = `${OPEN}\n[mcp_servers.one]\ncommand = "one"\n${OPEN}\n[mcp_servers.two]\ncommand = "two"\n${CLOSE}\n`;
  put(cfg(r), text);
  const bk = path.join(r, 'bk');
  const cur = codex.read('project', r);
  assert.equal(cur.hasBlock, false, 'an ambiguous region is no region at all');
  assert.match(cur.damaged, /damaged/);
  assert.throws(() => codex.write('project', r, ALPHA, { backupDir: bk }), /refusing to write/);
  // Taking "the first OPEN .. the CLOSE" as the region deleted both tables between them.
  assert.equal(slurp(cfg(r)), text, 'the file must be left exactly as it was');
  assert.deepEqual(Object.keys(parse(slurp(cfg(r))).mcp_servers).sort(), ['one', 'two']);
  assert.equal(fs.existsSync(bk), false, 'nothing was written, so nothing was backed up');
});

// Regression: unpaired indexOf never checked the order, so a CLOSE above the OPEN produced
// a negative-length region instead of a refusal.
test('a CLOSE line before the OPEN line is damaged', () => {
  const r = root();
  const text = `${CLOSE}\n[mcp_servers.precious]\ncommand = "precious"\n${OPEN}\n`;
  put(cfg(r), text);
  const bk = path.join(r, 'bk');
  const cur = codex.read('project', r);
  assert.equal(cur.hasBlock, false);
  assert.throws(() => codex.write('project', r, ALPHA, { backupDir: bk }), /refusing to write/);
  // Reading the pair out of order used to look like "no block at all", so a second block
  // was appended and the file ended up with three orphan markers.
  assert.equal(slurp(cfg(r)), text, 'the file must be left exactly as it was');
  assert.equal(count(slurp(cfg(r)), OPEN), 1);
  assert.equal(fs.existsSync(bk), false, 'nothing was written, so nothing was backed up');
  assert.match(cur.damaged, /damaged/);
});

// Regression: indexOf matched the marker text anywhere, including inside a TOML string, so
// a config that merely mentions the marker had its region located in the middle of a value.
test('a marker quoted inside a TOML string is not a marker', () => {
  const r = root();
  const text = `note = "${OPEN}"\nother = "${CLOSE}"\n\n[mcp_servers.hand]\ncommand = "hand"\n`;
  put(cfg(r), text);
  const cur = codex.read('project', r);
  assert.equal(cur.hasBlock, false, 'the marker only counts on a line of its own');
  assert.equal(cur.damaged, null, 'a quoted marker is text, not a damaged block');
  assert.deepEqual([...cur.locked], ['hand']);
  const res = codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.ok(res.text.startsWith(text), 'the quoted markers stay where they are');
  const parsed = parse(res.text);
  assert.equal(parsed.note, OPEN);
  assert.equal(parsed.other, CLOSE);
  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ['alpha', 'hand']);
  assert.deepEqual([...codex.read('project', r).managed], ['alpha']);
});

test('write() refuses to create a duplicate table and leaves the file unchanged', () => {
  const r = root();
  const text = '[mcp_servers.alpha]\ncommand = "locked-copy"\n';
  put(cfg(r), text);
  assert.throws(
    () => codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') }),
    (e) => e.message.includes(cfg(r)) && /not valid TOML/.test(e.message),
  );
  assert.equal(slurp(cfg(r)), text);
  assert.equal(fs.existsSync(path.join(r, 'bk')), false);
});

test('write() backs the previous file up under backupDir with mode 0600', () => {
  const r = root();
  const text = '[mcp_servers.hand]\ncommand = "hand"\n';
  put(cfg(r), text);
  const bk = path.join(r, 'bk');
  const res = codex.write('project', r, ALPHA, { backupDir: bk });
  assert.ok(res.backup, 'a write over an existing file must leave a backup');
  assert.equal(path.dirname(res.backup), bk);
  assert.equal(slurp(res.backup), text, 'the backup holds the file as it was before the write');
  assert.equal(mode(res.backup), 0o600, 'a backup can hold literal credentials');
  assert.deepEqual(fs.readdirSync(bk).length, 1);
});

test('a block that resolved a secret into a literal forces the file to 0600', () => {
  const r = root();
  process.env.EAG_UNIT_TOKEN = 'abc';
  const rendered = codex.render('alpha', { url: 'https://alpha.example/mcp', headers: { 'X-Key': 'v-${EAG_UNIT_TOKEN}' } }, {}, () => {});
  delete process.env.EAG_UNIT_TOKEN;
  assert.equal(rendered[HAS_LITERAL], true, 'render() marks the table it had to resolve');
  assert.equal(rendered.http_headers['X-Key'], 'v-abc');
  put(cfg(r), 'model = "gpt-5"\n');
  assert.equal(mode(cfg(r)), 0o644);
  codex.write('project', r, map({ alpha: rendered }), { backupDir: path.join(r, 'bk') });
  // "v-abc" looks like nothing: only the HAS_LITERAL mark can justify tightening here.
  assert.equal(mode(cfg(r)), 0o600);
});

test('a block whose values look like a credential forces the file to 0600', () => {
  const r = root();
  put(cfg(r), 'model = "gpt-5"\n');
  assert.equal(mode(cfg(r)), 0o644);
  const withToken = map({ alpha: { url: 'https://alpha.example/mcp', http_headers: { Authorization: 'Bearer sk-live-0123456789abcdef' } } });
  codex.write('project', r, withToken, { backupDir: path.join(r, 'bk') });
  assert.equal(mode(cfg(r)), 0o600);
});

test('a 0644 file whose block holds no literal stays 0644', () => {
  const r = root();
  put(cfg(r), 'model = "gpt-5"\n');
  assert.equal(mode(cfg(r)), 0o644);
  codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.equal(mode(cfg(r)), 0o644, 'a rewrite restores the mode the file had');
});

test('short literal credentials are private even without recognizable token shapes', () => {
  for (const entry of [
    { url: 'https://example.com', http_headers: { X: 'short' } },
    { url: 'https://example.com?key=x' },
    { command: 'node', env: { KEY: 'x' } },
    { command: 'node', args: ['--password', 'x'] },
  ]) {
    const r = root();
    put(cfg(r), '# user config\n');
    codex.write('project', r, map({ demo: entry }), { backupDir: path.join(r, 'bk') });
    assert.equal(mode(cfg(r)), 0o600);
    fs.chmodSync(cfg(r), 0o444);
    codex.ensureMode('project', r, map({ demo: entry }));
    assert.equal(mode(cfg(r)), 0o400, 'tightening must not add owner write permission');
  }
});

test('a config.toml eag creates itself starts at 0600', () => {
  const r = root();
  codex.write('project', r, ALPHA, { backupDir: path.join(r, 'bk') });
  assert.equal(mode(cfg(r)), 0o600);
});

test('ensureMode() tightens a widened file that holds a literal and leaves one that does not', () => {
  const r = root();
  const withToken = map({ alpha: { url: 'https://alpha.example/mcp', http_headers: { Authorization: 'Bearer sk-live-0123456789abcdef' } } });
  assert.equal(codex.ensureMode('project', r, withToken), null, 'a file that does not exist is not created');

  codex.write('project', r, withToken, { backupDir: path.join(r, 'bk') });
  fs.chmodSync(cfg(r), 0o644); // widened by hand since the last apply
  assert.equal(codex.ensureMode('project', r, ALPHA), null, 'no literal in the block: nothing to tighten');
  assert.equal(mode(cfg(r)), 0o644);
  assert.equal(codex.ensureMode('project', r, withToken), cfg(r));
  assert.equal(mode(cfg(r)), 0o600);
  assert.equal(codex.ensureMode('project', r, withToken), null, 'already tight: nothing to do');
  assert.equal(mode(cfg(r)), 0o600);
});

test('dryRun returns the text it would write and touches nothing', () => {
  const r = root();
  const text = '[mcp_servers.hand]\ncommand = "hand"\n';
  put(cfg(r), text);
  const bk = path.join(r, 'bk');
  const res = codex.write('project', r, ALPHA, { backupDir: bk, dryRun: true });
  assert.equal(res.changed, true);
  assert.equal(res.file, cfg(r));
  assert.match(res.text, new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(res.text, /\[mcp_servers\.alpha\]/);
  assert.equal(res.backup, undefined);
  assert.equal(slurp(cfg(r)), text, 'a dry run never writes');
  assert.equal(fs.existsSync(bk), false);
  // Running the same block twice is a no-op the caller can detect.
  codex.write('project', r, ALPHA, { backupDir: bk });
  assert.equal(codex.write('project', r, ALPHA, { backupDir: bk, dryRun: true }).changed, false);
});
