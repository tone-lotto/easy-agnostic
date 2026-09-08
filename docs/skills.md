# Skill isolation and explicit sharing

All six agent identities are supported. Cursor's native discovery can include Claude/Codex
folders, and OpenCode's can include Claude folders. EAG requires approval for known indirect
receivers before creating managed links, and reports native exposure without deleting unowned
files. Installing an additional receiver may suspend previously approved owned links until
review. See the [new agent integration guide](agents.md#skills-and-instruction-boundaries).

Since 0.12.0, installing a personal skill in one agent is **not** permission to share
it with another. `setup`, `adopt skills`, `doctor --fix` and launch hooks no longer
move or link unreviewed personal skills. `adopt skills` is a diagnostic-only legacy
command. MCP and instruction-sync behavior is unchanged.

## Three independent decisions

- **Scope:** `--scope project` operates only in the selected project; `--scope user`
  intentionally makes a skill available to the selected agents across projects.
  Mutating skill commands require an explicit scope. Listing defaults to user scope.
- **Compatibility:** `--compatible codex,claude` records your review that the skill's
  instructions, scripts and tools work in those agents. Unknown compatibility is
  not approved. This declaration is not an automated portability test.
- **Permission:** `--to codex` selects the agents actually allowed to discover the
  skill. A compatible agent does not receive it unless also authorized.

Review the whole skill, including scripts, references, external tools, accounts and
dependencies, before setting these flags. Do not infer permission from a SKILL.md,
its name, its presence on disk, or a request to repair one missing skill. Native
system skills, plugin caches, plugin manifests and vendor-managed skills stay with
their provider; install the provider's own equivalent separately when appropriate.

## Commands

```bash
eag skills ls --scope project --json

# After reviewing a personal project skill currently owned by Codex:
eag skills share research --scope project --from codex \
  --to codex,claude --compatible codex,claude --dry-run
eag skills share research --scope project --from codex \
  --to codex,claude --compatible codex,claude

# Change an enrolled skill: default --from is library.
eag skills share research --scope project --to codex --compatible codex

# Declare required native skills (repeat the flag for more dependencies).
eag skills share research --scope project --to claude --compatible claude \
  --requires claude:browser-use

eag skills sync --scope project --dry-run --json
eag skills sync --scope project

# Revoke all EAG-managed links; keep the source for later recovery/review.
eag skills share research --scope project --to none --compatible none
```

`share` replaces the named skill's complete policy; always supply all intended
targets, compatible agents and dependencies. `--requires` is a list of required
**skills**, not executable names, MCP connection tests or permission grants. EAG
checks same-scope native skill files (and Codex system skills), and recursively
validates enrolled dependencies. Missing dependencies and cycles fail closed.
Plugin-only or inherited dependencies that cannot be resolved conservatively must
be reviewed separately; do not invent a local placeholder to bypass the check.
No skill, script, provider or tool is executed to test compatibility.

`share` exits 0 on success and 1 on invalid input, missing dependency or a conflicting
source/destination. `sync` exits 3 for conflicts, 2 for blocked/unreviewed entries,
and 0 otherwise. Previews make no filesystem changes. Normal `apply` also reconciles
enrolled skills, reports blocked entries as warnings and preserves its existing
MCP/instruction exit-code contract. `--scope` and `--target` constrain those writes.

## Storage and ownership

Sources live in `~/.agents/skill-library/NAME` or
`PROJECT/.agents/skill-library/NAME`. Links are created only in the authorized
agent directories: `.claude/skills`, `.codex/skills`, or `.pi/skills` (user Pi uses
`~/.pi/agent/skills`). Relative links keep project packages portable. Per-skill
policy lives under `skills` in the corresponding `agents.json`; unrelated MCP
policy is preserved. Private `.state/skills.json` records which links EAG owns.

Why not store restricted sources in `.agents/skills`? Both Codex and Pi discover
that directory without consulting EAG policy. A target flag cannot hide a skill
that the vendor loads independently. The installed Codex CLI's `skills/list` was
also checked with isolated fixtures to verify `.codex/skills` project/user discovery.
See [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills),
[Claude skill discovery](https://code.claude.com/docs/en/skills#where-skills-live)
and the installed Pi package's `docs/skills.md` for native discovery behavior.

Approval includes a SHA-256 fingerprint of the entire source tree, including
scripts and executable bits. Changed content invalidates approval at the next
sync, which removes only unchanged owned links; review and run `share` again to
reapprove it. Missing declared dependencies similarly suspend affected links.
The library content is preserved. Independent copies, edited destinations and
unowned links are never overwritten or deduplicated, even if their bytes match.

For a fresh clone, commit the library and policy, not `.state`. Run `skills sync`
to create missing links. Existing committed links without local ownership are
reported as unowned; do not commit generated links if you want EAG to manage them
automatically on other machines.

## Migration from older EAG versions

Legacy `.agents/skills` content and links are **not automatically removed**: older
versions did not record sufficient provenance or per-agent consent. They remain
discoverable under native rules and are reported as requiring review.

For each reviewed skill, explicitly choose scope and permitted agents:

```bash
eag skills share my-skill --scope user --from shared \
  --to codex --compatible codex --dry-run
# After reviewing the preview, repeat without --dry-run.
```

This moves only that source into the neutral library, replaces exact links to that
source for allowed agents, and removes exact old links for excluded agents. Broken
links, independent copies, symlinked source folders and vendor-owned skills stop
migration. There is no bulk approval or automatic project-to-user promotion.
`--from claude|codex|pi|cursor|antigravity|opencode` similarly enrolls one agent-local directory; `--from library`
is for policy changes or reapproval. Cross-device moves fail without deleting data.

## Security boundaries and recovery

This is **discovery/configuration isolation, not an OS sandbox**. An agent with
filesystem access can still read the library explicitly. Custom vendor discovery
settings, manually added links, other tools scanning directories, plugins and
already-running sessions are outside EAG's control. Restart/reload agents after
changing visibility. EAG cannot guarantee arbitrary natural-language instructions
or undeclared dependencies are compatible. It does not grant tool permissions.

Sources with internal symlinks, hardlinks, special files, plugin markers or oversized
trees are refused (32 MiB, 4096 entries, 24 levels). Scope/directory aliases and
modified links stop writes. Ordinary failures roll back completed operations.
A killed process may leave the source in the library, partial links, or a stale
mutation lock. Inspect library content, `agents.json`, `.state/skills.json` and the
reported paths before recovering; never blindly delete the source or claim ownership
of existing links. Same-user hostile races are not an OS-level security boundary.

The shipped `eag` skill is a deliberate exception: explicitly installing EAG's hooks
installs its own portable help skill. It never authorizes other skills or plugins.
