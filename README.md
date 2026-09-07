# Easy Agnostic (`eag`): one source, many agents

Keep MCP servers (and the wiring for skills and instructions) in sync across **Claude Code**, **Codex** and **Pi** from one source, without clobbering anything you edited by hand and without secrets in versioned files.

Status: v0 spike. Targets: Claude Code (user scope via `claude mcp`, project scope is native), Codex (managed block in `config.toml`, user + project), Pi (reads the source directly through `pi-mcp-adapter`, nothing to write).

## Setup

The fastest way is to hand it to the coding agent you already have open — Claude Code, Codex, Pi. Copy this and paste it to your agent:

```text
Install and set up easy-agnostic (the `eag` CLI) so my MCP servers and skills stay in sync across Claude Code, Codex and Pi. Run `npx easy-agnostic setup` (not `npx eag`, that is a different package), then `eag doctor`, and show me what it reports. It will leave two things for me to do by hand — open a new terminal, and approve a hook in Codex (`/hooks` in the terminal, or Settings → Hooks in the ChatGPT app) — tell me when to do them. Do not use sudo; if `npm i -g` fails, stop and tell me.
```

Or run it yourself:

```bash
npx easy-agnostic setup
```

Node 20 or newer, macOS or Linux. One run per machine; safe to run again any time — nothing it does can overwrite a hand edit.

### What `setup` does

| step | what happens |
|---|---|
| `0/8 install` | installs `eag` globally so the launch hooks have a stable path (an npx run lives in an evictable cache) |
| `1/8 init` | creates `~/.agents/mcp.json` and `agents.json`, detects which agents are installed |
| `2/8 adopt claude` | imports the servers Claude Code already has; credentials go to the OS keychain and become `${NAME}` |
| `3/8 adopt codex` | same for Codex; a table another tool owns, or a ChatGPT app internal, stays Codex's and is not shared |
| `4/8 apply` | writes the source into each agent through a 3-way merge |
| `5/8 adopt skills` | a skill only one agent has moves to `~/.agents/skills`, where every agent reads it |
| `6/8 make projects agnostic` | per-repo servers Claude kept to itself become that repo's own `.mcp.json` |
| `7/8 hook install` | sync on launch: a shell wrapper for terminal launches, a `SessionStart` hook for app/IDE launches, and eag's own skill so agents know how to drive it |
| `8/8 doctor --fix` | wiring checks; repairs symlinks and identical skill copies |

It prints every file it touches. The whole thing takes about ten seconds.

### The two things it cannot do for you

1. **Open a new terminal.** A shell that was already open does not re-read its rc, so the secrets are not exported in it yet. `doctor` says so until you do.
2. **Approve the Codex hook, once.** Codex will not run a hook it has not been told to trust, and says nothing when it skips one — so eag keeps telling you. Open Codex and run `/hooks` (terminal) or go to Settings → Hooks (ChatGPT app), and approve. Each repo that gets a `.codex/config.toml` also needs to be trusted inside Codex once; `eag doctor` in the repo says which.

After that there is nothing to remember: every agent launch syncs, and every launch checks for a newer eag at most once a day and installs it in the background.

### Check it worked

```bash
eag doctor          # "no problems" is the goal; every warning names the command that fixes it
eag status          # what differs between the source and each agent (nothing, right after setup)
eag mcp ls          # every server, with the agents it is switched off for
```

### Per project

```bash
cd my-repo
eag setup --project           # this repo's .mcp.json → every agent, in this repo only
```

The generated `.codex/config.toml` holds only this repo's own servers (Codex merges them with your user config) and can contain literal values where Codex has no env-var field, so keep it out of git: `eag init --project` appends `.agents/.state/` and `.codex/config.toml` to an existing `.gitignore` (in a fresh repo, create the file with both lines).

### The steps, one at a time

For more control — say no to one agent, preview before writing, or just check what drifted:

```bash
eag init                      # ~/.agents/mcp.json, agents.json, detects agents
eag adopt claude              # import what Claude Code has today (secrets -> secret store)
eag adopt codex               # same for Codex; entries owned by another tool stay theirs
eag adopt skills              # move skills only one agent has into ~/.agents/skills
eag adopt claude --all-projects   # per-repo Claude servers -> each repo's own .mcp.json
eag status                    # drift per agent
eag apply --dry-run           # preview, then without --dry-run to write (user scope)
eag hook install              # sync on launch; safe to re-run, undo with eag hook uninstall
eag doctor --fix              # checks skills symlinks, @AGENTS.md, Codex trust, Pi adapter, secrets; --fix repairs what is safe
```

## How it works

- **Source of truth**: `~/.agents/mcp.json` (user) and `./.mcp.json` (project). Same `mcpServers` shape Claude Code, Pi, Cursor and the Agent Plugins spec already use. `~/.agents/agents.json` says which agents are targets and per-server exceptions.
- **Secrets by reference**: the source only contains `${NAME}`. Values live in the OS secret store (`eag secret set NAME`): the macOS keychain, `secret-tool` on Linux, or a 0600 `~/.agents/.secrets.env` when neither is available (`EAG_SECRET_BACKEND` overrides the choice). A lookup tries the active store, then that file, then the variable in eag's own environment, so a stale entry in either can shadow what you expect. Codex gets `bearer_token_env_var` / `env_vars`; Claude Code gets the resolved value (see the note on launch context under "Known limits"); Pi expands `${NAME}` from its own environment. `eval "$(eag env)"` in your shell rc makes the variables available. A `${NAME}` that is not in the store falls back to the value that variable already has in eag's own environment.
- **3-way merge**: every apply compares what the source wants, what eag wrote last time (`.state/`), and what the agent's file has now. Entries eag never wrote are left alone. A native edit after the last apply is a conflict: eag stops and shows it instead of overwriting.
- **Never breaks an agent**: Codex TOML is validated before the file is replaced; writes are atomic; a backup of the previous file is kept under `.state/backup/`.

## The source

`~/.agents/mcp.json` is a plain `mcpServers` file — the same shape Claude Code, Pi, Cursor and the Agent Plugins spec already read, so it is useful even if you stop using eag:

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" }
    },
    "freepik": {
      "type": "stdio",
      "command": "/usr/local/bin/uv",
      "args": ["run", "--directory", "~/mcp-servers/freepik-mcp", "main.py"],
      "env": { "FREEPIK_API_KEY": "${FREEPIK_API_KEY}" }
    }
  }
}
```

`~/.agents/agents.json` holds every tool-specific decision, so `mcp.json` stays portable:

```json
{
  "targets": { "claude": true, "codex": true, "pi": "read-only" },
  "servers": {
    "linear":  { "targets": { "codex": false } },
    "freepik": { "codex": { "startup_timeout_sec": 120 } }
  }
}
```

`targets` turns a whole agent on or off. Under `servers`, `targets` is the per-server exception (`eag mcp target linear codex off` writes it), and a key named after an agent carries options only that agent understands. Note that `targets` governs what eag *writes*: Pi reads `mcp.json` itself, so a server in the source reaches Pi whichever way those switches are set.


## For agents

`eag` is meant to be driven by coding agents as much as by people, and ships its own skill: `eag hook install` links `skills/eag/SKILL.md` into `~/.agents/skills`, which Codex reads directly and `doctor` links into Claude Code. So an agent on a machine with eag installed knows the commands, the exit codes and the secret model without being told. For scripts: `--json` on `status`, `apply`, `doctor` and `mcp ls`; `eag <command> --help` for every flag; and exit codes that mean one thing each — `0` done · `1` error · `2` drift · `3` conflict.

## Daily use

```bash
eag mcp add linear --url https://mcp.linear.app/mcp --header 'Authorization: Bearer ${LINEAR_TOKEN}'
eag secret set LINEAR_TOKEN       # prompts; or pipe it in a script (--value would land in shell history)
eag apply
eag mcp target linear codex off   # keep it out of one agent
eag status --exit-code            # 0 clean · 2 drift · 3 conflict · 1 error (good for a shell prompt or CI)
eag status --json                 # the same, as one object per target, for scripts and agents
```

## When eag stops

An apply that finds the agent's file changed since the last one reports a conflict, writes nothing for that entry, and exits 2. That is the whole point — it will not decide for you. Four ways out, in the order you usually want them:

```bash
eag apply --prefer source     # your edit was a mistake: the source wins
eag apply --prefer native     # your edit was right: it is written back into the source and stays
eag mcp target <name> claude off   # that entry is not eag's business at all
```

The conflict line shows both sides, and `eag status --json` carries them as `source` and `native`, so the choice is never blind. `--prefer native` re-references any secret it finds (the value goes to the store, `${NAME}` goes into the source) and translates a Codex table back to the source shape — the same path `eag adopt` takes.

Entries eag has never written are never touched, with or without a conflict: a server another tool manages in `~/.codex/config.toml` (outside eag's marker block) is reported as `locked` and left exactly where it is.

## What eag writes, and how to undo it

| Path | What |
|---|---|
| `~/.agents/mcp.json`, `agents.json` | the source; yours, plain files |
| `~/.agents/shell-init.sh` | generated by `eag hook install`; exports the `${NAME}` values and defines the launch wrappers. No secret is written into it |
| your shell rc | one guarded line between `# >>> easy-agnostic >>>` markers, sourcing the file above |
| `~/.agents/.state/<target>.json` | what eag wrote last time, per target — the third leg of the merge (`0600`) |
| `~/.agents/.state/backup/` | the previous copy of every file eag rewrote, last 10 per target (`0600`) |
| `~/.agents/.secrets.index` | the *names* of your secrets, never the values (`0600`) |
| `~/.codex/config.toml` | one block between `# >>> easy-agnostic managed >>>` and `# <<< easy-agnostic managed <<<`; nothing outside it |
| `~/.claude.json` | never edited directly — only through `claude mcp add-json` / `claude mcp remove` |

To back out completely: delete the marker block from `~/.codex/config.toml` (or restore a file from `.state/backup/`), run `claude mcp remove <name> -s user` for each server eag added, then `rm -rf ~/.agents/.state` and uninstall. Your secrets stay in the OS store until you remove them with `eag secret rm`.


## Staying in sync

`eag apply` writes the source into each agent, so an agent that is already running keeps whatever it read at start. `eag hook install` closes that gap for anything you launch from a terminal:

```bash
eag hook install     # `eag setup` already did this; run it again after installing a new agent
eag hook status      # what is wired, and what is not
eag hook uninstall   # takes the block back out of your rc and deletes the generated file
```

It wires both launch paths.

**From a terminal.** `~/.agents/shell-init.sh`, sourced by one guarded line in your `~/.zshrc` (or `~/.bashrc`). It evaluates `eag env` and defines a wrapper per agent binary:

```sh
__eag_sync() { command eag apply --quiet || true; }
codex() { __eag_sync; command codex "$@"; }
```

**From a desktop app or an IDE.** Those never read your shell rc, so eag installs a `SessionStart` hook in each agent's own config — `~/.claude/settings.json` for Claude Code and `~/.codex/hooks.json` for Codex, both merged into your file and leaving every other setting and any other tool's hooks alone. Both run `~/.agents/bin/eag-sync`, a POSIX shell launcher with the node interpreter and eag's entry point baked in as absolute paths: a GUI-launched agent on macOS starts with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where `node` does not exist, so a hook calling `eag` directly would silently do nothing. The launcher exits 0 whatever happens — a sync problem must never stop an agent from opening.

**Codex needs one approval.** It will not run a hook it has not been told to trust, and it says nothing at all when it skips one. eag cannot grant that trust for you: it lives in `config.toml` outside the block eag owns, and approving its own hook is not eag's call. So open Codex once, run `/hooks`, and approve it. Until you do, `eag hook status` and `eag doctor` say so plainly rather than letting it fail in silence.

Either way, `--quiet` says nothing when there is nothing to do. When there is a problem — a conflict it refuses to resolve for you, an entry the agent's own CLI rejects — it prints it **once** and then stays quiet until the problem changes, so a chronic one never trains you to ignore the line. `eag status` and `eag doctor` always show everything.

The generated file is refreshed by every `eag apply`, so an agent you install later gets wrapped without you touching your rc again. A refresh only ever adds: the hook launcher runs with a minimal PATH where no agent binary is visible, and rebuilding the list there would delete every wrapper.

**What is still not covered.** `fish` is not supported for the terminal half — the generated file is POSIX shell — though the `SessionStart` hooks work regardless of your shell. And on macOS the same GUI/terminal split is why credentials are written resolved by default: a GUI-launched process gets the launchd environment, where your shell exports do not exist.

## Staying up to date

`npx easy-agnostic setup` installs eag globally on its first run, because everything that syncs on launch needs a stable `eag` on PATH — the npx cache is neither stable nor on PATH. From then on every `eag apply` (so every agent launch) asks the registry at most once a day and, for a global install, installs a newer version in the background; the next launch runs it. `eag update` does it now, `eag update --check` only looks. `"autoUpdate": false` in `~/.agents/agents.json` turns the background update off.


## Environment

`EAG_HOME` (default `~/.agents`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `EAG_PROJECT`, `EAG_SECRET_SERVICE`, `EAG_SECRET_BACKEND=keychain|secret-tool|file`, `EAG_DEBUG` (print stack traces). `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` are the agents' own variables, so the whole tool can be pointed at a sandbox (see `scripts/e2e.sh`); the rest are eag's.

## Known limits (v0)

- Codex merges global and project `mcp_servers` (verified on codex-cli 0.153.4; a name in both resolves to the project's), so the project block holds only the project's own servers. Codex only reads `.codex/config.toml` in projects marked trusted.
- Codex has no `${VAR}` expansion, so a reference it has no env-var field for is written as a literal value (eag warns). A `config.toml` eag creates, or one whose managed block ends up carrying such a literal, is written `0600`; otherwise the file keeps the permissions it had, and eag never widens them.
- **A reference is only as good as the environment the agent starts in.** Claude Code does expand `${VAR}` — verified against claude 2.1.x, in `env` values and in HTTP headers, including mid-string — but it expands from its own process environment. On macOS an agent launched from a desktop app or an IDE inherits the launchd environment, not your shell rc, so a reference resolves to nothing there and the server cannot authenticate. That is why Claude Code gets resolved values by default. If you only ever start your agents from a terminal, set `"claude": {"secrets": "env"}` in `agents.json` and no credential is written to `~/.claude.json` at all. The same split applies to Codex, which always uses env-var pointers (`bearer_token_env_var`, `env_vars`): those need `eval "$(eag env)"` in your shell rc, and they do not resolve for an app-launched Codex either.
- Keys Codex has no field for (e.g. Claude's `directTools`) are dropped for Codex and kept for Claude/Pi.
- Skills are shared through `~/.agents/skills`: Codex reads it directly, `doctor --fix` links it into `~/.claude/skills`, and `eag adopt skills` moves a skill that only one agent has into it (Claude is left a link). Only skills you added move; what ships with a tool stays. Note that this is **Claude Code**'s skill directory — the CLI, the VS Code extension and the Claude Code panel in the desktop app. The desktop app's Settings → Skills page is the claude.ai account library, a separate cloud-side system eag does not touch. A copy of the same skill under `~/.codex/skills` makes Codex list it twice (`doctor --fix` removes an identical copy); two *different* skills sharing a name are reported and left alone.
- `eag adopt` extracts credentials from headers and env only: a token embedded in a URL or in `args` stays in the source as is. `eag doctor` checks headers, env and the URL by shape, so it catches the common token formats and a `user:password@` URL, but it is a heuristic, not a guarantee.
- A write failure for one entry (e.g. a name the `claude` CLI itself reserves) is reported (`failed   <name>: <reason>`) and skipped, not fatal to the rest of `apply`; a later run retries it.
- No OAuth sharing yet: OAuth-backed remote servers (e.g. Supabase, Vercel, PostHog) still log in once per agent. A stdio wrapper (`eag run`) is the planned phase 2.
- Writing to Claude Code user scope goes through the `claude` CLI, so it must be on `PATH`; without it that
  target is reported and skipped. Codex and Pi need no binary — eag writes the files directly.
- macOS and Linux only.

## Contributing

```bash
git clone https://github.com/tone-lotto/easy-agnostic && cd easy-agnostic
npm install && npm link       # `eag` now runs from this checkout
npm test                      # unit tests: the merge, both renderers, the plan engine, the primitives. No agent needed.
npm run e2e                   # end-to-end in a sandbox built from your ~/.codex/config.toml and the mcpServers part of
                              # ~/.claude.json (both must exist, and the Claude CLI must be on PATH); deleted on exit,
                              # KEEP_SANDBOX=1 keeps it
```

See `CLAUDE.md` for the principles, layout and the scenarios that must keep working.

## License

MIT
