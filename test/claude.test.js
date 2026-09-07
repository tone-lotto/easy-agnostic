import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

// src/paths.js resolves every path from the environment AT IMPORT TIME, and static imports
// are hoisted above this line. The sandbox has to exist first, so the adapter and anything
// that reaches a real config are pulled in with top-level `await import`.
const dir = sandbox();
const claude = await import('../src/adapters/claude.js');
const { setSecret } = await import('../src/secrets.js');
const { validateServer } = await import('../src/source.js');
const { CLAUDE_JSON } = await import('../src/paths.js');

// A value distinctive enough that any leak into a message or an argv is unmistakable.
const TOKEN = 'sk-live-UNIT-0123456789abcdefghij';
setSecret('EAG_UNIT_TOKEN', TOKEN);
delete process.env.EAG_UNIT_MISSING_TOKEN; // resolveSecret falls back to the process env

// A stub `claude` that fails with EMPTY stderr, so write() has to build its own message
// instead of quoting the CLI. Inside the sandbox, first on PATH; no test file shares a
// process with another, so the override cannot reach anyone else.
const stubDir = path.join(dir, 'bin');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nexit 3\n');
fs.chmodSync(path.join(stubDir, 'claude'), 0o755);
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

const SRC = { url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer ${EAG_UNIT_TOKEN}' } };
// `literal` has to be asked for now: the default is `env`, because Claude Code expands
// ${VAR} itself (verified against claude 2.1.x, in `env` values and in HTTP headers alike).
const RENDERED = claude.render('acme', SRC, { secrets: 'literal' }); // carries TOKEN

test('canonical fills in the type Claude requires from the presence of url', () => {
  const cases = [
    [{ url: 'https://a' }, 'http'],
    [{ command: 'node', args: ['x'] }, 'stdio'],
    [{ url: 'https://a', type: 'sse' }, 'sse'],       // an explicit type is never overridden
    [{ command: 'node', type: 'stdio' }, 'stdio'],
  ];
  for (const [src, type] of cases) assert.equal(claude.canonical(src).type, type, JSON.stringify(src));
});

test('canonical prunes empty objects and arrays, sorts keys and leaves the input alone', () => {
  const src = { url: 'https://a', headers: {}, args: [], env: { A: '1' }, type: 'sse' };
  const copy = structuredClone(src);
  const out = claude.canonical(src);
  assert.deepEqual(out, { env: { A: '1' }, type: 'sse', url: 'https://a' });
  assert.deepEqual(Object.keys(out), ['env', 'type', 'url'], 'keys must come back sorted');
  assert.deepEqual(src, copy, 'canonical must not mutate the source object');
});

test('render in literal mode resolves ${NAME} into the value', () => {
  assert.deepEqual(RENDERED, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    type: 'http',
    url: 'https://mcp.example/sse',
  });
});

test('render defaults to env mode, so no credential is written into ~/.claude.json', () => {
  const out = claude.render('acme', SRC);
  assert.deepEqual(out, { headers: { Authorization: 'Bearer ${EAG_UNIT_TOKEN}' }, type: 'http', url: 'https://mcp.example/sse' });
  assert.equal(JSON.stringify(out).includes(TOKEN), false, 'the default must not resolve the secret');
});

// A reference whose value exists nowhere would hand Claude a server that can never
// authenticate, so env mode still has to fail rather than write a dangling ${NAME}.
test('env mode still refuses a reference that resolves nowhere', () => {
  assert.throws(
    () => claude.render('acme', { url: 'https://a', headers: { Authorization: '${EAG_UNIT_MISSING_TOKEN}' } }, { secrets: 'env' }),
    /acme: secret EAG_UNIT_MISSING_TOKEN is not set/,
  );
});

test('render names the missing secret and the command that sets it', () => {
  assert.throws(
    () => claude.render('acme', { url: 'https://a', headers: { Authorization: '${EAG_UNIT_MISSING_TOKEN}' } }),
    (e) => {
      assert.match(e.message, /^acme: secret EAG_UNIT_MISSING_TOKEN is not set/);
      assert.match(e.message, /eag secret set EAG_UNIT_MISSING_TOKEN/);
      return true;
    },
  );
});

test('render in env mode passes the ${NAME} reference through untouched', () => {
  const out = claude.render('acme', SRC, { secrets: 'env' });
  assert.equal(out.headers.Authorization, 'Bearer ${EAG_UNIT_TOKEN}');
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
  assert.equal(out.type, 'http', 'env mode still canonicalises');
});

test('a create is one add-json and a delete is one remove, both scoped to user', () => {
  assert.deepEqual(
    claude.commandsFor([{ name: 'acme', op: 'create', desired: RENDERED, source: SRC }]),
    [['mcp', 'add-json', 'acme', JSON.stringify(RENDERED), '-s', 'user']],
  );
  assert.deepEqual(
    claude.commandsFor([{ name: 'acme', op: 'delete', state: RENDERED }]),
    [['mcp', 'remove', 'acme', '-s', 'user']],
  );
});

// `claude mcp add-json` refuses a name that already exists, so an update can only be
// expressed as remove-then-add, in that order.
test('an update is a remove followed by an add-json, in that order', () => {
  const cmds = claude.commandsFor([{ name: 'acme', op: 'update', desired: RENDERED, source: SRC }]);
  assert.deepEqual(cmds, [
    ['mcp', 'remove', 'acme', '-s', 'user'],
    ['mcp', 'add-json', 'acme', JSON.stringify(RENDERED), '-s', 'user'],
  ]);
});

test('ops that write nothing produce no command at all', () => {
  const quiet = ['noop', 'conflict', 'refresh', 'adopt', 'forget', 'unmanaged'];
  for (const op of quiet) {
    assert.deepEqual(claude.commandsFor([{ name: 'acme', op, desired: RENDERED, native: RENDERED }]), [], op);
  }
});

// write() attributes a failure to a server by position (a private namesFor mirrors this
// loop). That only holds while every command a server emits stays adjacent and in the same
// op order, which is what this pins down.
test('each server contributes its commands adjacently, so position identifies the server', () => {
  const cmds = claude.commandsFor([
    { name: 'a', op: 'delete' },
    { name: 'b', op: 'update', desired: RENDERED, source: SRC },
    { name: 'c', op: 'create', desired: RENDERED, source: SRC },
    { name: 'd', op: 'noop', desired: RENDERED },
  ]);
  assert.deepEqual(cmds.map((cmd) => [cmd[1], cmd[2]]), [
    ['remove', 'a'],
    ['remove', 'b'], ['add-json', 'b'],
    ['add-json', 'c'],
  ]);
  const update = cmds.slice(1, 3);
  assert.equal(update.length, 2);
  assert.equal(new Set(update.map((cmd) => cmd[2])).size, 1, 'both halves of an update name one server');
});

test('a redacted command carries ${NAME}, never the resolved value', () => {
  const actions = [{ name: 'acme', op: 'update', desired: RENDERED, source: SRC }];

  const [, redacted] = claude.commandsFor(actions, { redact: true });
  assert.equal(redacted[1], 'add-json');
  assert.equal(redacted[3], JSON.stringify(claude.canonical(SRC)));
  assert.ok(redacted[3].includes('Bearer ${EAG_UNIT_TOKEN}'), redacted[3]);
  assert.equal(redacted[3].includes(TOKEN), false, 'a redacted command must not resolve the secret');

  // In literal mode the real command is the one that has to carry the resolved value —
  // which is exactly what redact exists to keep out of anything a human reads.
  const [, real] = claude.commandsFor(actions);
  assert.ok(real[3].includes(TOKEN));

  // apply --dry-run goes through write(), which must redact and run nothing.
  const dry = claude.write(actions, { dryRun: true });
  assert.deepEqual(dry.failures, []);
  assert.equal(JSON.stringify(dry.commands).includes(TOKEN), false);
  assert.ok(JSON.stringify(dry.commands).includes('${EAG_UNIT_TOKEN}'));
});

// Regression: `claude mcp add-json` refuses any name outside [A-Za-z0-9_-] while `claude
// mcp remove` accepts anything. An update is remove-then-add, so such a name used to be
// removed and then fail to go back: a silent, unrecoverable loss. nameError is the second
// gate that keeps the name out of the plan, because source.js deliberately allows a dot.
test('nameError rejects the names add-json refuses, which validateServer still allows', () => {
  for (const ok of ['acme', 'my-server_1', 'ABC123', 'a']) {
    assert.equal(claude.nameError(ok), null, ok);
  }
  for (const bad of ['my.server', 'my server', 'my/server', 'acme@2', '']) {
    const err = claude.nameError(bad);
    assert.equal(typeof err, 'string', `${JSON.stringify(bad)} must be refused`);
    assert.ok(err.startsWith(`${bad}:`), err);
    assert.match(err, /\[A-Za-z0-9_-\]/);
  }
  // The dot is the reason this gate exists at all: the source validator accepts it.
  assert.deepEqual(validateServer('my.server', { url: 'https://a' }), []);
  assert.equal(typeof claude.nameError('my.server'), 'string');
});

// Regression: execFileSync puts the whole argv in e.message, and for add-json that argv is
// the rendered server — headers, resolved secret and all. The old code fell back to
// e.message when the CLI printed nothing, so a failing `claude` leaked the credential into
// whatever the caller printed.
test('a failed claude command records an exit status, never the resolved secret', () => {
  const res = claude.write([{ name: 'acme', op: 'update', desired: RENDERED, source: SRC }]);

  assert.equal(res.failures.length, 2, 'both halves of the update failed');
  assert.deepEqual(res.failures.map((f) => f.op), ['remove', 'add-json'], 'op tells a failed remove from a failed add');
  for (const f of res.failures) {
    assert.equal(f.name, 'acme');
    assert.equal('args' in f, false, 'a failure must not carry the argv');
    assert.match(f.error, /^claude mcp (remove|add-json) exited 3$/);
    assert.equal(f.error.includes(TOKEN), false, `error leaked the secret: ${f.error}`);
  }
  // Nothing anywhere in the failure list, however a caller serialises it.
  assert.equal(JSON.stringify(res.failures).includes(TOKEN), false);
});

test('read canonicalises ~/.claude.json, locks nothing and reports local entries apart', () => {
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify({
    mcpServers: { acme: { url: 'https://mcp.example/sse', headers: {}, args: [] } },
    projects: { '/repo/x': { mcpServers: { scratch: { command: 'node' } } } },
  }));
  const r = claude.read();
  assert.equal(r.exists, true);
  assert.equal(r.file, CLAUDE_JSON);
  assert.deepEqual(r.servers.get('acme'), { type: 'http', url: 'https://mcp.example/sse' });
  assert.equal(r.locked.size, 0, 'user scope has no locked names');
  assert.deepEqual(claude.readLocal('/repo/x'), { scratch: { command: 'node' } });
  assert.deepEqual(claude.readLocal('/repo/unknown'), {});
});

test('available reports false instead of throwing when claude --version fails', () => {
  assert.equal(claude.available(), false);
});
