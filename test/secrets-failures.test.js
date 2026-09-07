import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write } from './helpers.js';

const dir = sandbox();
const secrets = await import('../src/secrets.js');
const originalPath = process.env.PATH;
const bin = path.join(dir, 'bin');
test.after(() => { process.env.PATH = originalPath; process.env.EAG_SECRET_BACKEND = 'file'; fs.rmSync(dir, { recursive: true, force: true }); });

function stub(name, status, stderr = '') {
  const file = write(path.join(bin, name), `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exit(${status});\n`);
  fs.chmodSync(file, 0o755);
  process.env.PATH = bin;
}

test('store access failure cannot silently fall back to an old file or environment value', () => {
  secrets.setSecret('TOKEN', 'old-file-value');
  process.env.TOKEN = 'env-value';
  process.env.EAG_SECRET_BACKEND = 'keychain';
  stub('security', 36, 'credential-private-output');
  try {
    assert.throws(() => secrets.resolveSecret('TOKEN'), (e) => /could not read/.test(e.message) && !e.message.includes('credential-private-output'));
    assert.throws(() => secrets.deleteSecret('TOKEN'), /could not remove/);
    process.env.EAG_SECRET_BACKEND = 'file';
    assert.equal(secrets.getSecret('TOKEN'), 'old-file-value', 'failed deletion preserves fallback credential');
    assert.ok(secrets.listSecrets().includes('TOKEN'));
  } finally { delete process.env.TOKEN; process.env.EAG_SECRET_BACKEND = 'file'; }
});

test('only an actual missing-item result allows fallback', () => {
  process.env.EAG_SECRET_BACKEND = 'keychain';
  stub('security', 44);
  assert.equal(secrets.getSecret('TOKEN'), 'old-file-value');
  process.env.EAG_SECRET_BACKEND = 'secret-tool';
  stub('secret-tool', 2);
  assert.throws(() => secrets.getSecret('TOKEN'), /could not read/);
  assert.throws(() => secrets.deleteSecret('TOKEN'), /could not remove/);
  stub('secret-tool', 1);
  assert.equal(secrets.getSecret('TOKEN'), 'old-file-value');
  process.env.EAG_SECRET_BACKEND = 'file';
});

test('corrupted tracking prevents credential mutation', () => {
  write(path.join(process.env.EAG_HOME, '.secrets.index'), '{}');
  assert.throws(() => secrets.setSecret('TOKEN', 'replacement'), /invalid secret index/);
  assert.throws(() => secrets.deleteSecret('TOKEN'), /invalid secret index/);
  assert.equal(secrets.getSecret('TOKEN'), 'old-file-value');
});
