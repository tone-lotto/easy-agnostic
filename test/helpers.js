import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every eag module resolves its paths from the environment at import time (src/paths.js),
// so a test that needs a sandbox must call sandbox() FIRST and then reach the module under
// test with a dynamic `await import(...)`. Static imports are hoisted and would capture the
// real home. Pure modules (merge.js, util.js) have no such constraint.
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'eag-unit-'));
  process.env.EAG_HOME = path.join(dir, 'agents');
  process.env.CODEX_HOME = path.join(dir, 'codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cc');
  process.env.PI_CODING_AGENT_DIR = path.join(dir, 'pi');
  process.env.EAG_PROJECT = path.join(dir, 'proj');
  // Never touch the real keychain from a unit test.
  process.env.EAG_SECRET_BACKEND = 'file';
  process.env.EAG_SECRET_SERVICE = 'eag-unit-test';
  for (const d of ['agents', 'codex', 'cc', 'pi', 'proj']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return dir;
}

export function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
export function read(file) { return fs.readFileSync(file, 'utf8'); }
export function mode(file) { return fs.statSync(file).mode & 0o777; }
export const map = (obj) => new Map(Object.entries(obj));

// planMerge takes `state` as a plain object and `desired`/`native` as Maps.
export function mergeArgs({ desired = {}, state = {}, native = {}, ...rest }) {
  return { desired: map(desired), state, native: map(native), ...rest };
}
export function opOf(actions, name) { return actions.find((a) => a.name === name)?.op; }
