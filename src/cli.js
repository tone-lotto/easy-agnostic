import { createRequire } from 'node:module';
import { c } from './util.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `eag — Easy Agnostic: one source, many agents (MCP sync for Claude Code, Codex and Pi)

Usage: eag <command> [options]

  setup [--project] [--no-projects]     detect, import and sync everything in one shot: init + adopt (claude, codex)
                                        + apply + make every project agnostic + hook install + doctor --fix. Safe to
                                        run again any time. --project scopes it to the current repo instead of the
                                        whole machine; --no-projects leaves per-project Claude servers where they are.
  init [--project]                      create the source files and detect installed agents
  adopt <claude|codex> [--scope user|project] [--dry-run] [--force]
                                        import what an agent has today into the source
  adopt claude --all-projects [--dry-run] [--keep-local]
                                        make every project agnostic: Claude keeps per-project servers to itself in
                                        ~/.claude.json, so this moves each one into that repo's own .mcp.json, which
                                        Claude and Pi read natively and Codex gets through .codex/config.toml
  status [--scope user|project|all] [--exit-code] [--quiet]
                                        show drift between source, last apply and each agent
  apply [--scope user|project|all] [--target claude,codex] [--dry-run] [--prefer source|native] [--quiet]
                                        write the source into each agent (3-way merge, never clobbers)
  hook install | status | uninstall [--dry-run]
                                        sync on launch: a generated ~/.agents/shell-init.sh, sourced from your
                                        shell rc, exports the \${NAME} values and syncs each agent just before
                                        it starts. Covers terminal launches; an agent opened from a desktop app
                                        or an IDE does not read your rc and syncs on the next terminal launch.
  mcp ls | add <name> ... | rm <name> | target <name> <agent> on|off
                                        edit the source without opening an editor
  secret set <NAME> [--value V | --from-env] | ls | rm <NAME>
                                        values for \${NAME} references, kept in the OS secret store; with no flag the
                                        value is read from stdin (pipe) or prompted. --value lands in shell history.
  env                                   print "export NAME=..." lines for every referenced secret
  doctor [--fix]                        wiring checks: skills symlinks, @AGENTS.md, Codex trust, Pi adapter, secrets
  --version                             print the version

Environment: EAG_HOME (default ~/.agents), CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR, EAG_PROJECT,
             EAG_SECRET_SERVICE, EAG_SECRET_BACKEND=keychain|secret-tool|file, EAG_DEBUG (print stack traces).`;

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) push(flags, k, v);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !BOOL.has(k)) push(flags, k, argv[++i]);
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
const BOOL = new Set(['dry-run', 'exit-code', 'fix', 'force', 'project', 'help', 'version', 'quiet', 'from-env', 'all-projects', 'keep-local', 'no-projects']);
function push(flags, k, v) { if (flags[k] === undefined) flags[k] = v; else flags[k] = [].concat(flags[k], v); }

// Unknown flags used to be parsed and then ignored, so `--dryrun` wrote for real and
// exited 0. Every flag a command honours is listed here; anything else is an error.
const GLOBAL_FLAGS = ['help', 'version'];
const COMMAND_FLAGS = {
  setup: ['project', 'no-projects'],
  init: ['project'],
  adopt: ['scope', 'dry-run', 'force', 'all-projects', 'keep-local'],
  status: ['scope', 'exit-code', 'quiet'],
  apply: ['scope', 'target', 'dry-run', 'prefer', 'quiet'],
  hook: ['dry-run'],
  mcp: ['scope', 'url', 'header', 'command', 'args', 'env', 'cwd', 'type', 'force'],
  secret: ['value', 'from-env'],
  env: [],
  doctor: ['fix'],
};

export async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (flags.version || cmd === '-v') { console.log(version); return 0; }
  if (!cmd || cmd === 'help' || cmd === '-h' || flags.help) { console.log(HELP); return 0; }
  const mod = {
    setup: () => import('./commands/setup.js'),
    init: () => import('./commands/init.js'),
    adopt: () => import('./commands/adopt.js'),
    status: () => import('./commands/status.js'),
    apply: () => import('./commands/apply.js'),
    hook: () => import('./commands/hook.js'),
    mcp: () => import('./commands/mcp.js'),
    secret: () => import('./commands/secret.js'),
    env: () => import('./commands/env.js'),
    doctor: () => import('./commands/doctor.js'),
  }[cmd];
  if (!mod) { console.error(`${c.bad('unknown command')} ${cmd}\n\n${HELP}`); return 1; }
  const allowed = new Set([...GLOBAL_FLAGS, ...COMMAND_FLAGS[cmd]]);
  const unknown = Object.keys(flags).filter((f) => !allowed.has(f));
  if (unknown.length) {
    const accepted = COMMAND_FLAGS[cmd].map((f) => `--${f}`).join(' ') || '(none)';
    console.error(`${c.bad('unknown option')} ${unknown.map((f) => `--${f}`).join(' ')} for "${cmd}"\n${c.dim(`accepted: ${accepted}`)}`);
    return 1;
  }
  const { run } = await mod();
  return (await run(rest, flags)) ?? 0;
}
