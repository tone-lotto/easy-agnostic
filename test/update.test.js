import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write } from './helpers.js';

const dir = sandbox();
const update = await import('../src/update.js');

test('installKind tells a checkout, the npx cache and a global install apart', () => {
  const npx = path.join(dir, '.npm', '_npx', 'abc123', 'node_modules', 'easy-agnostic', 'bin', 'eag.js');
  write(npx, '');
  assert.equal(update.installKind(npx), 'npx');
  const dev = path.join(dir, 'repo', 'easyAgnostic', 'bin', 'eag.js');
  write(dev, ''); fs.mkdirSync(path.join(dir, 'repo', 'easyAgnostic', '.git'), { recursive: true });
  assert.equal(update.installKind(dev), 'dev');
  const glob = path.join(dir, 'lib', 'node_modules', 'easy-agnostic', 'bin', 'eag.js');
  write(glob, '');
  assert.equal(update.installKind(glob), 'global');
  assert.equal(update.installKind(), 'dev', 'this test suite runs from the checkout');
});

// The whole point of the throttle: apply runs on every agent launch, and a hook must never
// wait on the network more than once a day.
test('checkThrottled calls the registry at most once per window and never throws', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ version: '99.0.0' }) }; };
  try {
    const t0 = 1_000_000;
    assert.equal(await update.checkThrottled({ now: t0 }), '99.0.0');
    assert.equal(await update.checkThrottled({ now: t0 + 1000 }), '99.0.0', 'the cached answer, no second call');
    assert.equal(calls, 1);
    assert.equal(await update.checkThrottled({ now: t0 + 25 * 3600 * 1000 }), '99.0.0');
    assert.equal(calls, 2, 'a day later it asks again');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await update.checkThrottled({ now: t0 + 50 * 3600 * 1000 }), '99.0.0', 'offline: last known answer, no throw');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: update.VERSION }) });
    assert.equal(await update.checkThrottled({ now: t0 + 75 * 3600 * 1000 }), null, 'same version: nothing newer');
  } finally { globalThis.fetch = realFetch; }
});

test('latestVersion returns null on a slow or broken registry instead of hanging', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  try { assert.equal(await update.latestVersion({ timeoutMs: 50 }), null); } finally { globalThis.fetch = realFetch; }
});

// Overwriting a linked checkout with npm, or "updating" an npx cache, would each destroy
// something. Refuse, and say why.
test('selfUpdate refuses a dev checkout and the npx cache', () => {
  const r = update.selfUpdate('99.0.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /checkout/);
});

// A desktop-app hook has no npm on PATH; npm ships next to node, and node is what the
// launcher already resolved.
test('npmBin prefers the npm next to the running node', () => {
  const b = update.npmBin();
  const beside = path.join(path.dirname(process.execPath), 'npm');
  assert.equal(b, fs.existsSync(beside) ? beside : 'npm');
  assert.ok(path.isAbsolute(b) || b === 'npm');
});

test('registry results must be exact stable versions, never npm specs', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const version of ['latest', '1.2.3 --force', 'https://example.com/x.tgz', '../other', '01.2.3', '1.2.3-beta.1', null, {}]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ version }) });
      assert.equal(await update.latestVersion(), null);
      assert.equal(update.selfUpdate(version).ok, false);
      assert.equal(update.newer(version, '1.0.0'), false);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('registry deadline includes reading the response body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  try { assert.equal(await update.latestVersion({ timeoutMs: 30 }), null); }
  finally { globalThis.fetch = realFetch; }
});

test('background installs are refused even for a valid version', () => {
  assert.match(update.selfUpdate('99.0.0', { detached: true }).reason, /background installation is disabled/);
});
