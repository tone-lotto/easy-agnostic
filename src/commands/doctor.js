import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { scopePaths, projectRoot, EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME } from '../paths.js';
import { loadSource } from '../source.js';
import { exists, refsIn, looksLikeSecret, mapStrings, writeFileAtomic, backup, c } from '../util.js';
import { resolveSecret, backendName } from '../secrets.js';
import * as pi from '../adapters/pi.js';
import * as claude from '../adapters/claude.js';

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
      } else out.push({ level: 'info', msg: `skill ${name}: real directory at ${dst} shadows ${src}; left alone` });
    } else if (fix) { fs.mkdirSync(dstDir, { recursive: true }); fs.symlinkSync(path.relative(dstDir, src), dst); out.push({ level: 'fixed', msg: `skill ${name}: linked ${dst} → ${src}` }); }
    else out.push({ level: 'warn', msg: `skill ${name} in ${srcDir} is not visible to Claude Code (--fix creates the symlink)` });
  }
}

export async function run(_args, flags) {
  const fix = !!flags.fix;
  const root = projectRoot();
  const out = [];
  try {
    await checks(fix, root, out);
  } catch (e) {
    // Findings are collected and printed at the end, so a throw halfway through used to
    // swallow everything doctor had already found. Report the abort as one more finding.
    out.push({ level: 'bad', msg: `check aborted: ${e.message}` });
    if (process.env.EAG_DEBUG) console.error(e);
  }
  for (const o of out) console.log(`${MARK[o.level]} ${o.msg}`);
  const bad = out.filter((o) => o.level === 'bad').length;
  const warn = out.filter((o) => o.level === 'warn').length;
  console.log(`\n${bad ? c.bad(`${bad} problem(s)`) : c.ok('no problems')}${warn ? `, ${c.warn(`${warn} warning(s)`)}` : ''}${!fix && warn ? c.dim('  (eag doctor --fix repairs symlinks and CLAUDE.md)') : ''}`);
  return bad ? 1 : 0;
}

async function checks(fix, root, out) {
  // source
  const user = loadSource(scopePaths('user'));
  out.push(user.hasMcp ? { level: 'ok', msg: `source: ${user.paths.mcp} (${Object.keys(user.servers).length} servers)` } : { level: 'bad', msg: `source missing: ${user.paths.mcp}. Run: eag init` });
  const proj = loadSource(scopePaths('project', root));
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
  out.push(/eag env/.test(rcText) ? { level: 'ok', msg: `shell: ${path.basename(rc)} evaluates eag env` } : { level: 'warn', msg: `shell: add  eval "$(eag env)"  to ${rc} so \${VAR} references resolve in the agents` });
  if (notExported.length) out.push({ level: 'warn', msg: `${notExported.join(', ')} resolve from the ${backendName()} store but are not exported in this shell; the agents expand \${NAME} from their own environment, so run  eval "$(eag env)"  and restart them` });

  // claude
  out.push(claude.available() ? { level: 'ok', msg: 'claude CLI available' } : { level: 'warn', msg: 'claude CLI not on PATH; user-scope apply needs it' });
  linkSkills(path.join(EAG_HOME, 'skills'), path.join(CLAUDE_CONFIG_DIR, 'skills'), fix, out);
  if (exists(path.join(root, '.agents', 'skills'))) linkSkills(path.join(root, '.agents', 'skills'), path.join(root, '.claude', 'skills'), fix, out);
  const agentsMd = path.join(root, 'AGENTS.md');
  const claudeMd = path.join(root, 'CLAUDE.md');
  if (exists(agentsMd)) {
    const text = exists(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : '';
    if (/^@AGENTS\.md\s*$/m.test(text)) out.push({ level: 'ok', msg: 'CLAUDE.md imports AGENTS.md' });
    else if (fix) {
      // The one destructive write that used to skip both the backup and the atomic rename:
      // a failure mid-write left an empty CLAUDE.md with nothing to restore it from.
      const bak = backup(claudeMd, path.join(EAG_HOME, '.state', 'backup'), 'claude-md');
      writeFileAtomic(claudeMd, `@AGENTS.md\n${text ? `\n${text}` : ''}`);
      out.push({ level: 'fixed', msg: `CLAUDE.md: added @AGENTS.md${text ? ' at the top' : ''}${bak ? ` (backup: ${bak})` : ''}` });
    }
    else out.push({ level: 'warn', msg: `AGENTS.md exists but CLAUDE.md does not import it (--fix prepends @AGENTS.md)` });
  }

  // codex
  const codexToml = path.join(CODEX_HOME, 'config.toml');
  if (exists(codexToml)) {
    let cfg = {};
    try { cfg = parse(fs.readFileSync(codexToml, 'utf8')); out.push({ level: 'ok', msg: `codex: ${codexToml} parses` }); } catch (e) { out.push({ level: 'bad', msg: `codex: ${codexToml} is not valid TOML: ${e.message}` }); }
    const trust = cfg.projects?.[root]?.trust_level;
    if (proj.hasMcp) out.push(trust === 'trusted' ? { level: 'ok', msg: `codex: project ${root} is trusted` } : { level: 'warn', msg: `codex: project ${root} is not trusted; Codex ignores .codex/config.toml until you trust it inside Codex` });
    try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); out.push({ level: 'ok', msg: 'codex CLI runs' }); }
    catch { out.push({ level: 'warn', msg: 'codex CLI on PATH does not run (reinstall: npm install -g @openai/codex@latest); config is still written' }); }
  } else out.push({ level: 'info', msg: `codex not found at ${CODEX_HOME}` });

  // pi
  out.push(...pi.checks(root, { ...user.servers, ...(proj.hasMcp ? proj.servers : {}) }));
}
