# Updates

Publishing a release does not change other people's computers. Existing users must
first install a release that includes this updater (0.13.0 or later), using
`eag update` or `npm install -g easy-agnostic@latest`. Then each user decides:

```sh
eag update auto on
eag update status
eag update status --json
eag update auto off
```

Automatic updates are **off by default**. Setup only displays these commands; it
does not grant consent. Agents must not enable this merely because a user asked
to sync a project, fix skills or install MCP servers. This is a user-level setting
in `$EAG_HOME/update-policy.json` (default `~/.agents/update-policy.json`), never a
project setting. Legacy `agents.json` `autoUpdate` booleans remain ignored.

## What happens after consent

Successful `eag apply` and `eag env` invocations may start a detached, short-lived
worker. Existing terminal wrappers and approved SessionStart hooks already invoke
these commands; Pi's credential wrapper is included. Help, status, errors and
dry-runs do not schedule maintenance. No daemon or timer is installed: a computer
that does not run EAG does not update, and publication is not immediate rollout.

The worker checks npm's `latest` at most daily, including after network failures.
Only a newer exact stable version in the consented **major.minor** line can enter
automatically: consent for 0.13.x allows 0.13.1, not 0.14.0 or 1.0.0. The package
must also explicitly declare the same `eagUpdate` protocol and compatibility epoch
with `automatic: true`. Missing or incompatible metadata reports `manual-required`.
Version numbers alone are not a guarantee of compatibility.

The archive must come from the fixed official npm registry URL and match its
SHA-512 integrity. Installation uses a fresh private prefix, disabled lifecycle
scripts, strict engine checks, isolated npm configuration/cache and a minimal
environment without inherited agent credentials. Installed metadata, the complete
dependency tree and isolated version/help smoke tests are checked before activation.
No global npm package files are overwritten in the background.

Activation changes a private atomic pointer only while no cooperating EAG command
is using a release and the mutation lock is free. If busy, the candidate remains
pending; another launch after at least a minute can activate it without downloading
again. Existing immutable release directories are preserved. The next EAG command
uses the selected version; an agent already open keeps its existing session/config.
Routine EAG sync rules still apply on later launches.

The worker never runs setup/apply, refreshes hooks, grants hook trust, shares skills,
enrolls MCP servers, or changes project scope. Releases that introduce permission
changes must not be marked automatic-compatible. Disabling consent during staging
prevents activation, including if consent is subsequently enabled again.

## Installation and recovery

- Global npm installs are supported. Linked development checkouts and npx caches
  never select or install managed runtimes. This feature does not update Claude,
  Codex, Pi, plugins or independently installed skills.
- `eag update auto off` stops future checks/activation; it does not downgrade the
  current version. A download already running may finish, but cannot be activated
  under revoked consent.
- `eag update` remains an explicit global npm update with hook refresh. A newer
  global baseline supersedes an older managed runtime. After moving to another
  version line, explicitly run `eag update auto on` to consent to that new line.
- Downloads/install/smoke failures preserve the previously selected version and
  appear in `eag update status`. Ordinary failed staging is cleaned up. A killed
  process can leave a staging directory or lock. Locks are not guessed away: first
  confirm no EAG process is running, inspect the exact lock under
  `$EAG_HOME/.state/updates/` (or `.state/mutation.lock`), then remove only that stale
  lock. Do not delete the whole `.agents` directory.
- Installed-tree corruption causes the dispatcher to use the global baseline and
  report a warning in update status. Import failure falls back only before a
  command starts; a partially executed command is never retried automatically.
- Active/previous receipts and immutable versions live under `.state/updates`.
  Earlier releases are retained, not automatically garbage-collected. For manual
  rollback, disable updates, stop EAG commands, back up the exact `active.json`
  pointer and remove only that pointer to select the global baseline. Retain the
  releases and receipts for diagnosis. EAG does not undo configuration changes that
  an explicitly run command already made.

## Trust limits and release discipline

Registry integrity detects mismatched bytes; it is not a publisher signature or a
malware audit. npm resolves dependencies from package specifications and verifies
their registry integrity. Package/registry compromise, malicious dependencies and
same-user filesystem tampering remain risks. Smoke-tested code runs with the user's
OS privileges, not in an OS sandbox. Choose automatic updates only if you trust
this distribution channel; use explicit updates otherwise.

Before publishing an automatically eligible patch, maintainers must review behavior
and dependencies, run unit and fixture tests, and verify a packed installation.
Do not expand skill targets, MCP scope, credential access or hook trust in an
automatic patch. Bump the compatibility epoch or set `automatic: false` when
existing consent is insufficient; use a new version line for incompatible changes.
The checked-in `eagUpdate` declaration is a release assertion, not independent proof.

Locks coordinate EAG processes sharing EAG_HOME, not arbitrary `npm install`
commands or external editors. If the brief activation gate is busy, launch can
fall back to the untouched global baseline rather than blocking the agent.
