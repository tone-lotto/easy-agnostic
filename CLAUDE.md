# CLAUDE.md

Guidance for Claude Code when working in this repository. Personal notes for the maintainer (tracker ids, private design documents, language preferences) live in `CLAUDE.local.md`, which is gitignored; keep them there, never in this file.

## Project

**Easy Agnostic** (`eag`) — one source, many agents. A CLI that keeps MCP servers in sync across Claude Code, Codex and Pi from a single source, never clobbers hand edits, and keeps secrets out of versioned files. It also keeps the non-MCP wiring healthy (skills symlinks for Claude Code, `@AGENTS.md` in CLAUDE.md) but does not manage skill or instruction content: those are already solved by convention (`.agents/skills`, AGENTS.md).

Status: v0 spike, open source (MIT), tested end to end in a sandbox. The principles, targets table and roadmap below are the design record; read them before changing architecture.

## Language

- Code, comments, README, CLI output, task titles and descriptions: **English**.
- Conversation: whatever language the person you are talking to uses.

## Five principles (do not break these)

1. **The source is a native file, not a new format.** `~/.agents/mcp.json` (user) and `./.mcp.json` (project) use the `mcpServers` shape that Claude Code, Pi, Cursor and the Agent Plugins spec already read. Tool-specific decisions go in `agents.json`, never into `mcp.json`.
2. **MCP is the core.** Skills and instructions are only wired (symlinks, `@AGENTS.md`), never copied or translated. Hooks, subagents and permissions are out of scope until phase 3.
3. **Never clobber.** Every write goes through the 3-way merge in `src/merge.js` (desired vs last-apply snapshot vs native). Entries the tool never wrote are untouched. A native edit since the last apply is a conflict: stop and show it. Only `--prefer source|native` resolves conflicts, explicitly.
4. **Secrets by reference.** `mcp.json` only holds `${NAME}`; values live in the OS keychain (`src/secrets.js`). Adapters translate to whatever the agent supports (Codex `bearer_token_env_var`/`env_vars`; Claude Code gets resolved values by default because it expands `${VAR}` from its own process environment and a GUI-launched agent on macOS has the launchd environment, not the shell rc — `claude.secrets = "env"` in `agents.json` is the opt-in for terminal-only users, and Pi always expands from the environment it inherits). `eag doctor` flags literal credentials by shape (a heuristic: common token prefixes, JWTs, long opaque strings, `user:password@` URLs), scanning headers, env and the URL but not `args`. Files eag writes that can carry literal values are private: state snapshots and their backups under `.state/`, `.secrets.index` and the `.secrets.env` fallback are created `0600`; a Codex `config.toml` eag creates starts `0600`, as does one whose managed block carries a credential; `render()` marks the tables where it resolved a `${NAME}` (the `HAS_LITERAL` symbol), so that decision is exact rather than a guess at the value's shape. Otherwise a rewrite restores the file's own mode exactly, and follows a symlink instead of replacing it, so a config kept in a dotfiles repo keeps receiving writes. Modes are only ever tightened. Anything shown to a human (`apply --dry-run`) prints `${NAME}` references, never resolved values.
5. **Never leave an agent unable to start.** Codex TOML is parsed before the file is replaced; writes are atomic (temp + rename); previous file backed up under `.state/backup/`. `~/.claude.json` is never edited directly, only through the `claude mcp` CLI.

Also: no daemon, no file watcher, no GUI, no cross-machine sync (dotfiles/git do that).

## Layout

```
bin/eag.js              entry point
src/cli.js              arg parsing, help, command dispatch
src/paths.js            all paths; honours EAG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR, EAG_PROJECT
src/source.js           load/save mcp.json + agents.json, validation, per-server policy helpers
src/secrets.js          keychain (macOS `security`), secret-tool (Linux), .secrets.env fallback
src/state.js            last-apply snapshot per target (.state/<target>.json)
src/projects.js         Claude's per-project "local" servers: discovery and skip reasons for adopt --all-projects
src/skills.js           skills that only one agent has: plan (adopt/duplicate/collision) and the move into ~/.agents/skills
src/shell.js            generated ~/.agents/shell-init.sh + rc wiring (terminal launches)
src/hooks.js            ~/.agents/bin/eag-sync launcher + the agents' own session hooks (app/IDE launches)
src/merge.js            the 3-way merge; pure function, no I/O
src/plan.js             builds a plan per target, applies it; TARGETS registry
src/adapters/codex.js   read/render/write managed block in config.toml; toSource for adopt
src/adapters/claude.js  read ~/.claude.json, write via `claude mcp add-json|remove`
src/adapters/pi.js      read-only checks (pi-mcp-adapter reads the source directly)
src/commands/*.js       setup (init+adopt+apply+adopt skills+all-projects+hook+doctor --fix), init, adopt, status, apply, hook, mcp, secret, env, doctor
scripts/e2e.sh          sandbox end-to-end run from copies of the real configs
skills/eag/SKILL.md     eag's own skill, linked into ~/.agents/skills by `hook install` so agents can drive it
test/*.test.js          unit tests (node --test); test/helpers.js holds the sandbox harness
```

Adapter contracts differ per agent, and `src/plan.js` branches on `t.agent` for read/render/write, so a new write target also needs a branch there until the signatures are unified:
- Codex: `read(scope, root)`, `render(name, src, overrides, warn)`, `write(scope, root, entries, { backupDir, dryRun })`, `toSource(obj)` (adopt).
- Claude: `read()`, `readLocal(root)` (informational), `render(name, src, { secrets })`, `write(actions, { dryRun })` (runs `claude mcp add-json|remove`; dry-run output is redacted), `available()`.
- Pi: `checks(root, sourceServers)` only, consumed by `doctor`; no `TARGETS` entry because Pi reads the source directly.

Keep each adapter a single file so an upstream format change is a small PR.

## Targets and quirks already handled

| Target | File | Write path | Quirks |
|---|---|---|---|
| claude-user | `~/.claude.json` | `claude mcp add-json` / `remove -s user` | file is rewritten wholesale by Claude; `add-json` refuses existing names, so update = remove + add; project "local" entries live under `projects[<root>].mcpServers` and are reported, not managed |
| claude project | `.mcp.json` | none, it is the source | Claude asks to approve the file once per project |
| codex-user | `~/.codex/config.toml` | managed block between `# >>> easy-agnostic managed >>>` / `# <<< easy-agnostic managed <<<` (matched as whole lines: anything but exactly one open and one close is `damaged` and refuses to write) | no `${VAR}` expansion; entries outside the block (hand-written, or another tool's own managed block) are locked: compared, never edited; adopt sets `targets.codex=false` for them |
| codex-project | `.codex/config.toml` | same block | Codex *does* merge global and project `mcp_servers` (codex-cli 0.153.4; project wins a name clash), so the block holds only the project's own servers; only read in trusted projects |
| pi | none | none | pi-mcp-adapter reads `~/.agents/mcp.json` and `./.mcp.json`; `~/.pi/agent/mcp.json` and `.pi/mcp.json` override it |

## Testing

Two layers, and both must pass before any change to merge, adapters, plan or secrets:

```bash
npm test                                        # unit tests; no agent, no keychain, no network
npm run e2e                                     # scripts/e2e.sh /tmp/eag-sandbox
KEEP_SANDBOX=1 scripts/e2e.sh /tmp/eag-sandbox  # keep the sandbox for the manual scenarios; rm -rf it afterwards
```

`test/` covers the merge (every presence combination, `locked`, both arms of `--prefer`), both renderers, the plan engine (each of the data-loss regressions has a named test), and the primitives in `util.js`. `test/helpers.js` is the harness: `sandbox()` redirects every path env var to a fresh `mkdtemp` and forces `EAG_SECRET_BACKEND=file`. Because `src/paths.js` resolves paths at import time and ESM imports are hoisted, a test that needs a sandbox must call `sandbox()` at the top level and then reach its module with `await import(...)`.

The e2e is the second layer:

It builds a sandbox from copies of `~/.codex/config.toml` and of the `mcpServers` part of `~/.claude.json` (both must exist), points every path at it via env vars (`EAG_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `EAG_SECRET_SERVICE=eag-test`, and `EAG_PROJECT` unset so project scope follows the sandbox cwd; only your shell rc is still read, read-only) and runs init, adopt, status, dry-run, apply, idempotent apply, project apply, doctor, plus `setup` end to end in a second, disposable sandbox. It asserts that the five files the run must produce exist, that the dry-run output carries no resolved secret, and that every file that can hold literals is `0600` (the applies that matter run under `umask 022` because the sandbox's own `umask 077` would hide a regression). The `eag-test` secrets are removed and the sandbox deleted when the script exits; with `KEEP_SANDBOX=1` the sandbox stays but the secrets are still removed, so set them again before running an apply inside it. Never run `eag apply` against the real home while developing, and never run project-scope commands from this checkout: `.mcp.json`, `.agents/` and `.codex/` are gitignored here precisely because a project-scope apply would generate them, possibly with literal credentials.

Scenarios v0 handles and must keep working, all automated by the script: adopt with secret extraction (happens when your real configs hold literals; a reference the sandbox cannot resolve gets a placeholder so the run tests the write paths, not your keychain); locked entry in Codex left alone; an unknown flag refused instead of ignored; a source without `mcpServers` refused instead of read as empty; a damaged managed block refusing the write; a block entry absent from `.state` surviving an unrelated write; apply, idempotent apply, redacted dry-run; a missing secret blocks the Claude write (always resolves) but not the Codex one when the reference can stay a native env-var pointer; `mcp rm` propagates deletes to every target; a hand edit in the managed block detected as a conflict and resolved with `--prefer native` then `--prefer source`; project apply generating `.codex/config.toml` and extending `.gitignore` idempotently; file modes including the re-tightening of a widened file. A write failure for one entry (a name the agent's own CLI refuses, say) is reported and skipped, never fatal to the rest of the run — the script's own adopted-from-real-config entries exercise this on a machine that has one.

## Staying in sync

`eag apply` is a one-shot write, so an agent already running keeps the config it started with. `eag hook install` (also run by `eag setup`) generates `~/.agents/shell-init.sh` and sources it from the shell rc: it evaluates `eag env` and defines one wrapper per agent binary that runs `eag apply --quiet` before handing over with `command <bin> "$@"`.

Rules that make it survivable:
- **Only what is installed gets wrapped.** A function named after a missing binary would make `command -v codex` succeed for a Codex that is not there. `src/shell.js` scans PATH; every `eag apply` regenerates the file, so an agent installed later is picked up without the user touching their rc again.
- **Pi is never wrapped** — it reads the source itself, so it cannot be stale.
- **No secret is written into the generated file.** It runs `eval "$(command eag env)"` at shell start; the values stay in the secret store.
- **Everything is guarded on `command -v eag`**, so uninstalling the package cannot break a shell.
- **`--quiet` reports a problem once.** It runs on every agent launch, so a chronic problem (an entry `claude mcp add-json` refuses, an unresolved conflict) would otherwise print the same line forever. `apply.js` keeps the last reported set in `.state/quiet.json` and prints only when it changes.
- **A refresh only ever adds a wrapper, never removes one.** The SessionStart launcher runs `eag apply` with the minimal PATH a GUI launch has, where no agent binary is visible; rebuilding the list from that would delete every wrapper and stop terminal launches syncing. Only an explicit `eag hook install` shrinks the list.

The other half, for launches that never see a shell (`src/hooks.js`):
- **Claude Code gets a `SessionStart` hook** merged into `~/.claude/settings.json`. That file is the user's, so eag adds exactly one entry, leaves every other key and any other tool's hooks alone, backs up before writing, and refuses outright if the file parses to something that is not an object.
- **The hook runs `~/.agents/bin/eag-sync`, never `eag`.** A GUI-launched agent on macOS has `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no `node`, so the launcher is POSIX sh with the interpreter and entry point baked in as absolute paths, plus a fallback search. It is silent and exits 0 unconditionally: anything it prints reaches the agent session, and a failure must never stop an agent from opening.
- **Codex gets one too**, in `$CODEX_HOME/hooks.json` — discovered implicitly, with no pointer in `config.toml` (the `hooks` key config.toml accepts is a *plugin* field, not this one). Keeping it out of `config.toml` matters: that file is the managed-block target, and eag never writes outside its own markers.
- **eag does not grant Codex's hook trust.** Codex records it in `config.toml` under `[hooks.state."<path>:session_start:0:0"]` and refuses to run an unapproved hook *in total silence*. Writing that entry would mean editing outside the managed block and approving eag's own code on the user's behalf — so `eag hook install`, `eag hook status` and `eag doctor` ask Codex for the state (`hooks/list` over `codex app-server`) and report it instead. `--dangerously-bypass-hook-trust` exists and must never be recommended.
- **The trust query is async and best effort.** stdin has to stay open until the reply arrives — `execFileSync` with `input` closes the pipe and the server exits first — and any failure resolves to null so `doctor` degrades to "unknown" rather than breaking.
- **`claude.secrets` defaults to `literal`** for the same GUI reason: a launchd environment has none of the shell's exports.

## Agent operability

Four agents with no prior knowledge were given real tasks on a machine with eag installed; all finished, and their reports shaped these rules:
- **Every state has one exit code**: 0 done · 1 error · 2 drift · 3 conflict. A script keyed on 2 must never be asked to guess whether it should apply or stop.
- **`--json` is the contract for scripts** (`status`, `apply`, `doctor`, `mcp ls`). Anything printed for a human — glyphs, alignment, colour — is not. Native entries in JSON pass through `redactKnown()`, which puts `${NAME}` back over any known secret value.
- **`eag <command> --help` is the flag reference.** The `USAGE` map in `src/cli.js` must list every flag a command accepts, with its value format; the global `HELP` is a summary.
- **A resolved secret is announced.** `claude.render()` warns per secret it resolves, because the file it lands in is the user's and `--dry-run` redacts.
- **`--prefer native` writes to the source.** Recording the native value only in the snapshot made the next apply undo the choice as "source changed".
- **The skill is the discovery mechanism.** `skills/eag/SKILL.md` ships in the package and is linked into `~/.agents/skills` by `hook install`; keep it in step with the CLI.

## Conventions

- Node >= 20, ESM, no build step, single dependency (`smol-toml`). Do not add a framework or a TypeScript toolchain for v0.
- Keep CLI output terse and greppable; colours via `c` in `src/util.js`.
- Exit codes: 0 clean, 1 errors, 2 drift, 3 conflict (`status --exit-code`, `apply`). Drift and conflict demand opposite reactions from a script, so they must never share a code again.
- New agent = new file in `src/adapters/` plus an entry in `TARGETS` in `src/plan.js` (and, for now, a branch on `t.agent` in `buildPlan`/`applyPlan`). Do not special-case agents inside commands.
- Do not commit or push unless asked.
- Package name on npm is `easy-agnostic`; the bin is `eag`. `files` in `package.json` limits the tarball to `bin/` and `src/`; check with `npm pack --dry-run` before publishing. An unrelated `eag` package exists on npm, so docs must always say `npx easy-agnostic`, never `npx eag`.

## Roadmap

- Phase 0 (done, and run for real on the maintainer's machine): Claude + Codex + Pi, user and project scope, unit tests, secrets by reference everywhere.
- Phase 1: Cursor adapter, `doctor --fix` coverage, native SessionStart hooks for the GUI/IDE launch path the shell cannot reach (Codex has a full lifecycle hook system; Claude Code takes one in settings.json), fish support in `src/shell.js`, adopt extracting credentials embedded in URLs, a hermetic e2e with versioned fixtures so a contributor without the real configs can run it.
- Phase 2: `eag run <server>` stdio wrapper: inject secrets into the server process and do OAuth once with a shared token store (embed mcp-remote).
- Phase 3: Gemini/Antigravity and OpenCode adapters, Claude permissions to Codex execpolicy rules (opt-in), `eag pack` exporting the source as an Agent Plugins 1.0 plugin.

## Open questions to confirm on a real run

- Do Cursor/OpenCode/Kimi dedupe a skill reachable through both `.agents/skills` and a `.claude/skills` symlink?
