# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/tone-lotto/easy-agnostic/security/advisories/new) on the repository, or e-mail the address on the maintainer's GitHub profile. Please do not open a public issue for anything that exposes credentials. Expect a first reply within a week.

## What this tool touches

`eag` reads and writes the files that configure your coding agents, and it handles the credentials those agents use. Concretely:

- **Secrets live in the OS store**, never in `mcp.json`. The source only ever holds `${NAME}`. Values go to the macOS keychain, `secret-tool` on Linux, or a `0600` `~/.agents/.secrets.env` when neither exists.
- **Codex is the one agent that can still get a literal.** Claude Code and Pi expand `${NAME}` from their own environment, so eag writes them the reference. Codex has no `${VAR}` expansion; it has env-var *fields* for a bearer token, HTTP headers and process env, and eag uses them, but a reference it cannot express as a pointer (a token embedded mid-string, an env var whose reference name differs from its key) is written as a resolved value into `config.toml`, and eag warns when it does.
- **Files that can carry a literal are `0600`**: the state snapshots and their backups, `.secrets.index`, `.secrets.env`, and a `config.toml` eag creates or whose managed block ends up carrying a credential. Modes are only ever tightened; a rewrite otherwise restores the file's own mode and follows a symlink rather than replacing it.
- **Nothing shown to a human carries a resolved value.** `eag apply --dry-run`, `eag status` and every error message print `${NAME}`. `eag secret set` does not echo what you type. The one command that does print values is `eag env`, because its whole job is to produce `export` lines — do not paste its output anywhere.
- **`eag env` puts secrets in your shell environment**, which means every process you start inherits them. That is what makes `${VAR}` work in Codex and Pi; it is a deliberate trade, not an accident.
- **No network, no telemetry, no daemon.** The only processes eag spawns are `claude`, `security`/`secret-tool`, `codex --version` and `git rev-parse`.

## Known limits

- `eag adopt` extracts credentials from headers and `env` only. A token embedded in a URL or in `args` stays in the source as you had it.
- `eag doctor` flags literal credentials by shape (common token prefixes, JWTs, long opaque strings, `user:password@` URLs) across headers, env and the URL. It is a heuristic and will miss unusual formats.
- On macOS the keychain has no way to accept a password on stdin, so `eag secret set` passes the value to `security` as an argument. It is visible in `ps` for the lifetime of that call.
- Project scope writes `.codex/config.toml` inside the repo, and it can contain literals. `eag init --project` adds it to `.gitignore`; check that it stayed there before committing.
