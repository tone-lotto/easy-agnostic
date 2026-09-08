import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME } from '../paths.js';
import { exists, writeFileAtomic, c } from '../util.js';
import * as shell from '../shell.js';
import * as hooks from '../hooks.js';
import * as claude from '../adapters/claude.js';
import { CODEX_HOME } from '../paths.js';
import { fileURLToPath } from 'node:url';
import { globalBinDir } from '../update.js';

// eag ships its own skill. Copied into ~/.agents/skills it reaches every agent: Codex reads
// that directory itself, doctor links it into ~/.claude/skills. That is how an agent that was
// never told eag exists learns the commands, the exit codes and the secret model.
//
// A copy, not a link into the package: the package path changes on upgrade and vanishes on
// uninstall, and a dangling skill is worse than none. The copy is refreshed whenever the
// shipped file differs, so it tracks the installed version. A directory here that eag did
// not write (no marker file) is someone's own skill named eag and is left alone.
const SKILL_SRC = fileURLToPath(new URL('../../skills/eag', import.meta.url));
const SKILL_DST = path.join(EAG_HOME, 'skills', 'eag');
const SKILL_MARK = path.join(SKILL_DST, '.eag-managed');
export function installSkill({ dryRun = false } = {}) {
  const src = path.join(SKILL_SRC, 'SKILL.md');
  if (!exists(src)) return { changed: false, missing: true };
  const want = fs.readFileSync(src, 'utf8');
  let st = null; try { st = fs.lstatSync(SKILL_DST); } catch { /* absent */ }
  if (st?.isSymbolicLink()) { if (!dryRun) fs.unlinkSync(SKILL_DST); st = null; } // an older eag linked it
  if (st && !exists(SKILL_MARK)) return { changed: false, shadowed: true };
  const cur = exists(path.join(SKILL_DST, 'SKILL.md')) ? fs.readFileSync(path.join(SKILL_DST, 'SKILL.md'), 'utf8') : null;
  if (cur === want) return { changed: false };
  if (!dryRun) {
    fs.mkdirSync(SKILL_DST, { recursive: true });
    writeFileAtomic(path.join(SKILL_DST, 'SKILL.md'), want);
    fs.writeFileSync(SKILL_MARK, 'written by eag hook install; edits here are overwritten on the next refresh\n');
  }
  return { changed: true, created: cur === null };
}

// Codex silently skips a hook it has not been told to trust, so the state has to be shown.
async function codexTrustLine(indent = '  ') {
  const t = await hooks.codexTrust();
  if (!t) return `${indent}${c.dim('·')} Codex trust: unknown (could not ask codex app-server)`;
  if (t.status === 'trusted' && t.enabled !== false) return `${indent}${c.ok('✓')} Codex trust: approved`;
  const why = t.status === 'modified' ? 'the hook changed since you approved it' : t.enabled === false ? 'it is switched off' : 'it has never been approved';
  return `${indent}${c.warn('!')} Codex trust: ${t.status}${t.enabled === false ? ' (disabled)' : ''} — ${why}. Open Codex and run ${c.bold('/hooks')} to approve it; until then it will not run, silently.`;
}

const backupDir = () => path.join(EAG_HOME, '.state', 'backup');
const GUI_NOTE = 'The shell covers what you start from a terminal; the session hook covers what you\nstart from a desktop app or an IDE. Together they are every launch path there is.';

async function status() {
  const st = shell.rcState();
  const bins = shell.wrappableBins();
  const initThere = exists(shell.INIT_FILE);
  const initCurrent = initThere && fs.readFileSync(shell.INIT_FILE, 'utf8') === shell.render(bins, { binDir: globalBinDir() });
  const cl = hooks.claudeState();
  const cx = hooks.codexState();
  const launcherCurrent = exists(hooks.LAUNCHER) && fs.readFileSync(hooks.LAUNCHER, 'utf8') === hooks.renderLauncher({ binDir: globalBinDir() });

  console.log(c.bold('terminal launches'));
  console.log(`  ${initThere && initCurrent ? c.ok('✓') : c.warn('!')} ${shell.INIT_FILE}${initThere ? (initCurrent ? '' : c.warn(' (out of date)')) : c.dim(' (not generated)')}`);
  console.log(`  ${st.linked ? c.ok('✓') : c.warn('!')} ${st.rc}${st.linked ? ' sources it' : c.dim(' does not source it')}`);
  console.log(`  ${bins.length ? c.ok('✓') : c.dim('·')} wrapped: ${bins.join(', ') || '(no agent binary on PATH)'}`);

  console.log(c.bold('\napp and IDE launches'));
  console.log(`  ${launcherCurrent ? c.ok('✓') : c.warn('!')} ${hooks.LAUNCHER}${launcherCurrent ? '' : c.dim(exists(hooks.LAUNCHER) ? ' (out of date)' : ' (not generated)')}`);
  console.log(`  ${cl.current ? c.ok('✓') : c.warn('!')} Claude Code SessionStart in ${cl.file}${cl.installed && !cl.current ? c.warn(' (out of date)') : cl.installed ? '' : c.dim(' (not installed)')}`);
  console.log(`  ${cx.current ? c.ok('✓') : c.warn('!')} Codex SessionStart in ${cx.file}${cx.installed && !cx.current ? c.warn(' (out of date)') : cx.installed ? '' : c.dim(' (not installed)')}`);
  if (cx.installed) console.log(await codexTrustLine());

  console.log(c.dim(`\n${GUI_NOTE}`));
  const ok = initThere && initCurrent && st.linked && launcherCurrent && cl.current && cx.current;
  if (!ok) console.log(`\nRun ${c.bold('eag hook install')}.`);
  return ok ? 0 : 2;
}

export async function run(args, flags) {
  const sub = args[0] || 'status';
  const dry = !!flags['dry-run'];

  if (sub === 'status') return status();

  if (sub === 'install') {
    // 1. terminal launches: the generated file plus one line in the rc
    if (shell.isFish()) {
      console.log(`${c.warn('skipped')} ${shell.rcPath()} is fish; the generated file is POSIX shell. The session hook below still works.`);
    } else {
      const bins = shell.wrappableBins();
      const w = shell.writeInit(bins, { dryRun: dry, binDir: globalBinDir() });
      console.log(w.changed
        ? `${c.ok(w.created ? 'created' : 'updated')} ${w.file}${bins.length ? c.dim(` (wraps ${bins.join(', ')})`) : ''}`
        : `${c.dim('current')} ${w.file}`);
      const r = shell.installRc({ dryRun: dry, backupDir: backupDir() });
      if (r.changed) {
        console.log(`${c.ok(r.created ? 'created' : 'updated')} ${r.rc}`);
        if (r.replacedLegacy) console.log(c.dim('        removed the shell-wide secret export; restart your terminal to clear old inherited credentials'));
      } else console.log(`${c.dim('current')} ${r.rc}`);
    }

    // 2. app and IDE launches: a POSIX launcher the agent's own hook engine can run
    const l = hooks.writeLauncher({ dryRun: dry, binDir: globalBinDir() });
    console.log(l.changed ? `${c.ok(l.created ? 'created' : 'updated')} ${l.file}` : `${c.dim('current')} ${l.file}`);
    if (claude.available() || hooks.claudeState().exists) {
      const h = hooks.installClaude({ dryRun: dry, backupDir: backupDir() });
      console.log(h.changed ? `${c.ok(h.created ? 'created' : 'updated')} ${h.file} ${c.dim('(SessionStart)')}` : `${c.dim('current')} ${h.file} ${c.dim('(SessionStart)')}`);
    } else console.log(`${c.dim('skipped')} Claude Code is not installed`);
    if (exists(CODEX_HOME)) {
      const h = hooks.installCodex({ dryRun: dry, backupDir: backupDir() });
      console.log(h.changed ? `${c.ok(h.created ? 'created' : 'updated')} ${h.file} ${c.dim('(SessionStart)')}` : `${c.dim('current')} ${h.file} ${c.dim('(SessionStart)')}`);
    } else console.log(`${c.dim('skipped')} Codex is not installed`);

    // 3. the skill that teaches agents to drive eag
    const sk = installSkill({ dryRun: dry });
    if (sk.missing) console.log(`${c.dim('skipped')} eag skill not found next to the package`);
    else if (sk.shadowed) console.log(`${c.dim('kept   ')} ${SKILL_DST} is your own directory; eag's skill not linked`);
    else console.log(sk.changed ? `${c.ok(sk.created ? 'created' : 'updated')} ${SKILL_DST} ${c.dim('(eag skill, so every agent knows the commands)')}` : `${c.dim('current')} ${SKILL_DST} ${c.dim('(eag skill)')}`);

    if (dry) { console.log(`\n${c.dim('dry run: nothing written')}`); return 0; }
    // Codex will not run a hook until it is approved, and says nothing when it skips one.
    if (hooks.codexState().installed) console.log(await codexTrustLine(''));
    console.log(`\nOpen a new terminal, or run: ${c.bold(`. ${shell.INIT_FILE}`)}`);
    console.log(c.dim('An agent that is already open picks this up the next time you start it.'));
    return 0;
  }

  if (sub === 'uninstall') {
    const r = shell.uninstallRc({ dryRun: dry, backupDir: backupDir() });
    console.log(r.changed ? `${c.ok('updated')} ${r.rc}` : `${c.dim('nothing to remove in')} ${r.rc}`);
    for (const f of [shell.INIT_FILE, hooks.LAUNCHER]) {
      if (!exists(f)) continue;
      if (!dry) fs.rmSync(f, { force: true });
      console.log(`${c.ok('removed')} ${f}`);
    }
    if (exists(SKILL_MARK)) { if (!dry) fs.rmSync(SKILL_DST, { recursive: true, force: true }); console.log(`${c.ok('removed')} ${SKILL_DST}`); }
    for (const un of [hooks.uninstallClaude, hooks.uninstallCodex]) {
      const h = un({ dryRun: dry, backupDir: backupDir() });
      console.log(h.changed ? `${c.ok('updated')} ${h.file} ${c.dim('(SessionStart entry removed)')}` : `${c.dim('nothing to remove in')} ${h.file}`);
    }
    if (dry) console.log(`\n${c.dim('dry run: nothing written')}`);
    else console.log(c.dim('\nShells that are already open keep the wrappers until you restart them.'));
    return 0;
  }

  throw new Error(`unknown subcommand: hook ${sub} (expected install, uninstall or status)`);
}
