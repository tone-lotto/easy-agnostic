---
name: eag
description: Operate Easy Agnostic (`eag`), the CLI that keeps MCP servers in sync across Claude Code, Codex and Pi from one source (~/.agents/mcp.json). Use it whenever a task involves adding, removing or fixing an MCP server, a server that one agent has and another does not, a ${NAME} secret that is not resolving, or making a repo's servers work in every agent.
---

# eag — one source, many agents

`eag` keeps MCP servers in sync from one file, `~/.agents/mcp.json` (user scope) or `./.mcp.json`
(project scope), in the plain `mcpServers` shape. Claude Code and Pi read the project file natively;
Codex gets a rendered copy in `config.toml`; Claude Code user scope gets it through `claude mcp`.
It never overwrites a hand edit, and secrets live in the OS keychain as `${NAME}` references.

Run `eag <command> --help` for every flag. Exit codes everywhere:
`0` nothing to do or done · `1` error · `2` drift (something to apply) · `3` conflict (a native edit eag will not overwrite).

## The commands you actually use

| task | command |
|---|---|
| see what differs between the source and each agent | `eag status --exit-code` (add `--json` in scripts) |
| write the source into every agent | `eag apply` (`--dry-run` first; `--json` in scripts) |
| add a remote server | `eag mcp add NAME --url URL --header 'Authorization: Bearer ${TOKEN}'` |
| add a local server | `eag mcp add NAME --command BIN --arg a --arg b --env K=${V}` |
| store the value behind `${TOKEN}` | `printf %s "$TOKEN" \| eag secret set TOKEN` |
| remove a server everywhere | `eag mcp rm NAME` then `eag apply` |
| keep a server out of one agent | `eag mcp target NAME codex off` |
| make a repo's servers work in every agent | `cd repo && eag init --project && eag adopt claude --scope project && eag apply --scope project` |
| make every repo agnostic at once | `eag adopt claude --all-projects` |
| check the wiring (hooks, trust, secrets, skills) | `eag doctor` (`--fix` repairs what is safe to repair) |
| share project instructions in both directions | `eag instructions --dry-run`, then `eag instructions` |
| share only this repo's skills | `eag adopt skills --scope project --dry-run`, then without `--dry-run` |
| distinguish project skills from inherited user skills | `eag skills ls --scope project --json` |
| resolve conflicting instruction files explicitly | `eag instructions --prefer agents` or `--prefer claude` |

## Rules that keep you out of trouble

- **Never put a credential in `mcp.json`.** Write `${NAME}` and `eag secret set NAME`. `eag doctor` flags literals.
- **A conflict is a stop, not an error.** `eag apply` exits 3 and names the entry. Read both sides
  (`eag status --json` shows `source` and `native`), then choose: `--prefer source` overwrites the native
  edit; `--prefer native` keeps it and writes it back into the source. Do not pick blindly.
- **`apply` is idempotent.** Running it again is a no-op. Loops and hooks may call it freely.
- **Instruction sync is project-root only.** `eag instructions` or `doctor --fix` enrolls AGENTS.md and CLAUDE.md for bidirectional sync. Later edits to either sync on apply; status reports drift. If both differ, stop and inspect them before choosing `--prefer agents|claude`. MCP's `--prefer source|native` does not resolve instruction conflicts. Legacy `@AGENTS.md` imports become mirrored content. Additional Claude-only text stays outside marked shared-region comments; edit inside the region to share changes, and outside it for Claude-only changes. Damaged markers, circular imports, and symlinks stop sync without replacing files.
- **Claude Code user scope gets resolved values by default** (an app-launched agent has no shell
  environment). `eag apply` says so per secret. Terminal-only users can set
  `{"claude": {"secrets": "env"}}` in `~/.agents/agents.json` to keep references.
- **Codex needs one-time approvals** for a project (`.codex/config.toml` is ignored until the repo is
  trusted inside Codex) and for eag's launch hook (`/hooks` or Settings → Hooks). `eag doctor` says which.
- **Entries eag did not write are never touched.** Codex tables outside the marker block show as
  `foreign [locked]`; Claude's per-project "local" servers are reported, not managed — until
  `eag adopt claude --all-projects` moves them into the repo.

## Where things live

| path | what |
|---|---|
| `~/.agents/mcp.json`, `agents.json` | the source and its per-agent policy |
| `~/.agents/.state/<target>.json` | what eag wrote last time; the third leg of the merge |
| `~/.agents/.state/backup/` | the previous copy of every file eag rewrote |
| `~/.agents/shell-init.sh`, `~/.agents/bin/eag-sync` | sync-on-launch, from `eag hook install` |
| `~/.codex/config.toml` | eag owns only the `# >>> easy-agnostic managed >>>` block |
| `~/.claude.json` | never edited directly; only through `claude mcp add-json` / `remove` |
