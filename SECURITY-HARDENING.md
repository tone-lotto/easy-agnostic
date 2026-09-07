# Security and reliability hardening

Acceptance checklist for the active hardening work. Items are complete only after their failure cases are tested.

- [x] Sanitize config previews, inventory, parser errors, subprocess errors, and recovery instructions; include unindexed and environment-only credentials. Arbitrary embedded credentials remain a documented detection limit, not a universal secret-free-output claim.
- [x] Serialize MCP/source/secret mutations and refuse stale native writes; validate persisted state before using it. Non-cooperating external writers remain outside the lock guarantee.
- [x] Back up and recover failed Claude replacements without swallowing failures or losing ownership state. Failed rollback is explicit and retains recovery data.
- [x] Bound subprocess and network operations; refresh credentials when launching agents without exporting them to every shell child.
- [x] Validate server fields, policies, overrides, scope boundaries, and secret identifiers before writes.
- [x] Make upgrades explicit; validate versions, prevent concurrent installations at the same npm prefix, and report installation outcomes.
- [x] Review file permissions, backups, shell quoting, symlinks, and skill adoption failure paths.
- [x] Provide reproducible integration fixtures and CI; update documentation to match actual guarantees and limits. Remote workflow execution is tracked in the release gate below.
- [ ] Run regression tests, isolated end-to-end checks, package checks, and a final requirement-by-requirement review.

## Verified progress (2026-09-07, unreleased worktree)

- Routine apply no longer contacts the registry or installs updates, regardless of legacy autoUpdate settings.
- Explicit installs reject non-stable/non-exact package versions, disable lifecycle scripts, use a bounded subprocess, and acquire the mutation lock. Hook refresh failure is reported separately instead of silently running old fallback code.
- Registry timeout covers response-body reading. Invalid cached versions cannot trigger upgrades.
- Server field/transport checks, policy container/switch checks, and secret API identifiers are validated; corrupted secret indexes are rejected before set/delete.
- Lock regression tests cover nested calls, synchronous/asynchronous failure cleanup, and independent concurrent callers.
- 243 unit tests passed. Synthetic-config integration run passed (`e2e ok`); log: `/tmp/eag-hardening-9PLose/e2e-with-project.log`. The first run lacked a required project fixture; the corrected fixture includes a synthetic project server.
- Remaining gates include launch-scoped credentials, deeper override validation, resource/path race handling, credential-backend failures, reproducible committed integration fixtures, and release verification. No checklist item is considered complete merely because these narrower checks passed.
- Credential-store errors now fail closed; failed deletions preserve fallback credentials and tracking. Secret mutations also lock when called through the exported API. Linux backend discovery checks executable availability instead of relying on an unsupported version flag.
- Atomic writes use exclusive UUID temporary files and preserve unrelated legacy temporary paths; dangling config symlinks are refused. Codex checks expected contents immediately before replacement. Backups use exclusive unique filenames so same-timestamp creation does not overwrite an earlier backup.
- 248 unit tests passed after credential-backend and file-write regression additions. External-writer race limitations are explicitly documented in SECURITY.md.
- Codex overrides now pass native field validation before and after reference resolution; references resolved by overrides set the exact literal-permission marker. Invalid transports, header injection, non-boolean switches, invalid env pointers, and invalid timeouts are rejected.
- Latest verification: 249 unit tests pass; isolated end-to-end passes after the override changes (`/tmp/eag-hardening-9PLose/e2e-overrides.log`). Launch-scoped credentials and the broader remaining acceptance gates are still incomplete.
- Launch wrappers now resolve target-filtered credentials in a subshell on each invocation, with no reads/exports at shell startup. Missing credentials stop launch without emitting partial exports. Pi gets a credentials-only wrapper; Claude/Codex still sync first. Tracing is disabled before resolution and parent-shell variables remain unchanged.
- Shell paths and hook launcher paths use literal-safe quoting. Tests cover quoted/metacharacter paths and credentials, argument preservation, target/project filtering, refresh on repeated launch, missing credentials, and tracing under sh/bash/zsh.
- The shipped skill was narrowly updated using skill-creator guidance and passed quick_validate.py in an isolated uv environment with PyYAML. Integration passed with the launch changes (`/tmp/eag-hardening-9PLose/e2e-launch-env.log`). Existing terminals must be restarted to remove old inherited exports; agent children still inherit their agent's selected credentials.
- Skill adoption now reports both sides of global collisions, skips already-shared directory aliases, and restores agent-local directories when replacement linking fails. Duplicate copies are staged until linking succeeds. Regression tests cover these cases in addition to project-scoped recovery.
- `npm run e2e` now runs committed synthetic fixtures and fake native CLIs; `npm run e2e:live` retains optional real-native testing. GitHub Actions runs unit/integration/package checks on macOS/Linux with Node 20/22/24, read-only permissions, and commit-pinned actions. This workflow is implemented locally; remote CI execution remains a release gate.
- Git discovery uses the bounded subprocess helper. Hook-trust queries now kill hung children, handle stdin errors, clear their timer on every exit path, and cap buffered output; failure cases are tested.
- Latest local verification: 258 tests pass (`/tmp/eag-hardening-9PLose/tests-fixture-ci.log`) and fixture integration passes (`/tmp/eag-hardening-9PLose/e2e-fixture-ci.log`). Broader final acceptance and publication remain incomplete.
- Source and agent-policy writes now use the exact text captured at load time as a conditional-write baseline, under the mutation lock. Apply guards also recheck source/policy, native configuration, and state before writing. Tests prove stale edits survive without a backup or native write.
- Project scope resolves physical ancestors and refuses aliases of user source, policy, state, or Codex configuration. Source save helpers and project apply recheck scope before mutation, including aliases introduced after planning.
- Codex permission decisions now conservatively protect short literal headers/environment values/arguments and query credentials, not just token-shaped strings. Tightening preserves pre-existing read-only owner permissions.
- 263 tests and fixture integration passed after these changes (`tests-acceptance.log`, `e2e-acceptance.log` under `/tmp/eag-hardening-9PLose`). A subsequent focused test additionally verifies failed Claude rollback reporting, recovery snapshot retention, private backup availability, and sanitized output (`tests-rollback.log`). Final aggregate/package/remote/release gates still remain.

## 0.10.0 release candidate audit

- 266 unit tests pass; fixture integration passes. Logs: `/tmp/eag-hardening-9PLose/tests-release.log` and `e2e-release.log`.
- Installed tarball smoke passes for MCP sync, sanitized status, private files, bidirectional instructions, project-scoped skills, and the global-install branch with npm mocked. The latter verifies prefix-lock contention and disabled lifecycle scripts without modifying an actual installation.
- npm audit reports zero known dependency vulnerabilities. This is not an independent security certification.
- Package contents are limited to runtime code, shipped skill, README, changelog, license, and security documentation; no tests, local state, or credentials are packaged.
- Mutation lock tests additionally cover replaced-lock preservation and expired asynchronous ownership. Explicit installs serialize at their npm prefix across EAG_HOME configurations.
- Pending: final tarball after documentation changes, remote CI on the release commit, npm latest publication and read-back, GitHub release, and clean-worktree verification.
