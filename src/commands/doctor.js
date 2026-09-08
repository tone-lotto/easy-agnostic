import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand as execFileSync } from '../process.js';
import { parse } from 'smol-toml';
import { scopePaths, projectRoot, EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME } from '../paths.js';
import { loadSource } from '../source.js';
import { exists, readJson, refsIn, looksLikeSecret, mapStrings, sameTree, c } from '../util.js';
import { resolveSecret, backendName } from '../secrets.js';
import * as pi from '../adapters/pi.js';
import * as shell from '../shell.js';
import { migratable } from '../projects.js';
import * as skillsMod from '../skills.js';
import { installKind, onPath, globalBinDir, VERSION } from '../update.js';
import * as hooks from '../hooks.js';
import * as claude from '../adapters/claude.js';
import { syncInstructions } from '../instructions.js';

const MARK = { ok: c.ok('✓'), warn: c.warn('!'), bad: c.bad('✗'), info: c.dim('·'), fixed: c.ok('✓ fixed') };

function linkSkills(srcDir, dstDir, fix, out) {
  if (!exists(srcDir)) return;
  for (const name of fs.readdirSync(srcDir)) {
    if (name.startsWith('.')) continue;
    const src = path.join(srcDir, name);
    // statSync follows the link: a dangling entry in the skills dir must be skipped, not
    // throw out of the one command whose whole job is to report broken wiring.
    let sst = null;
    try { sst = fs.statSync(src); } catch { /* dangling symlink */ }
    if (!sst?.isDirectory() || !exists(path.join(src, 'SKILL.md'))) continue;
    const dst = path.join(dstDir, name);
    let st = null;
    try { st = fs.lstatSync(dst); } catch { /* missing */ }
    if (st) {
      if (st.isSymbolicLink()) {
        let target = null; try { target = fs.realpathSync(dst); } catch { /* broken */ }
        if (target === fs.realpathSync(src)) out.push({ level: 'ok', msg: `skill ${name} linked into ${dstDir}` });
        else if (target === null) { if (fix) { fs.unlinkSync(dst); fs.symlinkSync(path.relative(dstDir, src), dst); out.push({ level: 'fixed', msg: `skill ${name}: replaced broken symlink` }); } else out.push({ level: 'warn', msg: `skill ${name}: broken symlink at ${dst} (--fix replaces it)` }); }
        else out.push({ level: 'info', msg: `skill ${name}: ${dst} links elsewhere (${target}); left alone` });
      } else if (sameTree(src, dst)) {
        // The same skill, copied. Nothing is lost by replacing the copy with a link, and
        // then editing the source reaches every agent instead of one.
        if (fix) { fs.rmSync(dst, { recursive: true, force: true }); fs.symlinkSync(path.relative(dstDir, src), dst); out.push({ level: 'fixed', msg: `skill ${name}: replaced an identical copy at ${dst} with a link` }); }
        else out.push({ level: 'info', msg: `skill ${name}: ${dst} is an identical copy of ${src} (--fix replaces it with a link)` });
      } else {
        // Two different skills with one name: each agent sees a different one, and eag
        // cannot pick. Loud, because the summary counts warnings and this used to be silent.
        out.push({ level: 'warn', msg: `skill ${name}: ${dst} is a DIFFERENT skill with the same name as ${src}. Each agent sees a different one; eag will not choose. Rename one, or delete the copy to use the shared one` });
      }
    } else if (fix) { fs.mkdirSync(dstDir, { recursive: true }); fs.symlinkSync(path.relative(dstDir, src), dst); out.push({ level: 'fixed', msg: `skill ${name}: linked ${dst} → ${src}` }); }
    else out.push({ level: 'warn', msg: `skill ${name} in ${srcDir} is not visible to Claude Code (--fix creates the symlink)` });
  }
}

// Codex reads ~/.agents/skills itself (verified: skills/list returns entries from there), so
// a copy of the same skill under ~/.codex/skills makes Codex list it TWICE. An identical copy
// can go; a different skill with the same name is a collision eag must not resolve.
function dedupeSkills(srcDir, dupDir, fix, out, agent) {
  if (!exists(srcDir) || !exists(dupDir)) return;
  for (const name of fs.readdirSync(srcDir)) {
    if (name.startsWith('.')) continue;
    const src = path.join(srcDir, name);
    const dup = path.join(dupDir, name);
    let sst = null; let dst = null;
    try { sst = fs.statSync(src); dst = fs.lstatSync(dup); } catch { continue; }
    if (!sst.isDirectory() || !exists(path.join(src, 'SKILL.md'))) continue;
    if (dst.isSymbolicLink()) continue; // someone linked it on purpose; not a copy
    if (sameTree(src, dup)) {
      if (fix) { fs.rmSync(dup, { recursive: true, force: true }); out.push({ level: 'fixed', msg: `skill ${name}: removed the identical copy at ${dup}; ${agent} reads ${srcDir} directly` }); }
      else out.push({ level: 'info', msg: `skill ${name}: ${dup} is an identical copy; ${agent} already reads ${srcDir}, so it is listed twice (--fix removes the copy)` });
    } else {
      out.push({ level: 'warn', msg: `skill ${name}: ${dup} is a DIFFERENT skill with the same name as ${src}; ${agent} lists both. Rename one, or delete the copy to use the shared one` });
    }
  }
}

export async function run(_args, flags) {
  const fix = !!flags.fix;
  const scope = flags.scope ?? 'all';
  if (!['user', 'project', 'all'].includes(scope)) throw new Error('--scope must be user, project or all');
  const root = projectRoot();
  const out = [];
  try {
    await checks(fix, root, out, scope);
  } catch (e) {
    // Findings are collected and printed at the end, so a throw halfway through used to
    // swallow everything doctor had already found. Report the abort as one more finding.
    out.push({ level: 'bad', msg: `check aborted: ${e.message}` });
    if (process.env.EAG_DEBUG) console.error(e);
  }
  const bad = out.filter((o) => o.level === 'bad').length;
  const warn = out.filter((o) => o.level === 'warn').length;
  if (flags.json) { console.log(JSON.stringify({ checks: out, problems: bad, warnings: warn, exit: bad ? 1 : 0 }, null, 2)); return bad ? 1 : 0; }
  for (const o of out) console.log(`${MARK[o.level]} ${o.msg}`);
  console.log(`\n${bad ? c.bad(`${bad} problem(s)`) : c.ok('no problems')}${warn ? `, ${c.warn(`${warn} warning(s)`)}` : ''}${!fix && warn ? c.dim('  (eag doctor --fix repairs symlinks and CLAUDE.md)') : ''}`);
  return bad ? 1 : 0;
}

async function checks(fix, root, out, scope) {
  // An orphan has no matching shared source, so linkSkills cannot discover it.
  // Report it without guessing a new target (especially a project-only skill).
  for (const skill of skillsMod.inventory({ scope: 'user' })) {
    if (skill.broken) out.push({ level: 'warn', msg: `skill ${skill.name}: orphaned broken link at ${skill.path}; inspect before removing or reconnecting it` });
  }
  // source
  const user = loadSource(scopePaths('user'));
  out.push(user.hasMcp ? { level: 'ok', msg: `source: ${user.paths.mcp} (${Object.keys(user.servers).length} servers)` } : { level: 'bad', msg: `source missing: ${user.paths.mcp}. Run: eag init` });
  // From $HOME the "project" .agents/ is the user's own EAG_HOME; there is no project
  // source there, and reading it as one would report the user's file twice.
  const projPaths = scopePaths('project', root);
  const proj = projPaths.collides ? { hasMcp: false, servers: {}, paths: projPaths } : loadSource(projPaths);
  if (proj.hasMcp) out.push({ level: 'ok', msg: `project source: ${proj.paths.mcp} (${Object.keys(proj.servers).length} servers)` });
  for (const s of [user, proj]) {
    if (!s.hasMcp) continue;
    for (const [name, srv] of Object.entries(s.servers)) {
      mapStrings({ headers: srv.headers, env: srv.env, url: srv.url }, (v) => { if (looksLikeSecret(v)) out.push({ level: 'bad', msg: `${name}: literal credential in ${s.paths.mcp}; move it to the keychain (eag secret set) and reference it as \${NAME}` }); return v; });
      for (const r of refsIn(srv)) if (resolveSecret(r) === undefined) out.push({ level: 'warn', msg: `${name} references \${${r}} but it is not set. Run: eag secret set ${r}` });
    }
  }

  // Every agent expands ${NAME} from the environment it was started in, so resolving from
  // the store is not enough: the value has to be exported where the agent can see it.
  const refs = new Set();
  for (const s of [user, proj]) if (s.hasMcp) for (const srv of Object.values(s.servers)) refsIn(srv, refs);
  const notExported = [...refs].filter((r) => resolveSecret(r) !== undefined && process.env[r] === undefined);

  // shell wiring for ${VAR}
  const rc = process.env.EAG_SHELL_RC || path.join(os.homedir(), process.env.SHELL?.endsWith('zsh') ? '.zshrc' : '.bashrc');
  const rcText = exists(rc) ? fs.readFileSync(rc, 'utf8') : '';
  // How eag itself is installed decides whether anything below can keep working: an npx
  // cache is evictable and never on PATH, so hooks pin a path that disappears and the shell
  // file finds no `eag` at all.
  const kind = installKind();
  const gbin = globalBinDir();
  const globalPresent = !!gbin && exists(path.join(gbin, 'eag'));
  if (kind === 'npx' && globalPresent) out.push({ level: 'ok', msg: `eag ${VERSION} installed globally (${gbin}); this run came from npx, the hooks use the global one` });
  else if (kind === 'npx') out.push({ level: 'bad', msg: `eag ${VERSION} runs from the npx cache: evictable, never on PATH, never updated. Run: npm i -g easy-agnostic` });
  else if (kind === 'global' && !onPath('eag')) out.push({ level: 'warn', msg: `eag is installed globally but ${gbin || 'its bin dir'} is not on PATH in this shell; the generated shell file adds it` });
  else out.push({ level: 'ok', msg: `eag ${VERSION} (${kind === 'dev' ? 'linked checkout' : 'global install'})` });

  // Sync-on-launch, and the ${VAR} exports it carries. Either the generated file is wired
  // up, or the older bare `eval "$(eag env)"` line is there and at least the exports work.
  const rcSt = shell.rcState(rc);
  if (rcSt.linked) {
    const bins = shell.wrappableBins();
    const current = exists(shell.INIT_FILE) && fs.readFileSync(shell.INIT_FILE, 'utf8') === shell.render(bins, { binDir: shell.binDirInFile() });
    out.push(current
      ? { level: 'ok', msg: `shell: ${path.basename(rc)} syncs on launch${bins.length ? ` (${bins.join(', ')})` : ''}` }
      : { level: 'warn', msg: `shell: ${shell.INIT_FILE} is out of date. Run: eag hook install` });
  } else if (rcSt.legacyEnvLine) {
    out.push({ level: 'warn', msg: `shell: ${path.basename(rc)} exports the secrets but does not sync on launch. Run: eag hook install` });
  } else {
    out.push({ level: 'warn', msg: `shell: ${rc} neither exports \${NAME} values nor syncs on launch. Run: eag hook install` });
  }
  // The other half of sync-on-launch: an agent opened from a desktop app or an IDE reads no
  // rc, so only its own session hook reaches it.
  const cl = hooks.claudeState();
  const launcherOk = exists(hooks.LAUNCHER) && fs.readFileSync(hooks.LAUNCHER, 'utf8') === hooks.renderLauncher({ binDir: globalBinDir() });
  const cx = hooks.codexState();
  if (cl.current && launcherOk) out.push({ level: 'ok', msg: 'app/IDE launches: Claude Code SessionStart hook installed' });
  else if (cl.installed && !launcherOk) out.push({ level: 'bad', msg: `Claude Code runs a SessionStart hook pointing at ${hooks.LAUNCHER}, which is missing or stale. Run: eag hook install` });
  else if (claude.available()) out.push({ level: 'warn', msg: 'app/IDE launches do not sync: no Claude Code SessionStart hook. Run: eag hook install' });
  // Switches that silently turn every hook off. Worth naming, because the symptom is
  // "sync-on-launch stopped working" with nothing else to see.
  if (cl.installed && cl.settings?.disableAllHooks) {
    out.push({ level: 'bad', msg: `"disableAllHooks" is set in ${cl.file}: the SessionStart hook is installed but will never run` });
  }
  if (cx.current && launcherOk) {
    // Codex skips an untrusted hook in total silence, so an unapproved one is a problem the
    // user would otherwise only discover by noticing nothing ever syncs.
    const t = await hooks.codexTrust();
    if (!t) out.push({ level: 'info', msg: 'app launches: Codex SessionStart hook installed; trust state unknown (could not ask codex app-server)' });
    else if (t.status === 'trusted' && t.enabled !== false) out.push({ level: 'ok', msg: 'app launches: Codex SessionStart hook installed and approved' });
    else out.push({ level: 'warn', msg: `Codex will not run its SessionStart hook: trust is "${t.status}"${t.enabled === false ? ' and it is disabled' : ''}. Open Codex, run /hooks and approve it` });
  } else if (exists(path.join(CODEX_HOME, 'config.toml')) && !cx.installed) {
    out.push({ level: 'warn', msg: 'app launches do not sync: no Codex SessionStart hook. Run: eag hook install' });
  }
  const managed = readJson(path.join(CLAUDE_CONFIG_DIR, 'managed-settings.json'), null);
  if (cl.installed && (managed?.allowManagedHooksOnly || managed?.strictPluginOnlyCustomization)) {
    out.push({ level: 'warn', msg: `managed settings restrict hooks (${managed.allowManagedHooksOnly ? 'allowManagedHooksOnly' : 'strictPluginOnlyCustomization'}); the SessionStart hook may not run` });
  }
  if (notExported.length) out.push({ level: 'warn', msg: rcSt.linked
    ? `${notExported.join(', ')} are not exported in THIS shell yet (the shell file was installed after it started). Open a new terminal, or run: . ${shell.INIT_FILE}`
    : `${notExported.join(', ')} resolve from the ${backendName()} store but are not exported in this shell; the agents expand \${NAME} from their own environment, so run  eval "$(eag env)"  and restart them` });

  // claude
  out.push(claude.available() ? { level: 'ok', msg: 'claude CLI available' } : { level: 'warn', msg: 'claude CLI not on PATH; user-scope apply needs it' });
  linkSkills(path.join(EAG_HOME, 'skills'), path.join(CLAUDE_CONFIG_DIR, 'skills'), fix && scope !== 'project', out);
  dedupeSkills(path.join(EAG_HOME, 'skills'), path.join(CODEX_HOME, 'skills'), fix && scope !== 'project', out, 'Codex');
  // From $HOME the "project" .agents/skills IS the user's shared dir: linking it again from
  // there reported every skill twice.
  if (scope !== 'user' && !scopePaths('project', root).collides && exists(path.join(root, '.agents', 'skills'))) {
    if (fix) skillsMod.locations({ scope: 'project', root });
    linkSkills(path.join(root, '.agents', 'skills'), path.join(root, '.claude', 'skills'), fix, out);
  }
  const instructions = scope === 'user' ? { op: 'skipped' } : syncInstructions(root, { dryRun: !fix });
  if (instructions.op !== 'skipped') out.push({
    level: instructions.op === 'conflict' ? 'bad' : instructions.op === 'noop' ? 'ok' : fix ? 'fixed' : 'warn',
    msg: `instructions: ${instructions.message}${!fix && ['sync', 'enroll'].includes(instructions.op) ? ' (eag instructions applies this)' : ''}`,
  });

  // codex
  const codexToml = path.join(CODEX_HOME, 'config.toml');
  if (exists(codexToml)) {
    let cfg = {};
    try { cfg = parse(fs.readFileSync(codexToml, 'utf8')); out.push({ level: 'ok', msg: `codex: ${codexToml} parses` }); } catch { out.push({ level: 'bad', msg: `codex: ${codexToml} is not valid TOML (content withheld)` }); }
    const trust = cfg.projects?.[root]?.trust_level;
    if (proj.hasMcp) out.push(trust === 'trusted' ? { level: 'ok', msg: `codex: project ${root} is trusted` } : { level: 'warn', msg: `codex: project ${root} is not trusted; Codex ignores .codex/config.toml until you trust it inside Codex` });
    try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); out.push({ level: 'ok', msg: 'codex CLI runs' }); }
    catch { out.push({ level: 'warn', msg: 'codex CLI on PATH does not run (reinstall: npm install -g @openai/codex@latest); config is still written' }); }
  } else out.push({ level: 'info', msg: `codex not found at ${CODEX_HOME}` });

  // Skills one agent keeps to itself. Codex reads ~/.agents/skills, Claude gets links from
  // it; a skill that never got there is invisible to the other agent.
  const agentOnly = skillsMod.plan().filter((i) => i.op === 'adopt');
  if (agentOnly.length) out.push({ level: 'warn', msg: `${agentOnly.length} skill(s) only one agent has: ${agentOnly.map((i) => `${i.name} (${i.agent})`).join(', ')}. Run: eag adopt skills` });
  for (const i of skillsMod.plan().filter((x) => x.op === 'collision')) out.push({ level: 'warn', msg: `skill ${i.name}: ${i.from} is a DIFFERENT skill from ${i.against}; each agent sees its own. Rename one` });

  // Projects whose servers only Claude can see: the one gap eag cannot close by syncing,
  // because the servers are not in any source yet.
  for (const p of migratable()) {
    if (p.skip) continue;
    if (fix) continue; // --fix repairs wiring, not other people's repositories
    out.push({ level: 'warn', msg: `${p.root}: ${p.names.join(', ')} exist only in Claude Code (local scope); Codex and Pi cannot see them. Run: eag adopt claude --all-projects` });
  }

  // pi
  out.push(...pi.checks(root, { ...user.servers, ...(proj.hasMcp ? proj.servers : {}) }));
}
