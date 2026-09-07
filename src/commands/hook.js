import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME } from '../paths.js';
import { exists, c } from '../util.js';
import * as shell from '../shell.js';
import * as hooks from '../hooks.js';
import * as claude from '../adapters/claude.js';
import { CODEX_HOME } from '../paths.js';

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
  const initCurrent = initThere && fs.readFileSync(shell.INIT_FILE, 'utf8') === shell.render(bins);
  const cl = hooks.claudeState();
  const cx = hooks.codexState();
  const launcherCurrent = exists(hooks.LAUNCHER) && fs.readFileSync(hooks.LAUNCHER, 'utf8') === hooks.renderLauncher();

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
      const w = shell.writeInit(bins, { dryRun: dry });
      console.log(w.changed
        ? `${c.ok(w.created ? 'created' : 'updated')} ${w.file}${bins.length ? c.dim(` (wraps ${bins.join(', ')})`) : ''}`
        : `${c.dim('current')} ${w.file}`);
      const r = shell.installRc({ dryRun: dry, backupDir: backupDir() });
      if (r.changed) {
        console.log(`${c.ok(r.created ? 'created' : 'updated')} ${r.rc}`);
        if (r.replacedLegacy) console.log(c.dim('        replaced the bare eval "$(eag env)" line; the generated file does that now'));
      } else console.log(`${c.dim('current')} ${r.rc}`);
    }

    // 2. app and IDE launches: a POSIX launcher the agent's own hook engine can run
    const l = hooks.writeLauncher({ dryRun: dry });
    console.log(l.changed ? `${c.ok(l.created ? 'created' : 'updated')} ${l.file}` : `${c.dim('current')} ${l.file}`);
    if (claude.available() || hooks.claudeState().exists) {
      const h = hooks.installClaude({ dryRun: dry, backupDir: backupDir() });
      console.log(h.changed ? `${c.ok(h.created ? 'created' : 'updated')} ${h.file} ${c.dim('(SessionStart)')}` : `${c.dim('current')} ${h.file} ${c.dim('(SessionStart)')}`);
    } else console.log(`${c.dim('skipped')} Claude Code is not installed`);
    if (exists(CODEX_HOME)) {
      const h = hooks.installCodex({ dryRun: dry, backupDir: backupDir() });
      console.log(h.changed ? `${c.ok(h.created ? 'created' : 'updated')} ${h.file} ${c.dim('(SessionStart)')}` : `${c.dim('current')} ${h.file} ${c.dim('(SessionStart)')}`);
    } else console.log(`${c.dim('skipped')} Codex is not installed`);

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
