import fs from 'node:fs';
import path from 'node:path';
import { EAG_HOME } from '../paths.js';
import { exists, c } from '../util.js';
import * as shell from '../shell.js';

const backupDir = () => path.join(EAG_HOME, '.state', 'backup');

function status() {
  const st = shell.rcState();
  const bins = shell.wrappableBins();
  const initThere = exists(shell.INIT_FILE);
  const current = initThere && fs.readFileSync(shell.INIT_FILE, 'utf8') === shell.render(bins);
  console.log(`${initThere ? c.ok('✓') : c.warn('!')} ${shell.INIT_FILE}${initThere ? (current ? '' : c.warn(' (out of date; eag hook install refreshes it)')) : c.dim(' (not generated yet)')}`);
  console.log(`${st.linked ? c.ok('✓') : c.warn('!')} ${st.rc}${st.linked ? ' sources it' : c.dim(' does not source it')}`);
  console.log(`${bins.length ? c.ok('✓') : c.dim('·')} wrapped on start: ${bins.join(', ') || '(no agent binary on PATH)'}`);
  const missing = [...new Set(Object.values(shell.AGENT_BINS))].filter((b) => !bins.includes(b));
  if (missing.length) console.log(`${c.dim('·')} not installed, so not wrapped: ${missing.join(', ')}`);
  console.log(c.dim('\nOnly terminal launches go through the shell. An agent started from a desktop app\nor an IDE does not read your shell rc, so it syncs on the next terminal launch.'));
  return st.linked && initThere && current ? 0 : 2;
}

export async function run(args, flags) {
  const sub = args[0] || 'status';
  const dry = !!flags['dry-run'];

  if (sub === 'status') return status();

  if (sub === 'install') {
    if (shell.isFish()) {
      throw new Error(`fish is not supported yet (${shell.rcPath()}): the generated file is POSIX shell.\nUse bash or zsh, or add the equivalent to your config.fish by hand and run: eag hook status`);
    }
    const bins = shell.wrappableBins();
    const w = shell.writeInit(bins, { dryRun: dry });
    console.log(w.changed
      ? `${c.ok(w.created ? 'created' : 'updated')} ${w.file}${bins.length ? c.dim(` (wraps ${bins.join(', ')})`) : ''}`
      : `${c.dim('current')} ${w.file}`);
    const r = shell.installRc({ dryRun: dry, backupDir: backupDir() });
    if (r.changed) {
      console.log(`${c.ok(r.created ? 'created' : 'updated')} ${r.rc}`);
      if (r.replacedLegacy) console.log(`${c.dim('        replaced the bare eval "$(eag env)" line; the generated file does that now')}`);
    } else console.log(`${c.dim('current')} ${r.rc}`);
    if (dry) { console.log(`\n${c.dim('dry run: nothing written')}`); return 0; }
    if (!bins.length) console.log(`${c.warn('note   ')} no agent binary on PATH yet; install one and run this again`);
    console.log(`\nOpen a new terminal, or run: ${c.bold(`. ${shell.INIT_FILE}`)}`);
    return 0;
  }

  if (sub === 'uninstall') {
    const r = shell.uninstallRc({ dryRun: dry, backupDir: backupDir() });
    console.log(r.changed ? `${c.ok('updated')} ${r.rc}` : `${c.dim('nothing to remove in')} ${r.rc}`);
    if (exists(shell.INIT_FILE)) {
      if (!dry) fs.rmSync(shell.INIT_FILE, { force: true });
      console.log(`${c.ok('removed')} ${shell.INIT_FILE}`);
    }
    if (dry) console.log(`\n${c.dim('dry run: nothing written')}`);
    else console.log(c.dim('\nThe wrappers stay defined in shells that are already open until you restart them.'));
    return 0;
  }

  throw new Error(`unknown subcommand: hook ${sub} (expected install, uninstall or status)`);
}
