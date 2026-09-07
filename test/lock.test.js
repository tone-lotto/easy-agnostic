import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dir = sandbox();
const { withLock } = await import('../src/lock.js');
const file = path.join(dir, 'mutation.lock');

test('nested calls reuse ownership and release the lock', () => {
  assert.equal(withLock(file, () => withLock(file, () => 42)), 42);
  assert.equal(fs.existsSync(file), false);
});

test('errors release the lock without swallowing the original error', async () => {
  assert.throws(() => withLock(file, () => { throw new Error('original'); }), /original/);
  await assert.rejects(withLock(file, async () => { throw new Error('async original'); }), /async original/);
  assert.equal(fs.existsSync(file), false);
});

test('independent concurrent calls fail closed while an owner is active', async () => {
  let finish;
  const active = withLock(file, () => new Promise((resolve) => { finish = resolve; }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => withLock(file, () => assert.fail('must not run')), /another eag mutation/);
  finish();
  await active;
  assert.equal(withLock(file, () => 'released'), 'released');
});

test('a replaced lock is preserved instead of being removed by the previous owner', () => {
  assert.throws(() => withLock(file, () => {
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'replacement', { flag: 'wx' });
  }), /ownership changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  fs.unlinkSync(file);
});

test('async work cannot reuse an ownership context after its lock was released', async () => {
  let resume; let late;
  const gate = new Promise((resolve) => { resume = resolve; });
  withLock(file, () => {
    late = (async () => { await gate; assert.throws(() => withLock(file, () => assert.fail('stale owner bypassed lock')), /another eag mutation/); })();
  });
  await withLock(file, async () => { resume(); await late; });
  assert.equal(fs.existsSync(file), false);
});
