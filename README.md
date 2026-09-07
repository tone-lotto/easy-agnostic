# Easy Agnostic (`eag`): one source, many agents

Keep MCP servers (and the wiring for skills and instructions) in sync across **Claude Code**, **Codex** and **Pi** from one source, without clobbering anything you edited by hand and without secrets in versioned files.

Status: v0 spike. Targets: Claude Code (user scope via `claude mcp`, project scope is native), Codex (managed block in `config.toml`, user + project), Pi (reads the source directly through `pi-mcp-adapter`, nothing to write).

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


## Install

```bash
npm i -g easy-agnostic        # puts `eag` on PATH
npx easy-agnostic setup       # or run without installing (not `npx eag`: that is an unrelated package)
```

Node 20 or newer. macOS and Linux.

## Quick start

```bash
eag setup                     # detects Claude Code, Codex and Pi; imports what each already has; syncs it everywhere
echo 'eval "$(eag env)"' >> ~/.zshrc
```

That's it for the common case, and it is safe to run again any time — nothing it does can overwrite a hand edit (see "How it works" below). `eag setup` is `init` + `adopt claude` + `adopt codex` + `apply` + `doctor --fix` in one command; run once per machine.

Per project, to also sync `.mcp.json` into a per-repo Codex config:

```bash
cd my-repo
eag setup --project           # same, scoped to this repo's .mcp.json instead of the whole machine
```

The generated `.codex/config.toml` holds only this repo's own servers (Codex merges them with your user config) and can contain literal values where Codex has no env-var field, so keep it out of git: `eag init --project` appends `.agents/.state/` and `.codex/config.toml` to an existing `.gitignore` (in a fresh repo, create the file with both lines).

The individual steps behind `setup` are still there when you want more control — say no to one agent, preview before writing, or just check what drifted:

```bash
eag init                      # ~/.agents/mcp.json, agents.json, detects agents
eag adopt claude              # import what Claude Code has today (secrets -> secret store)
eag adopt codex               # same for Codex; entries owned by another tool stay theirs
eag status                    # drift per agent
eag apply --dry-run           # preview, then without --dry-run to write (user scope)
eag doctor --fix              # checks skills symlinks, @AGENTS.md, Codex trust, Pi adapter, secrets; --fix repairs the first two
```

## Daily use

```bash
eag mcp add linear --url https://mcp.linear.app/mcp --header 'Authorization: Bearer ${LINEAR_TOKEN}'
eag secret set LINEAR_TOKEN       # prompts; or pipe it in a script (--value would land in shell history)
eag apply
eag mcp target linear codex off   # keep it out of one agent
eag status --exit-code            # 0 clean, 2 drift, 1 errors (good for a shell prompt or CI)
```

## When eag stops

An apply that finds the agent's file changed since the last one reports a conflict, writes nothing for that entry, and exits 2. That is the whole point — it will not decide for you. Four ways out, in the order you usually want them:

```bash
eag apply --prefer source     # your edit was a mistake: the source wins
eag apply --prefer native     # your edit was right, but only for now: eag stops tracking that entry
eag adopt claude              # your edit was right and belongs in the source: import it back
eag mcp target <name> claude off   # that entry is not eag's business at all
```

`--prefer native` disowns the entry rather than teaching eag about it, so the next `status` shows it as foreign. If you want the edit to survive as the new truth, `eag adopt` is the answer.

Entries eag has never written are never touched, with or without a conflict: a server another tool manages in `~/.codex/config.toml` (outside eag's marker block) is reported as `locked` and left exactly where it is.

## What eag writes, and how to undo it

| Path | What |
|---|---|
| `~/.agents/mcp.json`, `agents.json` | the source; yours, plain files |
| `~/.agents/.state/<target>.json` | what eag wrote last time, per target — the third leg of the merge (`0600`) |
| `~/.agents/.state/backup/` | the previous copy of every file eag rewrote, last 10 per target (`0600`) |
| `~/.agents/.secrets.index` | the *names* of your secrets, never the values (`0600`) |
| `~/.codex/config.toml` | one block between `# >>> easy-agnostic managed >>>` and `# <<< easy-agnostic managed <<<`; nothing outside it |
| `~/.claude.json` | never edited directly — only through `claude mcp add-json` / `claude mcp remove` |

To back out completely: delete the marker block from `~/.codex/config.toml` (or restore a file from `.state/backup/`), run `claude mcp remove <name> -s user` for each server eag added, then `rm -rf ~/.agents/.state` and uninstall. Your secrets stay in the OS store until you remove them with `eag secret rm`.


## Environment

`EAG_HOME` (default `~/.agents`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `EAG_PROJECT`, `EAG_SECRET_SERVICE`, `EAG_SECRET_BACKEND=keychain|secret-tool|file`, `EAG_DEBUG` (print stack traces). `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR` are the agents' own variables, so the whole tool can be pointed at a sandbox (see `scripts/e2e.sh`); the rest are eag's.

## Known limits (v0)

- Codex merges global and project `mcp_servers` (verified on codex-cli 0.153.4; a name in both resolves to the project's), so the project block holds only the project's own servers. Codex only reads `.codex/config.toml` in projects marked trusted.
- Codex has no `${VAR}` expansion, so a reference it has no env-var field for is written as a literal value (eag warns). A `config.toml` eag creates, or one whose managed block ends up carrying such a literal, is written `0600`; otherwise the file keeps the permissions it had, and eag never widens them.
- **A reference is only as good as the environment the agent starts in.** Claude Code does expand `${VAR}` — verified against claude 2.1.x, in `env` values and in HTTP headers, including mid-string — but it expands from its own process environment. On macOS an agent launched from a desktop app or an IDE inherits the launchd environment, not your shell rc, so a reference resolves to nothing there and the server cannot authenticate. That is why Claude Code gets resolved values by default. If you only ever start your agents from a terminal, set `"claude": {"secrets": "env"}` in `agents.json` and no credential is written to `~/.claude.json` at all. The same split applies to Codex, which always uses env-var pointers (`bearer_token_env_var`, `env_vars`): those need `eval "$(eag env)"` in your shell rc, and they do not resolve for an app-launched Codex either.
- Keys Codex has no field for (e.g. Claude's `directTools`) are dropped for Codex and kept for Claude/Pi.
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
