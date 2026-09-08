# Agent integrations

EAG supports six agent identities: `claude`, `codex`, `pi`, `cursor`, `antigravity`, `opencode`.
The new three are **off by default**, including after an update. MCP enrollment, skill compatibility,
skill target permission, hook installation and native application trust are separate decisions.
Installing an application is not permission to share anything with it.

## Capability matrix

| Capability | Cursor | Antigravity | OpenCode |
|---|---|---|---|
| MCP user / project | JSON/JSONC adapter | current config profile | JSON/JSONC, v1 / v2 |
| Adopt / drift / conflicts | supported | supported | supported |
| Reviewed skill links | `.cursor/skills` | `.agent/skills` project, native user folder | `.opencode/skills` |
| Shared instructions | native `AGENTS.md` | explicit project rule import | native `AGENTS.md` |
| Optional native trigger | `sessionStart` | `PreInvocation` | `session.created` plugin |
| History | local export import | local export import | local JSON export import |

Tests exercise adapter fixtures and real EAG CLI subprocesses in isolated directories. This is not
proof that an authenticated vendor app executed a hook, reloaded MCPs or selected a rule. EAG does
not grant native trust, copy OAuth accounts, install vendor apps or start paid model requests.

## Scope and enrollment

```sh
eag agents ls --scope project --json
eag agents enable cursor --scope project --dry-run
eag agents enable cursor --scope project
eag apply --scope project --target cursor --dry-run
eag apply --scope project --target cursor
```

Replace `cursor` with `antigravity` or `opencode`. Start with `eag init --project` if you need a new
source; use `eag adopt AGENT --scope project --dry-run` to inspect native-only entries. Adoption
does not enable a new target. Unsupported native policy/OAuth fields are preserved and skipped,
not silently discarded. `mcp target NAME AGENT off` excludes one source server.

User enrollment authorizes user sync and is inherited by project policy unless overridden, but
project servers are rendered only into project files, never promoted to user scope. Use explicit
`--scope project` for repository-only permission. `agents disable` stops further sync but retains
native entries: it is not an MCP disconnect command. Remove owned source servers and apply while
enabled if you intend to remove them; preserve foreign entries.

`agents ls --scope project --json` reports effective enrollment and labels inherited switches.
Per-server project overrides preserve other receivers' inherited restrictions. An explicit
`mcp target NAME AGENT on --scope project` overrides that agent's inherited off switch only.

| Agent | User MCP destination | Project MCP destination |
|---|---|---|
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Antigravity current profile | `~/.gemini/config/mcp_config.json` | `.agents/mcp_config.json` |
| OpenCode | `~/.config/opencode/opencode.json` or `.jsonc` | `opencode.json` or `.jsonc` |

EAG path overrides: `CURSOR_CONFIG_DIR`, `ANTIGRAVITY_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`; OpenCode
also follows `XDG_CONFIG_HOME`. These redirect EAG, not necessarily the vendor application. Configure
both consistently. Older Antigravity releases using `~/.gemini/antigravity` are not silently migrated;
upgrade or explicitly select and verify the correct user directory. The current project profile is
not a compatibility claim for old IDE versions.

OpenCode defaults to v1 for a missing config and detects existing `mcp.servers` v2 layouts. Use
`eag agents enable opencode --scope project --mcp-format v2` for a new v2 config. EAG refuses a
profile mismatch or simultaneous `.json` and `.jsonc`; it does not guess precedence or migrate
between versions. Unknown fields and JSONC comments remain intact.

Native files can contain credentials and are written `0600`. Keep them and `.agents/.state/` out
of Git; `init --project` lists/adds ignore entries. Cursor environment mode uses `${env:NAME}`;
OpenCode uses `{env:NAME}`. Antigravity uses resolved values, not an unverified interpolation syntax.
Antigravity stdio `cwd` uses a fixed shell bridge with arguments passed separately, never interpolated.

## Skills and instruction boundaries

`skills share` accepts all six identities, but requires reviewed `--compatible`, authorized `--to`
and explicit scope. It does not translate provider-specific tools. Antigravity's supported legacy
`.agent/skills` location avoids using the shared `.agents/skills` directory as its private target.

Cursor also discovers Claude/Codex skill locations; OpenCode also discovers Claude's. When these
receivers are known locally, EAG refuses managed links unless the indirect receivers are approved
too. Later discovery suspends affected owned links, preserving library sources. `skills ls --json`
reports `alsoDiscoverableBy`; doctor warns about native exposure. Never approve an incompatible
receiver just to suppress a warning. Unowned files and application discovery behavior remain outside
EAG's control. This is not a filesystem sandbox. See [skill policy](skills.md).

Cursor and OpenCode read `AGENTS.md` natively; the existing `eag instructions` shared-region sync
still works. For Antigravity, first establish the intended shared `AGENTS.md`, then:

```sh
eag instructions --target antigravity --dry-run
eag instructions --target antigravity
```

Select **Always On** for `.agent/rules/eag-project.md` in Antigravity workspace customization. The
rule imports `@../../AGENTS.md`; it does not copy global instructions or Claude-only text. EAG does
not invent undocumented activation metadata. `--remove` removes only an unchanged owned rule and
keeps a private backup. A modified/unowned rule is a conflict, not permission to overwrite it.

## Launch synchronization

```sh
eag hook install --target cursor --scope project --dry-run
eag hook install --target cursor --scope project
eag hook status --target cursor --scope project --json
eag run cursor --binary agent -- [arguments]
```

Each native hook requires its own target/scope enrollment. Cursor uses `.cursor/hooks.json`,
Antigravity `.agents/hooks.json`, OpenCode `.opencode/plugins/eag-sync.js`; user equivalents are
under their config directories. Other hooks/plugins are preserved, and uninstall removes only
unchanged owned content. Antigravity runs before model invocations, not just session start.
If ownership recording fails, EAG restores its exact native write; a concurrent edit prevents
rollback rather than being overwritten. Backups remain available for manual recovery.
Hooks collect no transcripts. Session-triggered sync may require a restart/MCP reload to affect
an already-open session. A configured hook is not verified execution.

The standard shell integration wraps installed `cursor-agent`, `agy`, `opencode` binaries. Modern
Cursor's generic `agent` command is never hijacked: use the explicit `eag run ... --binary agent`
launcher. It syncs before launch, stops on sync/secret errors, forwards arguments without a shell
and injects only the selected agent's referenced credentials. Existing inherited environment
variables are not a sandbox; restart shells with stale globally exported secrets.

## Local history, only on demand

Export an existing conversation using its vendor's supported export UI/CLI. For OpenCode, use
`opencode export SESSION_ID` to a private file. EAG does not run that command or start a new model
session. Then import the selected file:

```sh
eag history import opencode --file /private/path/export.json --project /absolute/repo --dry-run
eag history import opencode --file /private/path/export.json --project /absolute/repo
eag history search "topic" --vendor opencode --project /absolute/repo
```

Cursor/Antigravity accept visible-role JSON/JSONL and Markdown with User/Assistant headings. Without
recorded project metadata, the user must inspect the export and explicitly add `--bind-project`;
EAG labels this **user-attested**, not metadata-verified. Recorded mismatches cannot be rebound.
OpenCode sanitized exports that replace the project directory must not be falsely rebound.

Imported receipts are private, redacted heuristically, stored locally and filtered by exact project.
Reasoning/system prompts/images are omitted; supported tool records require `--tools`. No native
database scraping, hidden-log decryption, cloud history, passive capture, transmission or replay.
Export-only support is deliberately distinct from Claude/Codex/Pi native local discovery. See
[history safety and pagination](history.md).

## Upstream contracts checked 2026-09-08

- Cursor: [MCP](https://cursor.com/docs/mcp), [skills](https://cursor.com/docs/skills), [hooks](https://cursor.com/docs/hooks), [rules](https://cursor.com/docs/rules), [CLI](https://prod.cursor.com/help/integrations/cli).
- Antigravity: [MCP](https://www.antigravity.google/docs/mcp), [skills](https://www.antigravity.google/docs/skills), [hooks](https://www.antigravity.google/docs/hooks), [rules](https://www.antigravity.google/docs/rules-workflows/), [CLI install](https://www.antigravity.google/docs/cli/install/).
- OpenCode: [MCP v1](https://opencode.ai/docs/mcp-servers), [MCP v2](https://opencode.ai/v2/docs/mcp-servers), [skills](https://opencode.ai/docs/skills), [plugins](https://opencode.ai/docs/plugins), [CLI export](https://opencode.ai/docs/cli).
