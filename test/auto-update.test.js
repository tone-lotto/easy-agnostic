import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sandbox, write, read, mode } from './helpers.js';

const dir = sandbox();
const runtime = await import('../src/update-runtime.js');
const auto = await import('../src/auto-update.js');
const { withLock, MUTATION_LOCK } = await import('../src/lock.js');
const { run } = await import('../src/commands/update.js');
const baseRoot = path.join(dir, 'global');
const basePackage = { name: 'easy-agnostic', version: '0.13.0', type: 'module', eagUpdate: { protocol: 1, compatibility: 1, automatic: true } };
write(path.join(baseRoot, 'package.json'), JSON.stringify(basePackage));
write(path.join(baseRoot, 'bin/eag.js'), '');
write(path.join(baseRoot, 'src/cli.js'), 'export function main() { return 0; }');
const bytes = Buffer.from('synthetic archive; installer is injected');
const metadata = (version = '0.13.1') => ({ ...basePackage, version, dist: {
  tarball: `https://registry.npmjs.org/easy-agnostic/-/easy-agnostic-${version}.tgz`,
  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
} });
const enable = () => auto.setAutoUpdate(true, { baseRoot });
const load = file => JSON.parse(read(file));
function dependencies(meta = metadata()) {
  const calls = { download: 0, install: 0, health: 0 };
  return { calls, baseRoot, now: 100000,
    downloadImpl: async url => { calls.download++; return url.endsWith('/latest') ? Buffer.from(JSON.stringify(meta)) : bytes; },
    install: async stage => { calls.install++; write(path.join(stage, 'node_modules/easy-agnostic/package.json'), JSON.stringify(meta)); write(path.join(stage, 'node_modules/easy-agnostic/src/cli.js'), 'export async function main() { return 7; }'); },
    health: async () => { calls.health++; },
  };
}
beforeEach(() => {
  // Only synthetic files below sandbox(), never real user state.
  fs.rmSync(runtime.UPDATE_ROOT, { recursive: true, force: true });
  fs.rmSync(runtime.POLICY_FILE, { force: true });
  fs.chmodSync(process.env.EAG_HOME, 0o755);
});

test('default off: no network, spawn, state, or legacy/project consent promotion', async () => {
  write(path.join(process.env.EAG_HOME, 'agents.json'), '{"autoUpdate":true}');
  write(path.join(process.env.EAG_PROJECT, '.agents/update-policy.json'), '{"enabled":true}');
  const opts = dependencies();
  assert.equal(await auto.runAutoUpdate(opts), 'disabled');
  assert.equal(auto.scheduleAutoUpdate({ baseRoot, spawnWorker: () => { throw new Error('must not spawn'); } }), false);
  assert.equal(opts.calls.download, 0);
  assert.equal(fs.existsSync(runtime.UPDATE_ROOT), false);
});

test('consent is private, revocable and has a new generation each time', () => {
  const initial = enable(); assert.equal(mode(runtime.POLICY_FILE), 0o600);
  const disabled = auto.setAutoUpdate(false, { baseRoot });
  assert.equal(disabled.enabled, false); assert.notEqual(disabled.generation, initial.generation);
  assert.notEqual(enable().generation, initial.generation);
});

test('dev and npx refuse consent and worker execution without network', async () => {
  assert.throws(() => auto.setAutoUpdate(true), /checkouts and npx/);
  const npx = path.join(dir, '_npx', 'fixture');
  write(path.join(npx, 'package.json'), JSON.stringify(basePackage)); write(path.join(npx, 'bin/eag.js'), '');
  assert.throws(() => auto.setAutoUpdate(true, { baseRoot: npx }), /checkouts and npx/);
  assert.equal(await auto.runAutoUpdate(), 'unsupported');
});

test('malformed consent fails closed and explicit off repairs it', async () => {
  write(runtime.POLICY_FILE, '{bad');
  const opts = dependencies(); assert.equal(await auto.runAutoUpdate(opts), 'unavailable');
  assert.equal(auto.updateStatus({ baseRoot }).enabled, false); assert.equal(opts.calls.download, 0);
  auto.setAutoUpdate(false, { baseRoot }); assert.equal(runtime.loadPolicy().enabled, false);
});

test('eligible releases require exact stable version, same line and publisher compatibility', () => {
  const policy = enable();
  assert.equal(auto.eligible(metadata(), policy, '0.13.0'), true);
  for (const version of ['0.14.0', '1.0.0', '0.13.1-beta', 'file:evil', '0.13.0']) assert.equal(auto.eligible(metadata(version), policy, '0.13.0'), false);
  for (const eagUpdate of [null, { protocol: 1, compatibility: 1 }, { protocol: 1, compatibility: 2, automatic: true }]) assert.equal(auto.eligible({ ...metadata(), eagUpdate }, policy, '0.13.0'), false);
});

test('fully staged activation preserves native configs and baseline; dispatcher selects new version', async () => {
  enable();
  const config = write(path.join(process.env.CODEX_HOME, 'config.toml'), '# personal config');
  const opts = dependencies(); assert.equal(await auto.runAutoUpdate(opts), 'activated');
  assert.deepEqual(opts.calls, { download: 2, install: 1, health: 1 });
  assert.equal(runtime.selectRuntime(baseRoot).pkg.version, '0.13.1');
  assert.equal(await runtime.boot(['status'], baseRoot), 7);
  assert.equal(read(config), '# personal config');
  assert.equal(load(path.join(baseRoot, 'package.json')).version, '0.13.0');
  assert.equal(mode(runtime.ACTIVE_FILE), 0o600);
  auto.setAutoUpdate(false, { baseRoot });
  assert.equal(runtime.selectRuntime(baseRoot).pkg.version, '0.13.1', 'off keeps current version');
});

test('version outside the approved line reports manual-required without installing', async () => {
  enable(); const opts = dependencies(metadata('0.14.0'));
  assert.equal(await auto.runAutoUpdate(opts), 'manual-required');
  assert.equal(opts.calls.install, 0); assert.equal(fs.existsSync(runtime.ACTIVE_FILE), false);
});

test('offline failures are throttled for a day and keep previous version', async () => {
  enable(); const opts = dependencies(); let calls = 0;
  opts.downloadImpl = async () => { calls++; throw new Error('secret registry error'); };
  assert.equal(await auto.runAutoUpdate(opts), 'failed');
  assert.equal(await auto.runAutoUpdate({ ...opts, now: opts.now + 1000 }), 'throttled');
  assert.equal(calls, 1); assert.equal(runtime.selectRuntime(baseRoot).pkg.version, '0.13.0');
  assert.doesNotMatch(read(runtime.STATUS_FILE), /secret registry error/);
  assert.equal(await auto.runAutoUpdate({ ...opts, now: opts.now + auto.DAY }), 'failed');
  assert.equal(calls, 2);
});

test('archive digest mismatch and foreign URL never reach installer', async () => {
  enable(); const meta = metadata(); meta.dist.integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  const opts = dependencies(meta); assert.equal(await auto.runAutoUpdate(opts), 'failed'); assert.equal(opts.calls.install, 0);
  meta.dist.tarball = 'https://evil.example/package.tgz'; opts.now += auto.DAY;
  assert.equal(await auto.runAutoUpdate(opts), 'failed'); assert.equal(opts.calls.download, 3);
});

test('failed installer or smoke test never switches active version', async () => {
  enable(); const opts = dependencies(); opts.install = async () => { throw new Error('failed'); };
  assert.equal(await auto.runAutoUpdate(opts), 'failed'); assert.equal(fs.existsSync(runtime.ACTIVE_FILE), false);
  const smoke = dependencies(); smoke.now += auto.DAY; smoke.health = async () => { throw new Error('smoke failure'); };
  assert.equal(await auto.runAutoUpdate(smoke), 'failed'); assert.equal(fs.existsSync(runtime.ACTIVE_FILE), false);
});

test('package metadata mismatch is rejected even when registry archive matches', async () => {
  enable(); const opts = dependencies(), install = opts.install;
  opts.install = async stage => { await install(stage); write(path.join(stage, 'node_modules/easy-agnostic/package.json'), JSON.stringify(metadata('0.13.2'))); };
  assert.equal(await auto.runAutoUpdate(opts), 'failed'); assert.equal(opts.calls.health, 0);
});

test('revocation during download prevents installation; reconsent does not revive old worker', async () => {
  enable(); const opts = dependencies(), download = opts.downloadImpl;
  opts.downloadImpl = async url => {
    const result = await download(url);
    if (!url.endsWith('/latest')) { auto.setAutoUpdate(false, { baseRoot }); enable(); }
    return result;
  };
  assert.equal(await auto.runAutoUpdate(opts), 'failed'); assert.equal(opts.calls.install, 0);
});

test('revocation during validation prevents activation', async () => {
  enable(); const opts = dependencies(); opts.health = async () => auto.setAutoUpdate(false, { baseRoot });
  assert.equal(await auto.runAutoUpdate(opts), 'cancelled'); assert.equal(fs.existsSync(runtime.ACTIVE_FILE), false);
});

test('live reader postpones activation, later launch activates pending without redownload', async () => {
  enable(); const reader = runtime.acquireRuntime(baseRoot), opts = dependencies();
  assert.equal(await auto.runAutoUpdate(opts), 'pending'); assert.equal(fs.existsSync(runtime.ACTIVE_FILE), false);
  reader.release();
  assert.equal(await auto.runAutoUpdate({ ...opts, now: opts.now + 60000 }), 'activated');
  assert.equal(opts.calls.download, 2); assert.equal(opts.calls.install, 1);
});

test('mutation lock held by another process postpones activation', async () => {
  enable(); write(MUTATION_LOCK, '{"pid":123}');
  try { assert.equal(await auto.runAutoUpdate(dependencies()), 'pending'); }
  finally { fs.unlinkSync(MUTATION_LOCK); }
});

test('worker lock serializes overlapping workers and stale locks fail closed', async () => {
  enable(); const opts = dependencies(); write(auto.WORKER_LOCK, '{}');
  assert.equal(await auto.runAutoUpdate(opts), 'unavailable'); assert.equal(opts.calls.download, 0);
  assert.equal(auto.scheduleAutoUpdate({ baseRoot }), false);
});

test('dead leases can be removed but unknown leases block activation', () => {
  const id = randomUUID(), lease = write(path.join(runtime.READERS, `123-${id}.json`), JSON.stringify({ pid: 123, id }));
  assert.equal(withLock(runtime.GATE, () => runtime.busyReaders(() => false)), false); assert.equal(fs.existsSync(lease), false);
  write(path.join(runtime.READERS, 'unknown.json'), '{}');
  assert.equal(withLock(runtime.GATE, () => runtime.busyReaders(() => false)), true);
});

test('tampered installed runtime falls back to baseline without replaying mutations', async () => {
  enable(); assert.equal(await auto.runAutoUpdate(dependencies()), 'activated');
  const selected = runtime.selectRuntime(baseRoot);
  write(path.join(selected.root, 'src/cli.js'), 'throw new Error("tampered")');
  const fallback = runtime.selectRuntime(baseRoot);
  assert.equal(fallback.pkg.version, '0.13.0'); assert.match(fallback.warning, /integrity mismatch/);
});

test('import failure falls back before command execution; command failure is never replayed', async () => {
  enable(); const opts = dependencies(), install = opts.install;
  opts.install = async stage => { await install(stage); write(path.join(stage, 'node_modules/easy-agnostic/src/cli.js'), 'throw new Error("broken import");'); };
  assert.equal(await auto.runAutoUpdate(opts), 'activated');
  assert.equal(await runtime.boot(['status'], baseRoot), 0);
  const next = dependencies(metadata('0.13.2')), installNext = next.install; next.now += auto.DAY;
  next.install = async stage => { await installNext(stage); write(path.join(stage, 'node_modules/easy-agnostic/src/cli.js'), 'export function main() { throw new Error("partial command failure"); }'); };
  assert.equal(await auto.runAutoUpdate(next), 'activated');
  await assert.rejects(runtime.boot(['status'], baseRoot), /partial command failure/);
});

test('a later activation retains the previous immutable release and receipt', async () => {
  enable(); assert.equal(await auto.runAutoUpdate(dependencies()), 'activated');
  const old = load(runtime.ACTIVE_FILE), oldRoot = runtime.verifyRelease(old).root;
  const next = dependencies(metadata('0.13.2')); next.now += auto.DAY;
  assert.equal(await auto.runAutoUpdate(next), 'activated');
  assert.equal(runtime.selectRuntime(baseRoot).pkg.version, '0.13.2');
  assert.equal(runtime.verifyRelease(old).root, oldRoot);
  assert.deepEqual(load(path.join(runtime.UPDATE_ROOT, 'previous.json')), old);
});

test('unsafe policy aliases and writable homes are refused', () => {
  const foreign = write(path.join(dir, 'foreign.json'), '{}');
  fs.symlinkSync(foreign, runtime.POLICY_FILE);
  assert.throws(enable, /symlink/); assert.equal(read(foreign), '{}'); fs.unlinkSync(runtime.POLICY_FILE);
  fs.chmodSync(process.env.EAG_HOME, 0o777); assert.throws(enable, /unsafe/);
});

test('installed tree rejects symlinks and hardlinks', () => {
  const tree = fs.mkdtempSync(path.join(dir, 'tree-'));
  const original = write(path.join(tree, 'a'), 'text'); fs.symlinkSync(original, path.join(tree, 'b'));
  assert.throws(() => runtime.treeDigest(tree), /unsafe/); fs.unlinkSync(path.join(tree, 'b'));
  fs.linkSync(original, path.join(tree, 'b')); assert.throws(() => runtime.treeDigest(tree), /unsafe/);
});

test('worker has detached ignored stdio, sanitized environment and no project cwd', () => {
  enable(); process.env.EAG_TEST_SECRET = 'credential'; process.env.NODE_OPTIONS = '--trace-warnings';
  let seen;
  try {
    assert.equal(auto.scheduleAutoUpdate({ baseRoot, spawnWorker: (...args) => { seen = args; return { on() {}, unref() {} }; } }), true);
    const options = seen[2]; assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
    assert.equal(options.cwd, process.env.EAG_HOME); assert.equal(options.env.EAG_TEST_SECRET, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.EAG_PROJECT, undefined);
  } finally { delete process.env.NODE_OPTIONS; delete process.env.EAG_TEST_SECRET; }
});

test('npm staging isolates distinct config files and suppresses scripts, bin links and credential inheritance', () => {
  const stage = fs.mkdtempSync(path.join(dir, 'install-'));
  let seen;
  auto.installArchive(stage, path.join(stage, 'package.tgz'), { run: (...args) => { seen = args; } });
  const [, args, options] = seen;
  for (const flag of ['--ignore-scripts', '--no-bin-links', '--engine-strict', '--no-audit']) assert.ok(args.includes(flag));
  const userConfig = args[args.indexOf('--userconfig') + 1], globalConfig = args[args.indexOf('--globalconfig') + 1];
  assert.notEqual(userConfig, globalConfig, 'npm refuses double-loading the same config in two roles');
  assert.equal(read(userConfig), ''); assert.equal(read(globalConfig), '');
  assert.equal(options.cwd, stage); assert.equal(options.env.EAG_HOME, undefined);
  assert.equal(options.env.npm_config_registry, undefined); assert.equal(options.timeout, 120000);
});

test('a newer manually installed baseline supersedes an older managed runtime', async () => {
  enable(); await auto.runAutoUpdate(dependencies());
  const newerRoot = path.join(dir, 'new-baseline');
  write(path.join(newerRoot, 'package.json'), JSON.stringify({ ...basePackage, version: '0.14.0' }));
  write(path.join(newerRoot, 'bin/eag.js'), '');
  assert.equal(runtime.selectRuntime(newerRoot).pkg.version, '0.14.0');
  assert.equal(runtime.selectRuntime(newerRoot).receipt, null);
});

test('bounded fetch rejects redirects and oversized responses, aborts stalled bodies', async () => {
  await assert.rejects(auto.download('https://registry.npmjs.org/x', { maxBytes: 2, fetchImpl: async (_url, opts) => {
    assert.equal(opts.redirect, 'error'); return { ok: true, body: [Buffer.from('large')] };
  } }), /exceeds limit/);
  await assert.rejects(auto.download('https://registry.npmjs.org/x', { maxBytes: 2, timeoutMs: 10, fetchImpl: async (_url, opts) => ({ ok: true,
    body: { async *[Symbol.asyncIterator]() { await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))); } },
  }) }), /aborted/);
});

test('command status is local, invalid args and project flags cannot enable updates, dry-run does not mutate', async () => {
  const fetchBefore = globalThis.fetch; globalThis.fetch = () => { throw new Error('must not fetch'); };
  try {
    assert.equal(await run(['status'], { json: true }), 0);
    assert.equal(await run(['auto', 'on'], { 'dry-run': true }), 0);
    assert.equal(fs.existsSync(runtime.POLICY_FILE), false);
    await assert.rejects(run(['auto', 'maybe'], {}), /usage/);
    const { main } = await import('../src/cli.js');
    assert.equal(await main(['update', 'auto', 'on', '--scope', 'project']), 1);
  } finally { globalThis.fetch = fetchBefore; }
});
