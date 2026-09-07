import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

// src/paths.js reads the environment at import time and src/secrets.js would otherwise
// talk to the real keychain, so the sandbox has to exist before the module is reached.
sandbox();

// resolveSecret() falls back to process.env when the store has no value, so these are
// enough to make a ${REF} resolvable without any keychain at all.
process.env.EAG_TEST_TOK = 'tok-value-0123456789';
process.env.EAG_TEST_TOK2 = 'tok2-value-0123456789';
process.env.EAG_TEST_CMD = '/opt/bin/server';
process.env.EAG_TEST_CWD = '/opt/work';
delete process.env.EAG_TEST_MISSING;

const codex = await import('../src/adapters/codex.js');
const { render, toSource, HAS_LITERAL } = codex;

const noWarn = () => {};

test('an http entry renders url only, dropping the source-only type key', () => {
  const warns = [];
  const out = render('svc', { type: 'http', url: 'https://example.test/mcp' }, {}, (w) => warns.push(w));
  assert.deepEqual(out, { url: 'https://example.test/mcp' });
  assert.deepEqual(warns, []);
});

test('type "sse" warns that Codex will speak streamable HTTP instead', () => {
  const warns = [];
  const out = render('svc', { type: 'sse', url: 'https://example.test/sse' }, {}, (w) => warns.push(w));
  assert.deepEqual(out, { url: 'https://example.test/sse' }, 'the sse marker must not leak into the table');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /svc: type "sse" is not supported by Codex; writing as streamable HTTP/);
});

test('a stdio entry renders command, args and cwd verbatim when they hold no reference', () => {
  const warns = [];
  const out = render('svc', {
    type: 'stdio',
    command: 'node',
    args: ['server.js', '--port', '7000'],
    cwd: '/srv/app',
  }, {}, (w) => warns.push(w));
  assert.deepEqual(out, { args: ['server.js', '--port', '7000'], command: 'node', cwd: '/srv/app' });
  assert.deepEqual(warns, []);
});

test('the three expressible reference shapes become pointers and never resolve the secret', () => {
  const warns = [];
  const http = render('svc', {
    type: 'http',
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer ${EAG_TEST_TOK}', 'X-Api-Key': '${EAG_TEST_TOK2}' },
  }, {}, (w) => warns.push(w));
  assert.deepEqual(http, {
    bearer_token_env_var: 'EAG_TEST_TOK',
    env_http_headers: { 'X-Api-Key': 'EAG_TEST_TOK2' },
    url: 'https://example.test/mcp',
  });

  const stdio = render('svc', {
    type: 'stdio',
    command: 'node',
    env: { EAG_TEST_TOK: '${EAG_TEST_TOK}' },
  }, {}, (w) => warns.push(w));
  assert.deepEqual(stdio, { command: 'node', env_vars: ['EAG_TEST_TOK'] });

  assert.deepEqual(warns, [], 'a pointer costs nothing, so nothing to warn about');
  for (const out of [http, stdio]) {
    assert.equal(out[HAS_LITERAL], undefined, 'no literal was written');
    const text = JSON.stringify(out);
    assert.ok(!text.includes(process.env.EAG_TEST_TOK), text);
    assert.ok(!text.includes(process.env.EAG_TEST_TOK2), text);
  }
});

test('a lowercase authorization header is still recognised as the bearer field', () => {
  const out = render('svc', {
    url: 'https://example.test/mcp',
    headers: { authorization: 'Bearer ${EAG_TEST_TOK}' },
  }, {}, noWarn);
  assert.deepEqual(out, { bearer_token_env_var: 'EAG_TEST_TOK', url: 'https://example.test/mcp' });
});

test('references Codex has no pointer field for resolve to literals, warn, and mark the table', () => {
  const cases = [
    // [what it is, source entry, expected table, expected field named in the warning]
    ['a header with a prefix around the reference', {
      url: 'https://example.test/mcp',
      headers: { 'X-Api-Key': `prefix-\${EAG_TEST_TOK}` },
    }, {
      http_headers: { 'X-Api-Key': `prefix-${process.env.EAG_TEST_TOK}` },
      url: 'https://example.test/mcp',
    }, 'headers.X-Api-Key'],
    ['an authorization header that is not a Bearer token', {
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Token ${EAG_TEST_TOK}' },
    }, {
      http_headers: { Authorization: `Token ${process.env.EAG_TEST_TOK}` },
      url: 'https://example.test/mcp',
    }, 'headers.Authorization'],
    ['an env var whose reference name differs from its key', {
      command: 'node',
      env: { API_TOKEN: '${EAG_TEST_TOK}' },
    }, {
      command: 'node',
      env: { API_TOKEN: process.env.EAG_TEST_TOK },
    }, 'env.API_TOKEN'],
    ['a reference inside args', {
      command: 'node',
      args: ['--token', '${EAG_TEST_TOK}'],
    }, {
      args: ['--token', process.env.EAG_TEST_TOK],
      command: 'node',
    }, 'args'],
  ];
  for (const [what, src, expected, where] of cases) {
    const warns = [];
    const out = render('svc', src, {}, (w) => warns.push(w));
    assert.deepEqual(out, expected, what);
    assert.equal(out[HAS_LITERAL], true, `${what}: the table must be marked as carrying a literal`);
    assert.equal(warns.length, 1, what);
    assert.equal(warns[0], `svc: ${where} has no env-ref field in Codex; writing \${EAG_TEST_TOK} as a literal`, what);
  }
});

// HAS_LITERAL travels render() -> write() only. sortKeys, deepEqual and the JSON state
// snapshot must not see it, or every literal-carrying entry would read as drift and the
// TOML serialiser would be handed a key it cannot write.
test('HAS_LITERAL survives render but stays invisible to keys, JSON and deepEqual', () => {
  const out = render('svc', { command: 'node', args: ['${EAG_TEST_TOK}'] }, {}, noWarn);
  const plain = { args: [process.env.EAG_TEST_TOK], command: 'node' };
  assert.equal(out[HAS_LITERAL], true);
  assert.deepEqual(Object.keys(out), ['args', 'command']);
  assert.equal(JSON.stringify(out), JSON.stringify(plain));
  assert.deepEqual(out, plain, 'deepEqual compares enumerable symbols, so this fails if the marker is enumerable');
  assert.deepEqual(JSON.parse(JSON.stringify(out))[HAS_LITERAL], undefined);
});

test('a referenced secret that is not set throws, naming the secret and the field', () => {
  const cases = [
    [{ url: 'https://example.test/mcp', headers: { 'X-Key': 'p-${EAG_TEST_MISSING}' } }, 'headers.X-Key'],
    [{ url: 'https://${EAG_TEST_MISSING}.example.test/mcp' }, 'url'],
    [{ command: 'node', args: ['${EAG_TEST_MISSING}'] }, 'args'],
    [{ command: 'node', env: { OTHER: '${EAG_TEST_MISSING}' } }, 'env.OTHER'],
  ];
  for (const [src, where] of cases) {
    assert.throws(
      () => render('svc', src, {}, noWarn),
      (e) => {
        assert.equal(e.message, `svc: secret EAG_TEST_MISSING (in ${where}) is not set. Run: eag secret set EAG_TEST_MISSING`);
        return true;
      },
      where,
    );
  }
});

// Regression: command and cwd were copied raw, so a ${NAME} in either was written verbatim
// into config.toml. Codex does not expand ${VAR}, so the server silently never started.
test('a ${NAME} in command or cwd resolves to a literal, never written verbatim', () => {
  const warns = [];
  const out = render('svc', {
    type: 'stdio',
    command: '${EAG_TEST_CMD}',
    cwd: '${EAG_TEST_CWD}/sub',
  }, {}, (w) => warns.push(w));
  assert.deepEqual(out, { command: '/opt/bin/server', cwd: '/opt/work/sub' });
  assert.equal(out[HAS_LITERAL], true, 'a resolved command/cwd is a literal like any other');
  assert.deepEqual(warns.sort(), [
    'svc: command has no env-ref field in Codex; writing ${EAG_TEST_CMD} as a literal',
    'svc: cwd has no env-ref field in Codex; writing ${EAG_TEST_CWD} as a literal',
  ]);
});

// Same regression, the half that used to fail silently: a missing secret in command or cwd
// did not even throw, it just shipped the unexpanded text.
test('a missing secret in command or cwd throws, naming the secret and the field', () => {
  for (const [src, where] of [
    [{ command: '${EAG_TEST_MISSING}' }, 'command'],
    [{ command: 'node', cwd: '/srv/${EAG_TEST_MISSING}' }, 'cwd'],
  ]) {
    assert.throws(
      () => render('svc', src, {}, noWarn),
      (e) => {
        assert.equal(e.message, `svc: secret EAG_TEST_MISSING (in ${where}) is not set. Run: eag secret set EAG_TEST_MISSING`);
        return true;
      },
      where,
    );
  }
});

test('overrides land in the table and win over what render produced', () => {
  const out = render('svc', { url: 'https://example.test/mcp' }, {
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
    enabled: false,
    enabled_tools: ['a'],
    disabled_tools: ['b'],
  }, noWarn);
  assert.deepEqual(out, {
    disabled_tools: ['b'],
    enabled: false,
    enabled_tools: ['a'],
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
    url: 'https://example.test/mcp',
  });
  assert.deepEqual(render('svc', { url: 'https://a.test' }, { url: 'https://b.test' }, noWarn), { url: 'https://b.test' });
});

test('toSource round-trips render for the http, sse and stdio shapes', () => {
  const cases = [
    ['http with both header pointer shapes', {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer ${EAG_TEST_TOK}', 'X-Api-Key': '${EAG_TEST_TOK2}' },
    }],
    ['http with a plain literal header', {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-Client': 'eag' },
    }],
    ['stdio with every field', {
      type: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '7000'],
      env: { EAG_TEST_TOK: '${EAG_TEST_TOK}', PLAIN: 'yes' },
      cwd: '/srv/app',
    }],
  ];
  for (const [what, entry] of cases) {
    const back = toSource(render('svc', entry, {}, noWarn));
    assert.deepEqual(back.entry, entry, what);
    assert.deepEqual(back.overrides, {}, what);
  }
  // sse is the one shape that cannot round-trip: Codex has no sse, so it comes back as http.
  const sse = toSource(render('svc', { type: 'sse', url: 'https://example.test/sse' }, {}, noWarn));
  assert.deepEqual(sse.entry, { type: 'http', url: 'https://example.test/sse' });
});

test('toSource lifts the Codex-only keys into overrides, never into the entry', () => {
  const overrides = {
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
    enabled: false,
    enabled_tools: ['a'],
    disabled_tools: ['b'],
  };
  const entry = { type: 'stdio', command: 'node', args: ['s.js'] };
  const back = toSource(render('svc', entry, overrides, noWarn));
  assert.deepEqual(back.entry, entry);
  assert.deepEqual(back.overrides, overrides);
});

test('toSource keeps a Codex table eag never rendered readable as a source entry', () => {
  assert.deepEqual(toSource({ url: 'https://example.test/mcp', bearer_token_env_var: 'TOK' }), {
    entry: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOK}' } },
    overrides: {},
  });
  assert.deepEqual(toSource({ command: 'uvx', env_vars: ['TOK'], enabled: true }), {
    entry: { type: 'stdio', command: 'uvx', env: { TOK: '${TOK}' } },
    overrides: { enabled: true },
  });
});
