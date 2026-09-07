# Changelog

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
