# On-demand conversation history

`eag history` retrieves local conversation evidence for the current project. It does not run a
vendor SDK, start an agent, call an API, build a global index, copy vendor histories, or read
credentials from the keychain. Nothing runs automatically at agent startup.

## Search, inspect, hand off

```sh
eag history list
eag history search "DataForSEO" --vendor claude --json
eag history read claude SESSION_ID --offset 10 --limit 10 --tools --json
eag history handoff claude SESSION_ID --to codex --tools
eag history handoff claude SESSION_ID --to pi --output /private/tmp/research-handoff.md
```

Commands may be run by any agent that can execute `eag`. `--to` is only a recipient label:
there is **no transmission or automatic replay**. Review the handoff before attaching it to a
new conversation or giving it to another provider. Original logs are never modified. A handoff
file is created with mode `0600` and exclusive creation; an existing file or symlink is refused.
No parent directory is automatically created. Keep handoffs out of Git and delete them when no
longer needed. They may contain confidential information despite heuristic redaction.

Default scope is the exact canonical working directory recorded by the vendor, using the
current Git root (or current directory outside Git) as the selection. Subdirectories, nested
repositories, other worktrees, and other projects are not implicitly included. Use
`--project /explicit/project/path` to select one. For moved/deleted projects, the explicitly
selected old path need not exist; no automatic old-to-new project mapping is guessed. There
is no `--all-projects` or global-history mode.

Search is a literal, case-insensitive match on **redacted** text, not a regex or remote semantic
search. Results include vendor, session ID, file, source line, event index and a short excerpt.
Use an exact ID from those results. Duplicate IDs require `--file` to select the exact source.
Search/list order is most recently modified session first. Search offsets refer to matching
events; read offsets refer to supported events. Keep `--tools` consistent when using an event
index from search to read.

Read starts at event zero. Handoff defaults to the most recent 20 supported events, not an
invented summary of the whole conversation. Both accept an explicit `--offset`. All record
text is quoted and labeled `user`, `assistant`, `tool_call`, `tool_result`, or `summary`.
Assistant messages and summaries are claims, not verified facts. Tool results are recorded
observations, not proof that the same state still holds. A snapshot SHA-256 and JSONL line
numbers support provenance; neither authenticates a vendor or proves a log was not edited.

For long transcripts use `--limit` (1–100) and `--max-chars` (256–64000). Follow `nextOffset`
and `nextCharOffset` with `--offset N --char-offset N` to continue within a clipped event.
These positions are stable only for the same snapshot and the same `--tools` setting.

## Supported sources

| Adapter | Default location | Visible records |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/` (default `~/.claude/projects/`) | User/assistant text; opt-in tool use/results |
| Codex | `$CODEX_HOME/sessions/` and `archived_sessions/` (default `~/.codex/`) | `session_meta`, visible `response_item` messages/calls/results, compaction summaries; duplicate event notifications omitted |
| Pi | `$PI_CODING_AGENT_DIR/sessions/` (default `~/.pi/agent/sessions/`) | Session formats 1–3, visible messages, opt-in tools, branch/compaction summaries |
| Explicit export | `--file PATH --vendor export` for list/search, or `read export ID --file PATH` | The small interchange schema below |

Claude/Pi discovery uses the matching project directory when present and verifies metadata;
otherwise it scans immediate project directories within fixed limits. Nested subagent logs
and external tool-result files are not followed. Select a nested transcript explicitly with
`--file` if needed; it still must contain supported project/session metadata. Codex discovery
checks metadata rather than guessing a project from date-based filenames.

Claude/Pi branch IDs and parent IDs are preserved in JSON/handoffs. Events remain in append
order, including abandoned branches. This is **not** a reconstruction of the active branch or
the vendor's exact resumed context. Images, audio, hidden reasoning, developer/system prompts,
telemetry and unknown record kinds are omitted. Missing metadata/unsupported formats, malformed
JSONL, cross-directory records and scan limits produce warnings; absence is not evidence that
no previous conversation exists. Vendor formats are implementation details and can change.

## Export from another tool

Provide a UTF-8 JSONL file yourself; eag does not silently connect additional accounts:

```jsonl
{"type":"eag-history","version":1,"id":"research-001","cwd":"/absolute/project/path","timestamp":"2026-09-08T12:00:00Z"}
{"type":"message","kind":"user","text":"Compare research providers"}
{"type":"message","kind":"assistant","text":"Provider A might be cheaper"}
{"type":"message","kind":"tool_result","callId":"test-1","tool":"search","text":"Recorded test cost exceeded the estimate"}
```

```sh
eag history read export research-001 --file /private/tmp/export.jsonl --tools --project /absolute/project/path
```

Allowed kinds are `user`, `assistant`, `summary`, `tool_call`, and `tool_result`; the latter two
require `--tools`. `id` is 1–128 ASCII letters, digits, underscores or hyphens. This export is
user-provided evidence, not authenticated vendor history. Normal vendor files can also be
selected with `--file`, without importing or copying them.

## Limits and threat model

- 32 MiB per full transcript; 2 MiB per JSONL record; metadata must appear within the first
  256 KiB. Oversized full files fail; oversized/malformed records are omitted with warnings.
- Each request has separate 128 MiB metadata/content budgets, a 15-second cooperative
  deadline, depth limits, and directory-entry limits. Blocking filesystem operations are not
  an OS-enforced deadline. Partial discovery/search is reported, never called exhaustive.
- Symlinked transcript files, hard links and non-regular files are refused. Discovery does
  not traverse directory symlinks; containment is rechecked before opening. Selected store
  roots are trusted. Concurrent hostile changes by the same OS user are outside the guarantee.
- Common credential assignments, known token formats, private keys, URL credentials/query
  values and structured secret fields are masked **before** searching or clipping. No raw mode
  is available. Arbitrary credentials, encoded secrets, personal data and business information
  can evade redaction. Terminal control sequences are removed. Do not assume output is safe
  for public posting or for automatic forwarding.
- Project metadata is a scope filter, not an OS access-control boundary. Historical content
  can mention other projects or quote confidential material. Treat it as untrusted data and
  recheck scope, facts and permissions before acting. Quoting cannot make prompt injection
  impossible; the receiving agent must enforce the instruction boundary.

## Source references and verification

- [Claude session storage](https://code.claude.com/docs/en/agent-sdk/sessions) documents local
  project JSONL logs and session APIs. This implementation reads files, avoiding an SDK that
  could initialize or migrate session state.
- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) documents returning to saved local chats.
  The adapter's JSONL details were verified against local `session_meta`/`response_item` records;
  they are not claimed to be a stable public export API.
- Pi's installed `@earendil-works/pi-coding-agent/docs/session-format.md` documents its JSONL
  header, message types and branch structure; [upstream source](https://github.com/earendil-works/pi-mono).

Tests use synthetic logs for all adapters and verify scope refusal, redaction, provenance,
pagination, broken records, duplicate IDs, read-only behavior and private/exclusive handoff
files. Live compatibility checks should report only metadata/counts, not private transcripts.
