# Changelog

## 0.9.0 — 2026-09-07

- Add `eag adopt skills --scope project` to share skills within a repository and create relative Claude links without moving global skills. `setup --project` now includes project skill adoption.
- Add `eag skills ls --scope user|project [--json]` to distinguish shared, agent-specific, linked, and inherited user skills, with conflict and same-name indicators.
- Add scoped doctor repairs; `setup --project` no longer repairs global skill directories.
- Preserve both conflicting project copies, refuse project skill directories that redirect to global locations, and recheck duplicates before removing them.

## 0.8.0 — 2026-09-07

- Add `eag instructions [--dry-run] [--prefer agents|claude] [--json]` for bidirectional project-root AGENTS.md / CLAUDE.md sync. Creates a missing counterpart, propagates single-sided edits, and refuses divergent edits or deletions until explicitly resolved.
- `doctor --fix` enables instruction sync; `apply` and launch hooks sync enrolled projects, and `status` reports instruction drift. Hash-only machine-local baselines, private backups, locks, and pre-write checks protect existing content. Symlinks are left intact.
- Legacy `@AGENTS.md` imports migrate without circular references. Additional Claude-specific text stays outside a marked shared region; shared edits flow in both directions without copying local instructions into AGENTS.md. Damaged markers and circular imports stop sync.
- Instruction command errors support JSON, and `apply --json` restores the caller's console after returning.

## 0.7.2 — 2026-09-07

From the first outside tester's second run.

- **A second `setup` repairs what 0.6.0 did.** 0.6.1 stopped `adopt codex` from bringing Codex's app
  internals into the source, but the ones an earlier run had already adopted stayed there — and kept
  being pushed into Claude Code (`cua_repl`, `node_repl`, `meta-ads`) or failing on every apply
  (`computer-use`, a name Claude reserves). When the source holds one of those byte for byte as Codex
  has it, adopt now takes it back out and the next apply removes it from the agents. A source entry
  with different content is the user's and is left alone, as before.
- `doctor` no longer calls it a problem that `setup` itself ran from the npx cache when the global
  install it just made is in place.
- `doctor` run from `$HOME` listed every skill twice (the "project" `.agents/skills` there is the user's
  own directory).
- The "secrets not exported in this shell" warning now says the useful thing when the shell file was
  installed moments ago: open a new terminal.

## 0.7.1 — 2026-09-07

- **The background update works from a desktop-app launch.** It ran `npm` by PATH, and a hook
  started by an app has `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — no npm, so for an app-only user the
  update silently never started. npm is found next to the node the launcher already resolved and run
  as `<node> <npm-cli.js>`, since npm is itself a node script with an env shebang.
- `apply` also refreshes eag's own skill copy after an update, so `~/.agents/skills/eag` describes the
  installed version.

## 0.7.0 — 2026-09-07

Updates without anyone remembering to update.

- **`npx easy-agnostic setup` now installs eag globally first** (`npm i -g`). Everything downstream
  — the shell wrappers, the launch hooks, `eag update` — assumes a stable `eag`, and an npx run gives
  neither: the package sits in an evictable cache and is never on PATH. The first outside tester's
  shell file was silently skipping everything for exactly that reason while `doctor` reported it wired.
- **`eag update`** installs the latest version in place and refreshes the launcher, shell file and skill.
  `--check` only reports. A linked checkout is left to git; an npx cache is told to install globally.
- **Every `eag apply` checks the registry at most once a day** (cached in `.state/update.json`, 3 s
  timeout, offline is fine) and, for a global install, installs a newer version in the background so
  the next launch runs it. `"autoUpdate": false` in `agents.json` or `EAG_NO_UPDATE=1` turns that off;
  a checkout or npx install is told once instead.
- **The launch hook runs the installed `eag`, not the package it was generated from**, always through the
  resolved node (the installed one is a node script too, and a GUI launch has no node on PATH). So an
  upgrade takes effect on the next launch with no rewrite, and a launcher generated from an npx cache
  outlives that cache.
- **The shell file puts npm's global bin dir on PATH before looking for `eag`**, so it works even in a
  shell whose rc never had it.
- `doctor` reports how eag itself is installed (global / linked checkout / npx cache) and treats the
  npx case as a problem, with the fix.

## 0.6.1 — 2026-09-07

Found by the first outside tester, on a Mac with the ChatGPT app.

- **Fixed: `adopt codex` pushed Codex-only internals into Claude Code.** A table outside eag's
  block was "locked", and locked was treated as "share it with the other agents". On a machine
  with the ChatGPT app that meant registering `cua_repl` (ChatGPT.app itself), `node_repl` and
  a `computer-use` that Claude rejects by name as MCP servers in Claude Code. A locked table
  now stays Codex's alone when it belongs to another tool's marker block, points into a macOS
  `.app` bundle, is one of the ChatGPT/Codex app internals, or is disabled — unless the source
  already has that name from another agent, in which case eag just keeps out of Codex's way as
  before. A plain hand-written table is still shared; that is what eag is for.
- Fixed: `eag mcp rm` now drops the server's per-agent policy from `agents.json` too. A leftover
  `targets.codex=false` silently skipped a same-named server added later, including a project's
  own copy of it.
- `eag adopt skills` never moves what ships with a tool: Codex's `.system` directory and its
  curated names, anything marked as managed by a tool. Only skills the user added move.

## 0.6.0 — 2026-09-07

- **Skills flow both ways.** `eag adopt skills` moves a skill that only one agent has — under
  `~/.claude/skills` or `~/.codex/skills` — into `~/.agents/skills`, which Codex reads directly and
  `doctor --fix` links into Claude Code. Claude is left a link so nothing it had disappears; Codex gets
  nothing left behind because a copy would make it list the skill twice. Two *different* skills sharing
  a name are reported and left exactly where they are (exit 2); eag never picks. `eag setup` runs it as
  step 5/8, and `doctor` names any skill still kept by one agent alone.

## 0.5.0 — 2026-09-07

Agent-operability release. Four agents that had never seen the project were each given a real task
on a machine with `eag` installed; all four finished, one found the tool unaided in two minutes, and
their reports drove everything below.

- **Exit code 3 for a conflict.** `status --exit-code` and `apply` used to return 2 for both "something
  to apply" and "a native edit eag refuses to overwrite", which demand opposite reactions. Now:
  `0` clean · `1` error · `2` drift · `3` conflict.
- **`--json` on `status`, `apply`, `doctor` and `mcp ls`.** One object per target with every action,
  its reason, and on a conflict both sides — with any known secret value replaced by its `${NAME}`.
- **`--prefer native` sticks.** It used to record the native value only in the snapshot, and the next
  plain `apply` overwrote the edit as "source changed". Native now wins by being written back into the
  source (secrets re-referenced, Codex tables translated), so it stays kept.
- **Conflict lines show both sides**, so `--prefer` is no longer a blind choice.
- **A resolved secret is never silent.** Writing a `${NAME}` as its value into `~/.claude.json` is the
  default (an app-launched agent has no shell environment), and `apply` now says so per secret and how
  to switch to references.
- **`eag <command> --help`** prints that command's own usage with every flag and value format. Several
  flags (`--force`, `--cwd`, `--type`, `--args`) were previously discoverable only by provoking errors.
- **`--arg`** (repeatable, one argument each) for `mcp add`; `--args` with spaces and no comma is refused
  instead of being stored as one broken argument.
- **A missing source is an error**, not "nothing to do": `status` and `apply` say to run `eag init`.
- **eag ships its own skill** (`skills/eag/SKILL.md`), linked into `~/.agents/skills` by `eag hook install`.
  Codex reads that directory itself and `doctor` links it into Claude Code, so an agent that was never
  told eag exists learns the commands, the exit codes and the secret model.
- **Skills: duplicates and collisions.** Codex reads `~/.agents/skills` natively, so a copy of the same
  skill under `~/.codex/skills` makes it list the skill twice; `doctor --fix` removes an identical copy.
  Two *different* skills sharing a name — in Codex's directory or shadowing a Claude symlink — used to
  be reported at a level the summary did not count; it is a counted warning now, and never resolved
  for you.
- **`eag adopt claude --all-projects`** and `setup` step 5/7: Claude keeps per-project servers to itself
  in `~/.claude.json`; this moves each into that repo's own `.mcp.json`, which Claude and Pi read
  natively and Codex gets through `.codex/config.toml`. `--no-projects` opts out of the setup step.
- **Fixed: project scope in `$HOME` wrote the user config.** `EAG_HOME` defaults to `~/.agents`, so a
  project rooted at the home directory resolved its `agents.json` to the machine-wide one. Refused now.
- Fixed: `init --project` no longer leaves an empty `agents.json` in every repo it touches.

## 0.4.0 — 2026-09-07

- Codex `SessionStart` hook in `~/.codex/hooks.json`, discovered with no pointer in `config.toml`. eag
  does not grant Codex's hook trust (it lives in `config.toml` outside the managed block, and approving
  its own code is not eag's call); it asks Codex for the state and reports it, because an unapproved
  hook is skipped in total silence.

## 0.3.0 — 2026-09-07

- Sync on launch for app and IDE launches: a `SessionStart` hook in `~/.claude/settings.json` running
  `~/.agents/bin/eag-sync`, a POSIX launcher with node and the entry point baked in as absolute paths
  (a GUI-launched agent on macOS has no `node` on PATH). Bounded by `timeout`, silent by construction.
- Fixed: the launcher's minimal PATH made the shell-file refresh drop every wrapper.

## 0.2.0 — 2026-09-07

- Sync on launch for terminal launches: `eag hook install` generates `~/.agents/shell-init.sh`, which
  exports the secrets and wraps each agent binary with `eag apply --quiet`.
- `apply --quiet` reports a problem once and stays quiet until it changes.

## 0.1.1 — 2026-09-07

- Fixed: 0.1.0 wrote `${NAME}` references into `~/.claude.json`. Claude Code expands them, but from its
  own process environment, which an app-launched agent does not have. Resolved values are the default
  again; `{"claude": {"secrets": "env"}}` is the opt-in for terminal-only users.

## 0.1.0 — 2026-09-07

First release. Deprecated: see 0.1.1.
