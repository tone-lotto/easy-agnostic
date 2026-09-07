import fs from 'node:fs';
import path from 'node:path';
import { runCommand as execFileSync } from './process.js';
import { processFailure } from './redact.js';
import { EAG_HOME } from './paths.js';
import { withMutationLock } from './lock.js';
import { readJson, writeJson, writeFileAtomic, exists, ensureDir } from './util.js';

// Secrets never live in mcp.json. They live in the OS keychain (macOS `security`,
// Linux `secret-tool`) or, as a fallback, in $EAG_HOME/.secrets.env with mode 0600.
const SERVICE = process.env.EAG_SECRET_SERVICE || 'easy-agnostic';
const INDEX = path.join(EAG_HOME, '.secrets.index');
const ENV_FILE = path.join(EAG_HOME, '.secrets.env');

const BACKENDS = ['keychain', 'secret-tool', 'file'];
function backend() {
  const forced = process.env.EAG_SECRET_BACKEND;
  // Anything unrecognised used to fall through to the plaintext file, so a typo
  // ("keychan") silently wrote credentials to disk while printing the typo back.
  if (forced) {
    if (!BACKENDS.includes(forced)) throw new Error(`EAG_SECRET_BACKEND=${forced} is not one of: ${BACKENDS.join(', ')}`);
    return forced;
  }
  if (process.platform === 'darwin') return 'keychain';
  // secret-tool does not consistently implement --version. Detect the executable,
  // not whether a probe operation succeeded: a locked store must not select plaintext.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, 'secret-tool'), fs.constants.X_OK); return 'secret-tool'; } catch { /* next directory */ }
  }
  return 'file';
}
function run(cmd, args, input) {
  return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], input }).toString();
}
// One entry per line. Object.create(null) so a secret named "constructor" cannot
// resolve to an Object.prototype member.
function readEnvFile() {
  const out = Object.create(null);
  if (!exists(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(line.trim());
    if (m) {
      out[m[1]] = m[2].replace(/^'([\s\S]*)'$/, '$1')
        .replace(/'\\''/g, "'")                                  // reverse the shell quoting
        .replace(/\\([\s\S])/g, (_x, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch)); // then the line-terminator encoding
    }
  }
  return out;
}
function writeEnvFile(map) {
  ensureDir(EAG_HOME);
  // A value may hold newlines (a PEM key): encode them so one secret is always one line.
  const enc = (v) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/'/g, `'\\''`);
  const text = ['# Written by eag (eag secret set|rm). Values are escaped: do not edit by hand.']
    .concat(Object.entries(map).map(([k, v]) => `${k}='${enc(v)}'`)).join('\n') + '\n';
  writeFileAtomic(ENV_FILE, text, 0o600);
}
function validName(name) { return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name); }
function assertName(name) { if (!validName(name)) throw new Error('secret name must match [A-Za-z_][A-Za-z0-9_]*'); }
function index() {
  const names = readJson(INDEX, []);
  if (!Array.isArray(names) || names.some((name) => !validName(name))) throw new Error('invalid secret index; expected an array of secret identifiers');
  return names;
}
function saveIndex(names) { writeJson(INDEX, [...new Set(names)].sort(), 0o600); }

export function getSecret(name) {
  assertName(name);
  const b = backend();
  try {
    if (b === 'keychain') return run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']).replace(/\n$/, '');
    if (b === 'secret-tool') return run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]).replace(/\n$/, '');
  } catch (e) {
    if (!isMissing(b, e)) throw new Error(`could not read ${name} from the ${b} store: ${processFailure(b, e)}`);
  }
  const fromFile = readEnvFile()[name];
  return fromFile;
}
export function setSecret(name, value) {
  assertName(name);
  if (typeof value !== 'string' || value === '') throw new Error(`${name}: a secret value must be a non-empty string`);
  return withMutationLock(() => setSecretLocked(name, value));
}
function setSecretLocked(name, value) {
  assertName(name);
  const names = index(); // Refuse corrupted tracking before storing a credential.
  const b = backend();
  if (typeof value !== 'string' || value === '') throw new Error(`${name}: a secret value must be a non-empty string`);
  try {
    if (b === 'keychain') run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]);
    else if (b === 'secret-tool') run('secret-tool', ['store', '--label', `${SERVICE}:${name}`, 'service', SERVICE, 'account', name], value);
    else { const m = readEnvFile(); m[name] = value; writeEnvFile(m); }
  } catch (e) {
    // execFileSync puts the whole argv in e.message, and for the keychain that argv holds
    // the value itself. bin/eag.js prints err.message, so it must never carry the secret.
    throw new Error(`could not store ${name} in the ${b} store: ${processFailure(b, e)}`);
  }
  saveIndex([...names, name]);
}
export function deleteSecret(name) {
  assertName(name);
  return withMutationLock(() => deleteSecretLocked(name));
}
function deleteSecretLocked(name) {
  assertName(name);
  const names = index();
  const b = backend();
  let storeError = null;
  try {
    if (b === 'keychain') run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
    else if (b === 'secret-tool') run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
  } catch (e) {
    // "not there" is success (security exits 44 = errSecItemNotFound; secret-tool exits
    // non-zero with no output). Anything else must not be reported as removed while the
    // value stays resolvable and keeps being written into the agents' configs.
    const missing = isMissing(b, e);
    if (!missing) storeError = processFailure(b, e);
  }
  // Leave the name in the index when the store still has it: the index is what `eag secret
  // ls` and `eag env` read, and saying "removed" over a live credential is the worse lie.
  if (storeError) throw new Error(`could not remove ${name} from the ${b} store: ${storeError}`);
  const m = readEnvFile(); if (name in m) { delete m[name]; writeEnvFile(m); }
  saveIndex(names.filter((n) => n !== name));
}
function isMissing(b, e) {
  if (e.signal || e.code === 'ETIMEDOUT' || e.code === 'ENOENT') return false;
  return (b === 'keychain' && e.status === 44)
    || (b === 'secret-tool' && e.status === 1 && !e.stderr?.toString().trim());
}
export function listSecrets() { return index(); }
export function backendName() { return backend(); }

// Resolution order: store, then the current process environment.
export function resolveSecret(name) {
  const v = getSecret(name);
  if (v !== undefined && v !== '') return v;
  if (process.env[name]) return process.env[name];
  return undefined;
}
