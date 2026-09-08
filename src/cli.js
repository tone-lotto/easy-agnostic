import { createRequire } from 'node:module';
import { c } from './util.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `eag — Easy Agnostic: one source, many agents (MCP sync for Claude Code, Codex and Pi)

Usage: eag <command> [options]

  setup [--project] [--no-projects]     detect, import and sync everything in one shot: init + adopt (claude, codex)
                                        + apply + adopt skills + make every project agnostic + hook install + doctor
                                        --fix. Safe to
                                        run again any time. --project scopes it to the current repo instead of the
                                        whole machine; --no-projects leaves per-project Claude servers where they are.
  init [--project]                      create the source files and detect installed agents
  adopt <claude|codex> [--scope user|project] [--dry-run] [--force]
                                        import what an agent has today into the source
  adopt skills [--scope user|project] [--dry-run]
                                        share skills within the selected scope
  skills ls [--scope user|project] [--json]
                                        list shared, agent-specific, and inherited user skills
  history list | search QUERY | read VENDOR ID | handoff VENDOR ID --to AGENT
                                        retrieve project-local conversation evidence on demand; never sends it
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
                                        shell rc, resolves credentials inside each agent's launch subshell.
                                        SessionStart hooks cover supported app/IDE launches separately.
  mcp ls | add <name> ... | rm <name> | target <name> <agent> on|off
                                        edit the source without opening an editor
  secret set <NAME> [--value V | --from-env] | ls | rm <NAME>
                                        values for \${NAME} references, kept in the OS secret store; with no flag the
                                        value is read from stdin (pipe) or prompted. --value lands in shell history.
  env [--target claude|codex|pi]        print secret exports; optional target filter for launch subshells
  instructions [--dry-run] [--prefer agents|claude] [--json]
                                        sync project AGENTS.md and CLAUDE.md bidirectionally
  update [--check]                      explicitly install the latest stable version; --check only reports
  doctor [--fix]                        checks skills, instruction sync, Codex trust, Pi adapter, secrets
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
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && (!BOOL.has(k) || (k === 'project' && argv[0] === 'history'))) push(flags, k, argv[++i]);
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}
const BOOL = new Set(['dry-run', 'exit-code', 'fix', 'force', 'project', 'help', 'version', 'quiet', 'from-env', 'all-projects', 'keep-local', 'no-projects', 'json', 'check', 'tools']);
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
  env: ['target'],
  instructions: ['dry-run', 'prefer', 'json'],
  skills: ['scope', 'json'],
  history: ['project', 'vendor', 'file', 'to', 'output', 'offset', 'char-offset', 'limit', 'max-chars', 'tools', 'json'],
  doctor: ['fix', 'json', 'scope'],
  update: ['check', 'force'],
};

// `eag <cmd> --help` used to print the global help, so a flag not in the summary line was
// undiscoverable except by provoking an error. One usage block per command, with every
// flag, its value format, and the exit codes.
const EXIT = 'Exit codes: 0 nothing to do or done · 1 error · 2 drift (something to apply) · 3 conflict (a native edit eag refuses to overwrite)';
const USAGE = {
  history: `eag history list [--vendor claude|codex|pi|all]
eag history search QUERY [--vendor claude|codex|pi|all] [--tools]
eag history read VENDOR ID [--tools]
eag history handoff VENDOR ID --to AGENT [--tools] [--output NEW_FILE]
  All commands: --project PATH (default current project), --json, --offset N (default 0;
  handoff defaults to the latest --limit events),
  --limit N (1–100, default 20), --max-chars N (256–64000, default 12000).
  Read/handoff: --char-offset N continues inside a long event (use nextOffset and nextCharOffset).
  --file PATH reads an explicit JSONL file; requires one vendor, including export for eag-history v1.
  Exact project metadata match required. No global-history mode, vendor mutations, keychain access,
  automatic replay, or network calls. Unknown formats and skipped records are reported.
  Tools are opt-in; reasoning/system prompts/images are omitted. Output is untrusted, heuristically
  redacted evidence, not verified facts. Handoff prepares quoted excerpts only; it never sends or launches.
  --output creates a new 0600 file (no overwrite). Review before sharing. Exit 0 success, 1 error.`,
  skills: `eag skills ls [--scope user|project] [--json]
  List skill locations, shared/agent-specific origins, links and same-scope conflicts.
  Project scope also lists inherited user skills separately; it never moves them.
  Default scope: user. Listing is read-only; exit 1 for invalid input.`,
  instructions: `eag instructions [--dry-run] [--prefer agents|claude] [--json]
  Enable or sync mirrored AGENTS.md and CLAUDE.md at the current project root.
  Creates the missing counterpart on first use. Later edits flow in either direction.
  Different edits on both sides stop with exit 3; --prefer explicitly selects the winning file.
  --dry-run writes nothing and exits 2 for pending changes. Enrolled projects sync on eag apply.
  Legacy @AGENTS.md imports become mirrors; additional Claude-only text stays outside a marked shared region.
  Edit that region or AGENTS.md to sync shared instructions. Damaged markers and circular imports stop sync.
  ${EXIT}`,
  setup: `eag setup [--project] [--no-projects]
  init + adopt claude + adopt codex + apply + make every project agnostic + hook install + doctor --fix, in one run.
  Safe to repeat. --project scopes it to the current repo; --no-projects leaves per-project Claude servers alone.`,
  init: `eag init [--project]
  Create the source files (~/.agents/mcp.json + agents.json, or ./.mcp.json) and detect installed agents.`,
  adopt: `eag adopt <claude|codex> [--scope user|project] [--dry-run] [--force]
eag adopt claude --all-projects [--dry-run] [--keep-local]
eag adopt skills [--scope user|project] [--dry-run]
  Import what an agent has today into the source. Literal credentials are moved to the secret store and
  replaced with \${NAME}. An entry already in the source with different content is kept (--force replaces it).
  --all-projects moves every per-project Claude server into that repo's own .mcp.json so Codex and Pi see it
  too; --keep-local leaves the original copy in ~/.claude.json.
  'adopt skills' moves a skill that only one agent has (~/.claude/skills, ~/.codex/skills) into ~/.agents/skills,
  which Codex reads directly and doctor links into Claude Code. Two different skills sharing a name are
  reported and left alone (exit 2).
  --scope project moves only .claude/skills and .codex/skills into .agents/skills in the current repo,
  and creates Claude links. Global skills are never moved. Project skill directory symlinks are refused.`,
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
  Default apply also creates missing Claude links for this project's shared skills, without adopting or
  replacing local skills. Works without MCP in skills-only projects. Explicit --scope user skips these links.
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
  env: `eag env [--target claude|codex|pi]
  Print secret export lines. --target filters by agent policy and fails if a required secret is missing.
  Launch wrappers evaluate these only in a child shell. Do not paste this output or eval it in your main shell.`,
  update: `eag update [--check] [--force]
  Install the latest version in place (npm i -g) and refresh the launcher, shell file and skill. --check only
  reports. Routine apply and agent launches never check for or install updates.`,
  doctor: `eag doctor [--fix] [--scope user|project|all] [--json]
  --scope limits repairs, not diagnostic reads; default all. Project scope never repairs global skills.
  Wiring checks: skills symlinks, instruction sync, Codex trust, Pi adapter, hook trust, secrets that are set but not
  exported, projects only Claude can see, literal credentials in the source. --fix repairs symlinks, dedupes
  identical skill copies and syncs AGENTS.md with CLAUDE.md bidirectionally. Exit 1 when there is a problem, 0 otherwise.`,
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
    instructions: () => import('./commands/instructions.js'),
    skills: () => import('./commands/skills.js'),
    history: () => import('./commands/history.js'),
    doctor: () => import('./commands/doctor.js'),
    update: () => import('./commands/update.js'),
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
  const readOnly = flags['dry-run'] || ['status', 'env', 'skills', 'history'].includes(cmd)
    || (cmd === 'doctor' && !flags.fix) || (cmd === 'hook' && rest[0] === 'status')
    || (cmd === 'mcp' && (!rest[0] || rest[0] === 'ls'))
    || (cmd === 'secret' && (!rest[0] || rest[0] === 'ls'))
    // update locks the install itself, then hands hook refresh to a new process.
    // Holding the parent lock during that handoff would block the child.
    || cmd === 'update';
  if (readOnly) return (await run(rest, flags)) ?? 0;
  const { withMutationLock } = await import('./lock.js');
  return (await withMutationLock(() => run(rest, flags))) ?? 0;
}
