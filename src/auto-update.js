import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EAG_HOME } from './paths.js';
import { readJson } from './util.js';
import { withLock, withMutationLock } from './lock.js';
import { installKind, newer, npmArgv, validVersion } from './update.js';
import { runCommand } from './process.js';
import { processFailure } from './redact.js';
import {
  BASE_ROOT, POLICY_FILE, UPDATE_ROOT, ACTIVE_FILE, STATUS_FILE, PENDING_FILE,
  GATE, RELEASES, guardStore, loadPolicy, writePrivate, versionLine,
  treeDigest, verifyRelease, selectRuntime, busyReaders, present,
} from './update-runtime.js';

const REGISTRY = 'https://registry.npmjs.org';
export const DAY = 24 * 3600 * 1000;
export const WORKER_LOCK = path.join(UPDATE_ROOT, 'worker.lock');
const PREVIOUS_FILE = path.join(UPDATE_ROOT, 'previous.json');

export function setAutoUpdate(enabled, { baseRoot = BASE_ROOT } = {}) {
  guardStore();
  return withMutationLock(() => withLock(GATE, () => {
    const runtime = selectRuntime(baseRoot), pkg = runtime.pkg;
    if (enabled && installKind(path.join(baseRoot, 'bin', 'eag.js')) !== 'global') throw new Error('automatic updates require a global npm install; checkouts and npx are never updated');
    if (enabled && (pkg.eagUpdate?.protocol !== 1 || !Number.isSafeInteger(pkg.eagUpdate.compatibility))) throw new Error('this version does not declare update compatibility');
    // An explicit off can repair malformed consent. Never reuse a generation:
    // revocation followed by consent must cancel an already-running download.
    const policy = { protocol: 1, enabled, generation: randomUUID(), line: versionLine(pkg.version),
      compatibility: pkg.eagUpdate?.compatibility ?? 1, consentedAt: new Date().toISOString() };
    writePrivate(POLICY_FILE, policy);
    return policy;
  }));
}

export function updateStatus({ baseRoot = BASE_ROOT } = {}) {
  const runtime = selectRuntime(baseRoot);
  try {
    guardStore();
    const policy = loadPolicy();
    const active = readJson(ACTIVE_FILE, null);
    return { current: runtime.pkg.version, kind: installKind(path.join(baseRoot, 'bin', 'eag.js')),
      enabled: policy?.enabled ?? false, line: policy?.line ?? null, policyFile: POLICY_FILE,
      active: runtime.receipt?.version ?? (active?.version === runtime.pkg.version ? active.version : null), warning: runtime.warning ?? null,
      locks: [WORKER_LOCK, GATE].filter(file => present(file)).map(file => path.basename(file)),
      last: readJson(STATUS_FILE, null), pending: readJson(PENDING_FILE, null)?.version ?? null };
  } catch (e) { return { current: runtime.pkg.version, enabled: false, error: e.message }; }
}

// No inherited credentials, NODE_OPTIONS, npm configuration or project paths.
export function cleanEnvironment(home = os.homedir()) {
  return { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    LANG: 'C', NO_COLOR: '1' };
}

export function isDue(status, now = Date.now()) {
  const last = status?.attemptedAt;
  return !Number.isFinite(last) || last > now || now - last >= (status?.result === 'pending' ? 60000 : DAY);
}

export function scheduleAutoUpdate({ baseRoot = BASE_ROOT, workerRoot = BASE_ROOT, now = Date.now(), spawnWorker = spawn } = {}) {
  try {
    if (installKind(path.join(baseRoot, 'bin', 'eag.js')) !== 'global') return false;
    guardStore();
    if (!loadPolicy()?.enabled || !isDue(readJson(STATUS_FILE, null), now) || present(WORKER_LOCK)) return false;
    const child = spawnWorker(process.execPath, [path.join(workerRoot, 'bin', 'eag-update-worker.js'), baseRoot], {
      detached: true, stdio: 'ignore', cwd: EAG_HOME, env: { ...cleanEnvironment(), EAG_HOME },
    });
    child.on('error', () => {}); child.unref(); return true;
  } catch { return false; }
}

export async function download(url, { maxBytes, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: ctl.signal, redirect: 'error', headers: { accept: '*/*' } });
    if (!response.ok || !response.body) throw new Error('registry request failed');
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) { ctl.abort(); throw new Error('registry response exceeds limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

export function eligible(metadata, policy, current) {
  return metadata?.name === 'easy-agnostic' && validVersion(metadata.version) && newer(metadata.version, current)
    && versionLine(metadata.version) === policy.line && versionLine(current) === policy.line
    && metadata.eagUpdate?.protocol === 1 && metadata.eagUpdate?.automatic === true
    && metadata.eagUpdate?.compatibility === policy.compatibility;
}

export function checkArchive(metadata, bytes) {
  const expectedUrl = `${REGISTRY}/easy-agnostic/-/easy-agnostic-${metadata.version}.tgz`;
  if (!validVersion(metadata.version) || metadata.dist?.tarball !== expectedUrl) throw new Error('unexpected update archive URL');
  const sri = metadata.dist?.integrity;
  if (typeof sri !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(sri)) throw new Error('update requires SHA-512 registry integrity');
  const expected = Buffer.from(sri.slice(7), 'base64');
  if (!timingSafeEqual(createHash('sha512').update(bytes).digest(), expected)) throw new Error('update archive integrity mismatch');
}

export function installArchive(stage, archive, { run = runCommand } = {}) {
  const home = path.join(stage, 'npm-home'); fs.mkdirSync(home, { mode: 0o700 });
  const userConfig = path.join(home, 'user.npmrc'), globalConfig = path.join(home, 'global.npmrc');
  for (const file of [userConfig, globalConfig]) fs.writeFileSync(file, '', { mode: 0o600 });
  const [command, ...prefix] = npmArgv();
  run(command, [...prefix, 'install', archive, '--prefix', stage, '--ignore-scripts', '--no-bin-links',
    '--no-audit', '--no-fund', '--engine-strict', '--registry', REGISTRY, '--userconfig', userConfig,
    '--globalconfig', globalConfig, '--cache', path.join(home, 'cache')], {
    cwd: stage, env: cleanEnvironment(home), timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function healthCheck(packageRoot, stage, version) {
  const home = path.join(stage, 'health'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...cleanEnvironment(home), EAG_HOME: path.join(home, '.agents'), CODEX_HOME: path.join(home, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(home, 'claude'), PI_CODING_AGENT_DIR: path.join(home, 'pi'), EAG_PROJECT: home,
    EAG_SECRET_BACKEND: 'file' };
  const entry = path.join(packageRoot, 'bin', 'eag.js');
  const actual = runCommand(process.execPath, [entry, '--version'], { cwd: home, env, encoding: 'utf8', timeout: 10000 }).trim();
  if (actual !== version) throw new Error('update version smoke test failed');
  runCommand(process.execPath, [entry, '--help'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
}

async function stageRelease(metadata, policy, { downloadImpl, install, health }) {
  // Validate URL/integrity shape before contacting any archive host.
  const url = `${REGISTRY}/easy-agnostic/-/easy-agnostic-${metadata.version}.tgz`;
  if (metadata.dist?.tarball !== url) throw new Error('unexpected update archive URL');
  const bytes = await downloadImpl(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30000 });
  checkArchive(metadata, bytes);
  guardStore();
  const fresh = loadPolicy();
  if (!fresh?.enabled || fresh.generation !== policy.generation) throw new Error('automatic update consent changed before staging');
  fs.mkdirSync(RELEASES, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(UPDATE_ROOT, 'stage-'));
  try {
    const archive = path.join(stage, 'package.tgz'); fs.writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
    await install(stage, archive);
    const modules = path.join(stage, 'node_modules'), packageRoot = path.join(modules, 'easy-agnostic');
    const digest = treeDigest(modules), pkg = readJson(path.join(packageRoot, 'package.json'));
    if (pkg?.name !== 'easy-agnostic' || pkg.version !== metadata.version || pkg.eagUpdate?.protocol !== 1
        || pkg.eagUpdate?.automatic !== true || pkg.eagUpdate?.compatibility !== policy.compatibility) throw new Error('installed package does not match approved metadata');
    await health(packageRoot, stage, pkg.version);
    if (digest !== treeDigest(modules)) throw new Error('installed package changed during validation');
    const receipt = { protocol: 1, id: randomUUID(), version: pkg.version, digest, generation: policy.generation,
      compatibility: policy.compatibility, installedAt: new Date().toISOString() };
    // These are exclusively this attempt's temporary downloads/cache/health home.
    for (const name of ['package.tgz', 'npm-home', 'health']) fs.rmSync(path.join(stage, name), { recursive: true, force: true });
    fs.renameSync(stage, path.join(RELEASES, receipt.id));
    return receipt;
  } finally {
    // A completed rename leaves nothing here. Never delete existing releases.
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function activate(receipt, policy, baseRoot = BASE_ROOT) {
  guardStore();
  return withMutationLock(() => withLock(GATE, () => {
    const fresh = loadPolicy();
    if (!fresh?.enabled || fresh.generation !== policy.generation || receipt.generation !== fresh.generation) return 'cancelled';
    const candidate = verifyRelease(receipt), current = selectRuntime(baseRoot).pkg.version;
    if (!eligible(candidate.pkg, fresh, current)) return 'manual-required';
    if (busyReaders()) return 'pending';
    writePrivate(PREVIOUS_FILE, readJson(ACTIVE_FILE, null));
    writePrivate(ACTIVE_FILE, receipt);
    return 'activated';
  }));
}

export async function runAutoUpdate({ baseRoot = BASE_ROOT, now = Date.now(), downloadImpl = download,
  install = installArchive, health = healthCheck } = {}) {
  try {
    if (installKind(path.join(baseRoot, 'bin', 'eag.js')) !== 'global') return 'unsupported';
    guardStore();
    if (!loadPolicy()?.enabled) return 'disabled';
    return await withLock(WORKER_LOCK, async () => {
      const policy = loadPolicy();
      if (!policy?.enabled) return 'disabled';
      if (!isDue(readJson(STATUS_FILE, null), now)) return 'throttled';
      const status = { attemptedAt: now, result: 'checking' };
      writePrivate(STATUS_FILE, status); // also throttles failures/offline launches
      try {
        let receipt = readJson(PENDING_FILE, null);
        if (!receipt || receipt.generation !== policy.generation) {
          const metadata = JSON.parse((await downloadImpl(`${REGISTRY}/easy-agnostic/latest`, { maxBytes: 512 * 1024 })).toString('utf8'));
          status.latest = validVersion(metadata?.version) ? metadata.version : null;
          const current = selectRuntime(baseRoot).pkg.version;
          if (metadata?.name !== 'easy-agnostic' || !validVersion(metadata.version)) throw new Error('invalid registry metadata');
          if (!newer(metadata.version, current)) { status.result = 'current'; return status.result; }
          if (!eligible(metadata, policy, current)) { status.result = 'manual-required'; return status.result; }
          receipt = await stageRelease(metadata, policy, { downloadImpl, install, health });
          writePrivate(PENDING_FILE, receipt);
        }
        try { status.result = activate(receipt, policy, baseRoot); }
        catch (e) {
          if (e.message.startsWith('another eag mutation holds ')) status.result = 'pending';
          else throw e;
        }
        if (status.result !== 'pending') writePrivate(PENDING_FILE, null);
        status.version = receipt.version;
        return status.result;
      } catch (e) {
        status.result = 'failed'; status.error = processFailure('automatic update', e); return 'failed';
      } finally { writePrivate(STATUS_FILE, status); }
    });
  } catch { return 'unavailable'; } // launcher remains independent of maintenance
}
