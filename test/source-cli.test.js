import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write, mode } from './helpers.js';

// src/paths.js resolves EAG_HOME & friends at import time and ESM imports are hoisted, so
// the sandbox must exist before the modules under test are reached: one sandbox() at the
// top level, then dynamic imports. A second sandbox() later would not be seen by a module
// that is already loaded, so every test in this file shares this one directory.
const DIR = sandbox();
const { loadSource, validateServer, targetEnabled, serverAllowed, serverOverrides, secretsMode, DEFAULT_AGENTS } = await import('../src/source.js');
const { parseArgs, main } = await import('../src/cli.js');
const secrets = await import('../src/secrets.js');

// loadSource only ever touches paths.mcp / paths.agents, so a test can hand it its own pair.
let seq = 0;
function sourceAt(text) {
  const root = path.join(DIR, `source-${seq++}`);
  const paths = { scope: 'user', root, mcp: path.join(root, 'mcp.json'), agents: path.join(root, 'agents.json') };
  if (text !== undefined) write(paths.mcp, text);
  return paths;
}

// main() writes its report with console.log/error; swap both for the duration.
async function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const OK = { url: 'https://example.test/mcp' };

test('validateServer accepts a well-formed entry', () => {
  assert.deepEqual(validateServer('linear.io_1-x', OK), []);
  assert.deepEqual(validateServer('local', { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } }), []);
});

test('validateServer rejects a name with characters outside [A-Za-z0-9_.-]', () => {
  for (const name of ['has space', 'slash/name', 'at@name', 'brace{}', 'acentuação', 'quote"name', '']) {
    const errs = validateServer(name, OK);
    assert.equal(errs.length, 1, `${name}: ${errs.join(' | ')}`);
    assert.match(errs[0], /has characters outside \[A-Za-z0-9_\.-\]/);
    assert.ok(errs[0].includes(name), 'the message must name the offending server');
  }
});

// These names address Object.prototype instead of an own key in every map keyed by server
// name, so they are refused at the door rather than handled everywhere downstream.
test('validateServer rejects __proto__, constructor and prototype as reserved', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    assert.deepEqual(validateServer(name, OK), [`name "${name}" is reserved`]);
  }
});

test('validateServer requires exactly one of url and command', () => {
  assert.deepEqual(validateServer('x', {}), ['x: needs "url" or "command"']);
  assert.deepEqual(validateServer('x', { type: 'http' }), ['x: needs "url" or "command"']);
  assert.deepEqual(validateServer('x', { url: 'https://a', command: 'npx' }), ['x: has both "url" and "command"']);
});

test('validateServer type-checks headers, env and args', () => {
  const cases = [
    [{ url: 'https://a', headers: 'Authorization: x' }, 'x: "headers" must be an object'],
    [{ url: 'https://a', env: 'A=1' }, 'x: "env" must be an object'],
    [{ command: 'npx', args: '-y pkg' }, 'x: "args" must be an array'],
    [{ command: 'npx', args: { 0: '-y' } }, 'x: "args" must be an array'],
  ];
  for (const [s, expected] of cases) assert.deepEqual(validateServer('x', s), [expected]);
});

test('validateServer stops at "not an object" instead of reading fields off a non-object', () => {
  for (const s of [null, undefined, 'https://a', 42, ['https://a']]) {
    const errs = validateServer('x', s);
    if (Array.isArray(s)) { assert.deepEqual(errs, ['x: needs "url" or "command"']); continue; }
    assert.deepEqual(errs, ['x: not an object']);
  }
});

test('validateServer reports every problem at once', () => {
  const errs = validateServer('bad name', { url: 'https://a', command: 'npx', headers: 'x' });
  assert.equal(errs.length, 3);
});

// Regression: a source that parses but has no "mcpServers" object (a renamed key, or the
// VS Code {"servers": …} envelope) used to read as zero servers. The next apply took that
// literally and deleted every server from every agent, while doctor printed "0 servers".
test('loadSource throws when the file parses but has no mcpServers object', () => {
  const bodies = [
    '{"servers": {"a": {"url": "https://a"}}}',            // the VS Code envelope
    '{"mcp_servers": {"a": {"url": "https://a"}}}',        // the Codex key, by mistake
    '{"mcpServers": [{"name": "a"}]}',                     // an array is not the map
    '{"mcpServers": "a"}',
    '{"mcpServers": null}',
    '{}',
    '[]',
    '"just a string"',
  ];
  for (const body of bodies) {
    const paths = sourceAt(body);
    assert.throws(() => loadSource(paths), (e) => {
      assert.ok(e.message.includes(paths.mcp), `must name the file: ${e.message}`);
      assert.match(e.message, /no "mcpServers" object at the top level/);
      assert.match(e.message, /\{"mcpServers": \{\.\.\.\}\}/, 'must say what shape is expected');
      return true;
    }, body);
  }
});

// `echo null > mcp.json` parses to exactly the value a missing file used to fall back to.
// loadSource distinguishes them with a sentinel now, so this is an error and not a silent
// "zero servers" that the next apply would turn into "delete everything".
test('loadSource throws on a source whose whole content is null', () => {
  const paths = sourceAt('null');
  assert.throws(() => loadSource(paths), /no "mcpServers" object at the top level/);
});

test('loadSource reads a missing file as an empty source without throwing', () => {
  const src = loadSource(sourceAt(undefined));
  assert.equal(src.hasMcp, false);
  assert.equal(src.hasAgents, false);
  assert.deepEqual(src.servers, {});
  assert.deepEqual(src.mcp, { mcpServers: {} });
  assert.deepEqual(src.agents, DEFAULT_AGENTS);
});

test('loadSource accepts a deliberately empty mcpServers map', () => {
  const src = loadSource(sourceAt('{"mcpServers": {}}'));
  assert.equal(src.hasMcp, true);
  assert.deepEqual(src.servers, {});
});

test('loadSource returns the servers and keeps the rest of the envelope', () => {
  const paths = sourceAt('{"$schema": "https://x/schema.json", "mcpServers": {"a": {"url": "https://a"}}}');
  write(paths.agents, '{"targets": {"claude": false}}');
  const src = loadSource(paths);
  assert.deepEqual(src.servers, { a: { url: 'https://a' } });
  assert.equal(src.mcp.$schema, 'https://x/schema.json');
  assert.equal(src.hasAgents, true);
  assert.deepEqual(src.agents, { targets: { claude: false } });
});

test('loadSource reports the file when the JSON itself is broken', () => {
  const paths = sourceAt('{"mcpServers": {,}}');
  assert.throws(() => loadSource(paths), (e) => e.message.startsWith(`${paths.mcp}: `));
  const empty = sourceAt('');
  assert.throws(() => loadSource(empty), (e) => e.message.startsWith(`${empty.mcp}: `));
});

test('targetEnabled needs an explicit true, so "read-only" is not a write target', () => {
  assert.equal(targetEnabled(DEFAULT_AGENTS, 'claude'), true);
  assert.equal(targetEnabled(DEFAULT_AGENTS, 'codex'), true);
  assert.equal(targetEnabled(DEFAULT_AGENTS, 'pi'), false, '"read-only" must never enable a write');
  assert.equal(targetEnabled(DEFAULT_AGENTS, 'cursor'), false, 'an unknown agent is off');
  assert.equal(targetEnabled({}, 'claude'), false);
  assert.equal(targetEnabled(undefined, 'claude'), false);
  assert.equal(targetEnabled({ targets: { claude: 'yes' } }, 'claude'), false);
});

test('serverAllowed is true unless the per-server switch is exactly false', () => {
  const agents = {
    servers: {
      off: { targets: { codex: false } },
      on: { targets: { codex: true } },
      zero: { targets: { codex: 0 } },
      empty: {},
      other: { targets: { claude: false } },
    },
  };
  const cases = [['off', false], ['on', true], ['zero', true], ['empty', true], ['other', true], ['absent', true]];
  for (const [name, expected] of cases) assert.equal(serverAllowed(agents, name, 'codex'), expected, name);
  assert.equal(serverAllowed({}, 'anything', 'codex'), true, 'no policy at all means allowed');
  assert.equal(serverAllowed(undefined, 'anything', 'codex'), true);
});

test('serverOverrides hands back the per-agent block for that server, or an empty object', () => {
  const agents = { servers: { a: { codex: { startup_timeout_ms: 30000 }, claude: { type: 'http' } } } };
  assert.deepEqual(serverOverrides(agents, 'a', 'codex'), { startup_timeout_ms: 30000 });
  assert.deepEqual(serverOverrides(agents, 'a', 'claude'), { type: 'http' });
  assert.deepEqual(serverOverrides(agents, 'a', 'pi'), {});
  assert.deepEqual(serverOverrides(agents, 'b', 'codex'), {});
  assert.deepEqual(serverOverrides({}, 'b', 'codex'), {});
});

test('the per-server secrets mode overrides the per-agent one, which overrides the fallback', () => {
  const agents = { claude: { secrets: 'env' }, servers: { special: { secrets: 'literal' } } };
  assert.equal(secretsMode(agents, 'special', 'claude', 'literal'), 'literal', 'the server wins over the agent');
  assert.equal(secretsMode(agents, 'plain', 'claude', 'literal'), 'env', 'the agent wins over the fallback');
  assert.equal(secretsMode({}, 'plain', 'claude', 'literal'), 'literal');
  assert.equal(secretsMode(undefined, 'plain', 'claude', 'literal'), 'literal');
});

test('a server named after an Object.prototype member picks up no policy from the prototype', () => {
  const agents = { servers: {} };
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(serverAllowed(agents, name, 'codex'), true, name);
    assert.deepEqual(serverOverrides(agents, name, 'codex'), {}, name);
    assert.equal(secretsMode(agents, name, 'claude', 'literal'), 'literal', name);
  }
});

test('parseArgs reads a value from the next argument or from --flag=value', () => {
  assert.deepEqual(parseArgs(['apply', '--scope', 'project']), { flags: { scope: 'project' }, positional: ['apply'] });
  assert.deepEqual(parseArgs(['apply', '--scope=project']), { flags: { scope: 'project' }, positional: ['apply'] });
  assert.deepEqual(parseArgs(['--prefer', 'source', 'apply']), { flags: { prefer: 'source' }, positional: ['apply'] });
});

test('parseArgs keeps a value that contains "=" whole', () => {
  assert.deepEqual(parseArgs(['--env=API_KEY=${TOKEN}']).flags, { env: 'API_KEY=${TOKEN}' });
  assert.deepEqual(parseArgs(['--env', 'API_KEY=${TOKEN}']).flags, { env: 'API_KEY=${TOKEN}' });
  assert.deepEqual(parseArgs(['--header=Authorization: Bearer a=b=c']).flags, { header: 'Authorization: Bearer a=b=c' });
  assert.deepEqual(parseArgs(['--value=']).flags, { value: '' }, 'an explicitly empty value is a value, not true');
});

test('parseArgs collapses a repeated flag into an array', () => {
  assert.deepEqual(parseArgs(['--header', 'a: 1', '--header=b: 2']).flags, { header: ['a: 1', 'b: 2'] });
  assert.deepEqual(parseArgs(['--env', 'A=1', '--env', 'B=2', '--env', 'C=3']).flags, { env: ['A=1', 'B=2', 'C=3'] });
});

test('a boolean flag never swallows the next argument', () => {
  assert.deepEqual(parseArgs(['apply', '--dry-run', 'extra']), { flags: { 'dry-run': true }, positional: ['apply', 'extra'] });
  assert.deepEqual(parseArgs(['adopt', '--force', 'claude']), { flags: { force: true }, positional: ['adopt', 'claude'] });
  assert.deepEqual(parseArgs(['--fix', '--quiet']).flags, { fix: true, quiet: true });
  // a value flag with nothing left to take, or another flag next, is also just true
  assert.deepEqual(parseArgs(['--scope']).flags, { scope: true });
  assert.deepEqual(parseArgs(['--scope', '--fix']).flags, { scope: true, fix: true });
});

test('-- ends option parsing and everything after it is positional', () => {
  assert.deepEqual(parseArgs(['mcp', 'add', 'x', '--', '--url', 'https://a']), {
    flags: {},
    positional: ['mcp', 'add', 'x', '--url', 'https://a'],
  });
  assert.deepEqual(parseArgs(['mcp', 'add', 'x', '--url', 'https://a', '--', '--dry-run']), {
    flags: { url: 'https://a' },
    positional: ['mcp', 'add', 'x', '--dry-run'],
  });
});

// Regression: an unknown flag used to be parsed and then silently ignored, so a mistyped
// `eag apply --dryrun` wrote for real and exited 0.
test('main rejects a flag the command does not declare instead of ignoring it', async () => {
  const r = await capture(() => main(['apply', '--dryrun']));
  assert.notEqual(r.code, 0, 'a typo must not exit clean');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option/);
  assert.match(r.err, /--dryrun/);
  assert.match(r.err, /--dry-run/, 'the accepted list must show the right spelling');
  assert.equal(r.out, '', 'nothing else runs');
  assert.equal(fs.existsSync(path.join(process.env.EAG_HOME, '.state')), false, 'it must not have applied anything');
});

test('the flag allowlist is per command, not global', async () => {
  const r = await capture(() => main(['doctor', '--dry-run']));
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --dry-run for "doctor"/);
  assert.match(r.err, /accepted: --fix/);
  const noFlags = await capture(() => main(['env', '--fix']));
  assert.equal(noFlags.code, 1);
  assert.match(noFlags.err, /accepted: \(none\)/);
});

test('main rejects an unknown command before importing anything', async () => {
  const r = await capture(() => main(['aply']));
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command aply/);
});

test('a correctly spelled --dry-run is accepted and reaches the command', async () => {
  // --scope is valid for apply too, so the run gets past the allowlist and dies on the
  // scope check inside apply: proof that --dry-run was accepted, without writing anything.
  await assert.rejects(
    () => capture(() => main(['apply', '--dry-run', '--scope', 'nope'])),
    /--scope must be user, project or all \(got "nope"\)/,
  );
  const stateDir = path.join(process.env.EAG_HOME, '.state');
  const before = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).sort() : null;
  const r = await capture(() => main(['apply', '--dry-run']));
  assert.equal(r.code, 0);
  assert.match(r.out, /dry run: nothing written/);
  assert.doesNotMatch(r.err, /unknown option/);
  const after = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).sort() : null;
  assert.deepEqual(after, before, 'a dry run writes no state');
});

test('--help and --version answer before any flag is validated', async () => {
  const help = await capture(() => main(['apply', '--help']));
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: eag <command> \[options\]/);
  const version = await capture(() => main(['--version']));
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+/);
  const bare = await capture(() => main([]));
  assert.equal(bare.code, 0);
  assert.match(bare.out, /Usage: eag/);
});

// Regression: an unrecognised EAG_SECRET_BACKEND used to fall through to the plaintext
// file backend, so a typo ("keychan") silently wrote credentials to disk.
test('an unrecognised EAG_SECRET_BACKEND throws instead of falling back to the plaintext file', () => {
  const envFile = path.join(process.env.EAG_HOME, '.secrets.env');
  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
  const saved = process.env.EAG_SECRET_BACKEND;
  process.env.EAG_SECRET_BACKEND = 'keychan';
  try {
    for (const call of [
      () => secrets.backendName(),
      () => secrets.setSecret('EAG_UNIT_TYPO', 'sk-must-never-reach-the-disk'),
      () => secrets.getSecret('EAG_UNIT_TYPO'),
      () => secrets.deleteSecret('EAG_UNIT_TYPO'),
    ]) {
      assert.throws(call, (e) => {
        assert.match(e.message, /EAG_SECRET_BACKEND=keychan is not one of: keychain, secret-tool, file/);
        return true;
      });
    }
  } finally {
    process.env.EAG_SECRET_BACKEND = saved;
  }
  const after = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
  assert.equal(after, before, 'the refused backend must not have touched the file store');
  if (after !== null) assert.doesNotMatch(after, /sk-must-never-reach-the-disk/);
});

test('the file backend round-trips a value with a newline, a quote and a backslash', () => {
  const value = "-----BEGIN KEY-----\nit's a \\ back\\slash \\'mixed\\' \"quoted\"\r\n-----END KEY-----";
  secrets.setSecret('EAG_UNIT_PEM', value);
  assert.equal(secrets.getSecret('EAG_UNIT_PEM'), value);
  assert.equal(secrets.resolveSecret('EAG_UNIT_PEM'), value);
  // one secret is always one line, whatever the value holds
  const text = fs.readFileSync(path.join(process.env.EAG_HOME, '.secrets.env'), 'utf8');
  assert.equal(text.split('\n').filter((l) => l.startsWith('EAG_UNIT_PEM=')).length, 1);
  assert.ok(!text.includes('\n-----END KEY-----'), 'the newline must be encoded, not written raw');
  // a second secret must not disturb the first
  secrets.setSecret('EAG_UNIT_PLAIN', 'plain-value');
  assert.equal(secrets.getSecret('EAG_UNIT_PEM'), value);
  assert.equal(secrets.getSecret('EAG_UNIT_PLAIN'), 'plain-value');
  assert.equal(secrets.getSecret('EAG_UNIT_NEVER_SET'), undefined);
  secrets.deleteSecret('EAG_UNIT_PLAIN');
  assert.equal(secrets.getSecret('EAG_UNIT_PLAIN'), undefined);
  assert.equal(secrets.getSecret('EAG_UNIT_PEM'), value, 'removing one must not corrupt the others');
});

test('.secrets.env and .secrets.index are 0600, and a widened file is tightened again', () => {
  const envFile = path.join(process.env.EAG_HOME, '.secrets.env');
  const indexFile = path.join(process.env.EAG_HOME, '.secrets.index');
  secrets.setSecret('EAG_UNIT_MODE', 'a-value');
  assert.equal(mode(envFile), 0o600);
  assert.equal(mode(indexFile), 0o600);
  assert.ok(secrets.listSecrets().includes('EAG_UNIT_MODE'));
  fs.chmodSync(envFile, 0o644);
  fs.chmodSync(indexFile, 0o644);
  secrets.setSecret('EAG_UNIT_MODE', 'another-value');
  assert.equal(mode(envFile), 0o600, 'a rewrite must re-tighten the file');
  assert.equal(mode(indexFile), 0o600);
  assert.equal(secrets.getSecret('EAG_UNIT_MODE'), 'another-value');
});

test('setSecret refuses a value that is not a non-empty string', () => {
  for (const bad of [42, '', null, undefined, true, { value: 'x' }, ['x'], Buffer.from('x')]) {
    assert.throws(() => secrets.setSecret('EAG_UNIT_BAD', bad), /EAG_UNIT_BAD: a secret value must be a non-empty string/, String(bad));
  }
  assert.equal(secrets.getSecret('EAG_UNIT_BAD'), undefined);
  assert.equal(secrets.listSecrets().includes('EAG_UNIT_BAD'), false, 'a refused value must not leave a name in the index');
});
