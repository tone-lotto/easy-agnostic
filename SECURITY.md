# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/tone-lotto/easy-agnostic/security/advisories/new) on the repository, or e-mail the address on the maintainer's GitHub profile. Please do not open a public issue for anything that exposes credentials. Expect a first reply within a week.

## What this tool touches

`eag` reads and writes the files that configure your coding agents, and it handles the credentials those agents use. Concretely:

- **Secrets live in the OS store**, never in `mcp.json`. The source only ever holds `${NAME}`. Values go to the macOS keychain, `secret-tool` on Linux, or a `0600` `~/.agents/.secrets.env` when neither exists.
- **Where a resolved value ends up, and why.** Codex has no `${VAR}` expansion; it has env-var *fields* (`bearer_token_env_var`, `env_http_headers`, `env_vars`) and eag uses them, but a reference it cannot express as a pointer is written resolved into `config.toml`, with a warning and mode `0600`. Claude Code *can* expand `${VAR}`, but only from its own process environment: an agent launched from a desktop app or IDE on macOS gets the launchd environment, where your shell exports do not exist, so eag writes it resolved values by default. Terminal-only users can set `"claude": {"secrets": "env"}` in `agents.json` and keep credentials out of `~/.claude.json` entirely.
- **Files that can carry a literal are `0600`**: the state snapshots and their backups, `.secrets.index`, `.secrets.env`, and a `config.toml` eag creates or whose managed block ends up carrying a credential. Modes are only ever tightened; a rewrite otherwise restores the file's own mode and follows a symlink rather than replacing it.
- **Nothing shown to a human carries a resolved value.** `eag apply --dry-run`, `eag status` and every error message print `${NAME}`. `eag secret set` does not echo what you type. The one command that does print values is `eag env`, because its whole job is to produce `export` lines — do not paste its output anywhere.
- **`eag env` puts secrets in your shell environment**, which means every process you start inherits them. That is what makes `${VAR}` work in Codex and Pi; it is a deliberate trade, not an accident.
- **Network and subprocesses.** There is no telemetry or daemon. Update checks contact the npm registry; global installs can update automatically using npm unless `autoUpdate: false` or `EAG_NO_UPDATE=1` is set. eag also invokes the agent CLIs, OS credential tools, Git, and npm for configuration, diagnostics, installation, and updates.

## Known limits

- `eag adopt` extracts credentials from headers and `env` only. A token embedded in a URL or in `args` stays in the source as you had it.
- `eag doctor` flags literal credentials by shape (common token prefixes, JWTs, long opaque strings, `user:password@` URLs) across headers, env and the URL. It is a heuristic and will miss unusual formats.
- On macOS the keychain has no way to accept a password on stdin, so `eag secret set` passes the value to `security` as an argument. It is visible in `ps` for the lifetime of that call.
- Project scope writes `.codex/config.toml` inside the repo, and it can contain literals. `eag init --project` adds it to `.gitignore`; check that it stayed there before committing.
