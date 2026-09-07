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
const BOOL = new Set(['dry-run', 'exit-code', 'fix', 'force', 'project', 'help', 'version', 'quiet', 'from-env', 'all-projects', 'keep-local', 'no-projects', 'json']);
function push(flags, k, v) { if (flags[k] === undefined) flags[k] = v; else flags[k] = [].concat(flags[k], v); }

// Unknown flags used to be parsed and then ignored, so `--dryrun` wrote for real and
// exited 0. Every flag a command honours is listed here; anything else is an error.
const GLOBAL_FLAGS = ['help', 'version'];
const COMMAND_FLAGS = {
  setup: ['project', 'no-projects'],
  init: ['project'],
  adopt: ['scope', 'dry-run', 'force', 'all-projects', 'keep-local'],
  status: ['scope', 'exit-code', 'quiet', 'json'],
  apply: ['scope', 'target', 'dry-run', 'prefer', 'quiet', 'json'],
  hook: ['dry-run'],
  mcp: ['scope', 'url', 'header', 'command', 'args', 'arg', 'env', 'cwd', 'type', 'force', 'json'],
  secret: ['value', 'from-env'],
  env: [],
  doctor: ['fix', 'json'],
};

// `eag <cmd> --help` used to print the global help, so a flag not in the summary line was
// undiscoverable except by provoking an error. One usage block per command, with every
// flag, its value format, and the exit codes.
const EXIT = 'Exit codes: 0 nothing to do or done · 1 error · 2 drift (something to apply) · 3 conflict (a native edit eag refuses to overwrite)';
const USAGE = {
  setup: `eag setup [--project] [--no-projects]
  init + adopt claude + adopt codex + apply + make every project agnostic + hook install + doctor --fix, in one run.
  Safe to repeat. --project scopes it to the current repo; --no-projects leaves per-project Claude servers alone.`,
  init: `eag init [--project]
  Create the source files (~/.agents/mcp.json + agents.json, or ./.mcp.json) and detect installed agents.`,
  adopt: `eag adopt <claude|codex> [--scope user|project] [--dry-run] [--force]
eag adopt claude --all-projects [--dry-run] [--keep-local]
  Import what an agent has today into the source. Literal credentials are moved to the secret store and
  replaced with \${NAME}. An entry already in the source with different content is kept (--force replaces it).
  --all-projects moves every per-project Claude server into that repo's own .mcp.json so Codex and Pi see it
  too; --keep-local leaves the original copy in ~/.claude.json.`,
  status: `eag status [--scope user|project|all] [--exit-code] [--quiet] [--json]
  Drift between the source, the last apply and each agent. --quiet hides in-sync and foreign entries.
  --exit-code makes the exit status meaningful for scripts. --json prints one object per target.
  ${EXIT}`,
  apply: `eag apply [--scope user|project|all] [--target claude,codex] [--dry-run] [--prefer source|native] [--quiet] [--json]
  Write the source into each agent through a 3-way merge. A native edit since the last apply is a conflict:
  nothing is written for that entry until you choose.
    --prefer source   the source wins; the native edit is overwritten
    --prefer native   the native edit wins and is written back INTO THE SOURCE, so it stays
  --dry-run shows the plan with \${NAME} references, never resolved values. --quiet is for the launch
  wrappers: silent when there is nothing to say, a problem printed once until it changes. --json for scripts.
  ${EXIT}`,
  hook: `eag hook install | status | uninstall [--dry-run]
  Sync on launch. Terminal: ~/.agents/shell-init.sh sourced from your rc, wrapping each agent binary.
  App/IDE: a SessionStart hook in ~/.claude/settings.json and ~/.codex/hooks.json (Codex asks you to approve
  it once, in /hooks or Settings > Hooks). Also links eag's own skill into ~/.agents/skills so agents know it.`,
  mcp: `eag mcp ls [--json]
eag mcp add <name> --url <URL> [--type http|sse] [--header "K: V"]... [--scope user|project] [--force]
eag mcp add <name> --command <BIN> [--arg <A>]... [--args a,b,c] [--env K=V]... [--cwd <DIR>] [--scope ...] [--force]
eag mcp rm <name> [--scope user|project]
eag mcp target <name> <claude|codex|pi> on|off [--scope user|project]
  Edit the source without an editor. Put secrets in as \${NAME} and store the value with eag secret set.
  --arg is repeatable and takes one argument each; --args is a single comma-separated list.
  Then run eag apply.`,
  secret: `eag secret set <NAME> [--value V | --from-env]
eag secret ls | rm <NAME>
  Values for \${NAME} references, kept in the OS secret store (macOS keychain, secret-tool, or a 0600 file).
  With no flag the value is read from stdin when piped, or prompted without echo. --value lands in shell history.`,
  env: `eag env
  Print export lines for every referenced secret. Meant for eval "$(eag env)"; the generated shell-init.sh does it.`,
  doctor: `eag doctor [--fix] [--json]
  Wiring checks: skills symlinks, @AGENTS.md, Codex trust, Pi adapter, hook trust, secrets that are set but not
  exported, projects only Claude can see, literal credentials in the source. --fix repairs symlinks, dedupes
  identical skill copies and prepends @AGENTS.md. Exit 1 when there is a problem, 0 otherwise.`,
};

export async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (flags.version || cmd === '-v') { console.log(version); return 0; }
  if (!cmd || cmd === 'help' || cmd === '-h') { console.log(HELP); return 0; }
  if (flags.help) { console.log(USAGE[cmd] ? `${USAGE[cmd]}\n` : HELP); return 0; }
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
