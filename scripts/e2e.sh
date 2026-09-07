#!/usr/bin/env bash
# End-to-end run against a sandbox built from copies of your real configs
# (~/.claude.json and ~/.codex/config.toml, or $CLAUDE_CONFIG_DIR / $CODEX_HOME).
# Nothing under $HOME is touched. Those copies may contain literal credentials, so:
#   - the sandbox is created with umask 077 and must be outside this repository,
#     not "/" or $HOME, and either absent or a directory this script created
#     (marker file .eag-sandbox); anything else is refused, never deleted;
#   - only mcpServers (user and per-project) plus the two onboarding flags are copied
#     out of ~/.claude.json, not the account, telemetry or per-project state it carries;
#   - keychain entries use the service "eag-test" and are removed on exit;
#   - the sandbox is deleted on exit unless KEEP_SANDBOX=1 (manual scenarios); the
#     eag-test secrets are removed either way, so set them again before an apply there.
# EAG_PROJECT is unset and every agent path is redirected, including the shell rc doctor
# reads (EAG_SHELL_RC), so nothing outside the sandbox is read or written.
#
# Usage: scripts/e2e.sh [sandbox-dir]              (default /tmp/eag-sandbox)
#        KEEP_SANDBOX=1 scripts/e2e.sh /tmp/eag-sandbox
set -euo pipefail
umask 077
unset CDPATH   # keep `cd` inside $(...) from searching CDPATH and echoing the result

case "${1:-}" in -*) echo "usage: $0 [sandbox-dir]" >&2; exit 2;; esac

# Absolute, symlink-resolved path without creating anything (resolve the deepest existing ancestor).
abspath() {
  local p="$1" rest="" base out
  while [ ! -d "$p" ]; do
    base="$(basename -- "$p")" || return 1
    p="$(dirname -- "$p")" || return 1
    [ -n "$base" ] && [ -n "$p" ] || return 1
    rest="/$base$rest"
  done
  base="$(cd "$p" && pwd -P)" || return 1   # errexit does not apply inside $(...): fail here
  case "$base" in //*) base="${base#/}";; esac   # bash keeps a POSIX leading "//"; collapse it
  [ "$base" = / ] && base=""
  out="$base$rest"; printf '%s\n' "${out:-/}"
}
REPO="$(cd "$(dirname -- "$0")/.." && pwd -P)"
H="$(abspath "$HOME")"
S="$(abspath "${1:-/tmp/eag-sandbox}")"
case "$S" in
  "$REPO"|"$REPO"/*) echo "refusing: sandbox $S is inside the repository $REPO" >&2; exit 1;;
  /|"$H"|*/.|*/..|*/./*|*/../*) echo "refusing: sandbox must be a dedicated directory, not $S" >&2; exit 1;;
esac
if [ -e "$S" ] && [ ! -f "$S/.eag-sandbox" ]; then
  echo "refusing: $S exists and is not an eag sandbox (delete it yourself if that is what you want)" >&2; exit 1
fi

# Read the real configs from where the agents (and src/paths.js) look for them,
# before the env vars below are pointed at the sandbox.
SRC_CLAUDE="${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"
SRC_CODEX="${CODEX_HOME:-$HOME/.codex}/config.toml"
for f in "$SRC_CLAUDE" "$SRC_CODEX"; do
  [ -f "$f" ] || { echo "missing $f: the e2e run is built from copies of your real Claude Code and Codex configs" >&2; exit 1; }
done
command -v claude >/dev/null 2>&1 || { echo "missing claude CLI on PATH: init enables the Claude target from it, and the run asserts the redacted Claude dry-run" >&2; exit 1; }

unset EAG_PROJECT   # project scope must resolve from cwd ($S/proj), never from the developer's shell
export EAG_HOME="$S/agents" CLAUDE_CONFIG_DIR="$S/cc" CODEX_HOME="$S/codex" PI_CODING_AGENT_DIR="$S/pi" EAG_SECRET_SERVICE=eag-test
export EAG_SHELL_RC="$S/shellrc"   # doctor checks the `eval "$(eag env)"` line here, not in your real rc
BIN="$REPO/bin/eag.js"
A() { node "$BIN" "$@"; }
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

# Remove every eag-test secret adopt stored (index lives in the sandbox) and say so if any survived.
remove_secrets() {
  local idx="$EAG_HOME/.secrets.index" n left=""
  [ -f "$idx" ] || return 0
  for n in $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).join("\n"))' "$idx"); do
    A secret rm "$n" >/dev/null 2>&1 || true
    if [ "$(uname -s)" = Darwin ] && security find-generic-password -s "$EAG_SECRET_SERVICE" -a "$n" >/dev/null 2>&1; then left="$left $n"; fi
  done
  [ -z "$left" ] || echo "warning: keychain items still present under service $EAG_SECRET_SERVICE:$left (remove with: security delete-generic-password -s $EAG_SECRET_SERVICE -a <NAME>)" >&2
}
cleanup() {
  remove_secrets
  if [ "${KEEP_SANDBOX:-}" = 1 ]; then
    printf 'sandbox kept at %s (holds copies of your real configs; delete with: rm -rf %q)\n' "$S" "$S"
  else
    rm -rf "$S"
  fi
}
trap cleanup EXIT

# A previous run killed before its trap (SIGKILL, crash) leaves its eag-test items
# behind and its index in the old sandbox: remove them before wiping it.
remove_secrets
rm -rf "$S"; mkdir -p "$S/cc" "$S/codex" "$S/agents" "$S/pi" "$S/proj"
: > "$S/.eag-sandbox"
: > "$S/shellrc"   # empty: doctor must report the missing `eval "$(eag env)"` line, not read yours
# Only what eag and `claude mcp` read from ~/.claude.json: mcpServers, projects[*].mcpServers
# and the onboarding flags. The rest (oauthAccount, machineID, allowedTools, caches) stays home.
node -e '
const fs = require("fs"), o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = { mcpServers: o.mcpServers || {}, projects: {} };
for (const k of ["hasCompletedOnboarding", "lastOnboardingVersion"]) if (k in o) out[k] = o[k];
for (const [root, p] of Object.entries(o.projects || {})) if (p.mcpServers && Object.keys(p.mcpServers).length) out.projects[root] = { mcpServers: p.mcpServers };
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$SRC_CLAUDE" "$S/cc/.claude.json"
cp "$SRC_CODEX" "$S/codex/config.toml"
# A table outside the (not yet created) managed block is "locked": eag must read it for
# comparison and never edit it, on every scope and every apply.
printf '\n[mcp_servers.eag-e2e-locked]\nurl = "https://locked.example.com/mcp"\n' >> "$S/codex/config.toml"
printf '{"mcpServers":{"demo":{"type":"http","url":"https://example.com/mcp"}}}\n' > "$S/proj/.mcp.json"
: > "$S/proj/.gitignore"   # present, so `init --project` takes the append path
(cd "$S/proj" && git init -q)
cd "$S/proj"

A init; A adopt claude
A adopt codex | tee "$S/adopt-codex.txt"
grep -q 'eag-e2e-locked is managed outside eag in Codex' "$S/adopt-codex.txt" || { echo "FAIL: adopt codex did not report eag-e2e-locked as locked" >&2; exit 1; }

# Your real configs may already reference ${NAME}s whose values live in your real secret
# store, not under the eag-test service this run uses; adopt has no literal to extract from
# a reference. Give every still-unresolved reference a placeholder so the run exercises the
# write paths instead of stopping on a missing secret that is not what it is testing.
# (`eag env` prints "# NAME: not set" for exactly those.)
for n in $(A env | sed -n 's/^# \([A-Za-z_][A-Za-z0-9_]*\): not set.*/\1/p'); do
  printf 'e2e-placeholder-for-%s' "$n" | A secret set "$n" >/dev/null
done
A status

# A server with a secret reference that neither agent has yet, so the dry-run below has
# a create for Claude (adopt leaves the adopted entries in sync, hence no command for them).
E2E_VALUE='e2e-demo-secret-value-0123456789'
A mcp add e2e-demo --url https://example.com/e2e --header 'Authorization: Bearer ${E2E_DEMO_TOKEN}'
printf %s "$E2E_VALUE" | A secret set E2E_DEMO_TOKEN

# Dry-run output is what people paste into issues: it must show ${NAME}, never a resolved value.
A apply --dry-run | tee "$S/dry-run.txt"
grep -q 'add-json e2e-demo' "$S/dry-run.txt" || { echo "FAIL: dry-run shows no claude command for e2e-demo" >&2; exit 1; }
grep -q '\${E2E_DEMO_TOKEN}' "$S/dry-run.txt" || { echo "FAIL: dry-run does not show the \${E2E_DEMO_TOKEN} reference" >&2; exit 1; }
grep -q "$E2E_VALUE" "$S/dry-run.txt" && { echo "FAIL: dry-run output contains the resolved value of E2E_DEMO_TOKEN" >&2; exit 1; }
node -e '
const fs = require("fs"), out = fs.readFileSync(process.argv[1], "utf8");
const env = require("child_process").execFileSync("node", [process.argv[2], "env"], { encoding: "utf8" });
for (const m of env.matchAll(/^export (\w+)=\x27((?:[^\x27]|\x27\\\x27\x27)*)\x27$/gm)) {
  const v = m[2].replace(/\x27\\\x27\x27/g, "\x27");
  if (v && out.includes(v)) { console.error(`FAIL: dry-run output contains the value of ${m[1]}`); process.exit(1); }
}
' "$S/dry-run.txt" "$BIN"

# First apply under a normal umask: the sandbox umask (077) would hide a regression in the
# modes eag asks for. config.toml was copied 0600 and must stay 0600 through the temp+rename
# rewrite; its backup and the state snapshots (which hold rendered literals) must be 0600.
# apply_u/apply_s below, used wherever a bare "A apply"/"A status --exit-code" used to be:
# your real Codex config can carry a locked entry whose name the `claude` CLI itself
# refuses (reserved) — nothing eag can fix — and that must not abort the run. It never
# masks a regression in this run's own e2e-* fixtures: their names are checked in the
# same output, and a write failure or drift touching one fails the run right here.
check_no_e2e_failure() {
  echo "$1" | grep -qE 'failed +e2e-' && { echo "FAIL: $2 failed to write one of this run's own e2e-* entries:" >&2; echo "$1" >&2; exit 1; }
  return 0
}
# Note the "|| true" on the assignment itself, not just the call: under set -e, "var=$(cmd)"
# aborts the script right there if cmd's exit status is nonzero, before the echo/check below
# ever runs (a plain "cmd || true" would not save it — the failure is inside the assignment).
apply_u() { local out; out="$(umask 022; A apply "$@")" || true; echo "$out"; check_no_e2e_failure "$out" "apply $*"; }
apply_s() { local out; out="$(A apply "$@")" || true; echo "$out"; check_no_e2e_failure "$out" "apply $*"; }

apply_u
A status --scope user --exit-code || true
apply_s   # idempotent
# A resolved ${NAME} that looks nothing like a credential must still tighten the file:
# the mode comes from render()'s own signal, not from guessing at the value's shape.
A mcp add e2e-lit --url https://example.com/lit --header 'X-Api-Key: v1-${E2E_LIT_TOKEN}'
printf %s 'hunter2' | A secret set E2E_LIT_TOKEN
chmod 644 "$CODEX_HOME/config.toml"
apply_u
[ "$(mode "$CODEX_HOME/config.toml")" = 600 ] || { echo "FAIL: config.toml carrying a resolved literal was left $(mode "$CODEX_HOME/config.toml"), expected 600" >&2; exit 1; }

# A hand edit inside the managed block is a conflict, and --prefer native must keep it:
# the snapshot has to record the native entry, not the source one it just chose against.
node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("https://example.com/lit","https://example.com/edited-by-hand"))' "$CODEX_HOME/config.toml"
if A status --scope user --exit-code >/dev/null; then echo "FAIL: a hand edit in the managed block was not reported as drift" >&2; exit 1; fi
apply_s --prefer native
grep -q 'edited-by-hand' "$CODEX_HOME/config.toml" || { echo "FAIL: --prefer native overwrote the hand edit" >&2; exit 1; }
grep -q 'edited-by-hand' "$EAG_HOME/.state/codex-user.json" || { echo "FAIL: --prefer native did not record the native entry in the snapshot" >&2; exit 1; }
apply_s --prefer source   # put the source version back for the rest of the run
grep -q 'edited-by-hand' "$CODEX_HOME/config.toml" && { echo "FAIL: --prefer source did not restore the source entry" >&2; exit 1; }

# Nothing left to write, but the block still carries a literal: a file widened since the
# last apply must be tightened again rather than silently left world-readable.
chmod 644 "$CODEX_HOME/config.toml"
apply_u
[ "$(mode "$CODEX_HOME/config.toml")" = 600 ] || { echo "FAIL: a widened config.toml carrying a literal was left $(mode "$CODEX_HOME/config.toml") by a no-op apply" >&2; exit 1; }

(umask 022; A init --project; A apply --scope project)   # a config.toml eag creates starts 0600
A doctor | tee "$S/doctor.txt" || true
grep -q 'e2e-demo: literal credential' "$S/doctor.txt" && { echo "FAIL: doctor flags the \${NAME} reference of e2e-demo as a literal" >&2; exit 1; }
# The run must have produced all of these; a mode check that silently skips a missing
# file would let "stopped writing it at all" pass as green.
for f in "$CODEX_HOME/config.toml" "$EAG_HOME/.state/claude-user.json" "$EAG_HOME/.state/codex-user.json" \
         "$S/proj/.codex/config.toml" "$S/proj/.agents/.state/codex-project.json"; do
  [ -f "$f" ] || { echo "FAIL: expected $f to exist after the run" >&2; exit 1; }
done
[ -n "$(ls -A "$EAG_HOME/.state/backup" 2>/dev/null)" ] || { echo "FAIL: no backup kept in $EAG_HOME/.state/backup" >&2; exit 1; }
for f in "$CODEX_HOME/config.toml" "$EAG_HOME"/.state/*.json "$EAG_HOME"/.state/backup/* "$S/proj/.codex/config.toml" "$S/proj/.agents/.state"/*.json; do
  [ -f "$f" ] || continue
  [ "$(mode "$f")" = 600 ] || { echo "FAIL: expected mode 600 on $f, got $(mode "$f")" >&2; exit 1; }
done
grep -q '^\.codex/config\.toml$' .gitignore 2>/dev/null || { echo "FAIL: init --project did not ignore .codex/config.toml" >&2; exit 1; }
before="$(wc -l < .gitignore)"; A init --project >/dev/null; after="$(wc -l < .gitignore)"
[ "$before" = "$after" ] || { echo "FAIL: init --project appended to .gitignore again ($before -> $after lines)" >&2; exit 1; }

# Locked entry: still there, still exactly what it was, after every apply above.
grep -q '\[mcp_servers.eag-e2e-locked\]' "$CODEX_HOME/config.toml" || { echo "FAIL: locked entry eag-e2e-locked disappeared from config.toml" >&2; exit 1; }
grep -q 'url = "https://locked.example.com/mcp"' "$CODEX_HOME/config.toml" || { echo "FAIL: locked entry eag-e2e-locked was modified" >&2; exit 1; }

# Missing secret: refuses the write that must resolve a value (Claude, always literal),
# not the one that can stay a reference (a whole-value ${NAME} in a header becomes Codex's
# own bearer_token_env_var; it never needs to be resolved).
A mcp add e2e-missing --url https://example.com/missing --header 'Authorization: Bearer ${E2E_MISSING_TOKEN}'
set +e; A apply --scope user --target claude >"$S/missing.txt" 2>&1; rc=$?; set -e
if [ "$rc" != 1 ]; then echo "FAIL: a missing secret should block the Claude apply with exit 1, got $rc" >&2; cat "$S/missing.txt" >&2; exit 1; fi
grep -q 'not applied: fix the errors above' "$S/missing.txt" || { echo "FAIL: apply did not report the missing-secret error" >&2; exit 1; }
A apply --scope user --target codex
grep -q 'bearer_token_env_var = "E2E_MISSING_TOKEN"' "$CODEX_HOME/config.toml" || { echo "FAIL: codex did not write e2e-missing as an env-var reference" >&2; exit 1; }

# mcp rm propagates the delete: both a server that was actually written (e2e-demo) and one
# that never resolved on Claude (e2e-missing) must disappear from every target that has it.
A mcp rm e2e-missing; A mcp rm e2e-demo
apply_s --scope user
grep -qE 'e2e-missing|e2e-demo' "$CODEX_HOME/config.toml" && { echo "FAIL: mcp rm did not remove the entries from config.toml" >&2; exit 1; }
node -e '
const fs = require("fs"), d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const left = Object.keys(d.mcpServers || {}).filter((n) => n === "e2e-demo" || n === "e2e-missing");
if (left.length) { console.error(`FAIL: mcp rm did not remove ${left.join(", ")} from .claude.json`); process.exit(1); }
' "$S/cc/.claude.json"

# --- regressions fixed after the first sandbox run ------------------------------------

# An unknown flag must be refused. `--dryrun` used to parse, be ignored, and write for real.
set +e; A apply --dryrun >"$S/badflag.txt" 2>&1; rc=$?; set -e
[ "$rc" = 1 ] || { echo "FAIL: apply --dryrun exited $rc, expected 1 (unknown option)" >&2; cat "$S/badflag.txt" >&2; exit 1; }
grep -q 'unknown option' "$S/badflag.txt" || { echo "FAIL: apply --dryrun was not reported as an unknown option" >&2; cat "$S/badflag.txt" >&2; exit 1; }

# A source that parses but has no mcpServers key must be an error, never "zero servers":
# the next apply would take that literally and delete every server from every agent.
cp "$EAG_HOME/mcp.json" "$S/mcp.json.bak"
printf '{"servers":{}}\n' > "$EAG_HOME/mcp.json"
set +e; A status --scope user >"$S/badsource.txt" 2>&1; set -e
grep -q 'no "mcpServers" object' "$S/badsource.txt" || { echo "FAIL: a source without mcpServers was not reported:" >&2; cat "$S/badsource.txt" >&2; exit 1; }
cp "$S/mcp.json.bak" "$EAG_HOME/mcp.json"

# A damaged managed block (CLOSE marker lost to a merge or a hand edit) must stop the write.
# It used to append a second block, and the apply after that swallowed every table between
# the orphan OPEN and the new CLOSE.
cp "$CODEX_HOME/config.toml" "$S/config.toml.bak"
node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").split("\n").filter((l)=>l.trim()!=="# <<< easy-agnostic managed <<<").join("\n"))' "$CODEX_HOME/config.toml"
cp "$CODEX_HOME/config.toml" "$S/config.damaged.txt"
A mcp add e2e-damaged --url https://example.com/damaged
set +e; A apply --scope user --target codex >"$S/damaged.txt" 2>&1; set -e
grep -q 'managed block is damaged' "$S/damaged.txt" || { echo "FAIL: a damaged managed block was not reported:" >&2; cat "$S/damaged.txt" >&2; exit 1; }
cmp -s "$CODEX_HOME/config.toml" "$S/config.damaged.txt" || { echo "FAIL: apply wrote to config.toml despite the damaged block" >&2; exit 1; }
A mcp rm e2e-damaged
cp "$S/config.toml.bak" "$CODEX_HOME/config.toml"

# A table inside the block that the snapshot has never heard of — a second machine, or a
# .state restored from dotfiles without it — must survive a write that happens for some
# other reason, instead of being deleted while the run reports it as untouched.
node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("# <<< easy-agnostic managed <<<","[mcp_servers.e2e-orphan]\nurl = \"https://example.com/orphan\"\n\n# <<< easy-agnostic managed <<<"))' "$CODEX_HOME/config.toml"
A mcp add e2e-touch --url https://example.com/touch
apply_s --scope user --target codex
grep -q '\[mcp_servers.e2e-orphan\]' "$CODEX_HOME/config.toml" || { echo "FAIL: a block entry absent from .state was deleted by an unrelated write" >&2; exit 1; }
A mcp rm e2e-touch
apply_s --scope user --target codex
grep -q '\[mcp_servers.e2e-orphan\]' "$CODEX_HOME/config.toml" || { echo "FAIL: the orphan entry did not survive the second write either" >&2; exit 1; }

# --- sync on launch: `eag hook` -------------------------------------------------------
# The generated shell file has to be valid POSIX sh, wire the rc idempotently, and define a
# wrapper that syncs BEFORE handing control to the real binary. A fake `codex` first on PATH
# stands in for the real one so the run never actually starts an agent.
SHELLTEST="$S/shelltest"; mkdir -p "$SHELLTEST/bin"
printf '#!/bin/sh\nprintf "REAL codex ran\\n"\n' > "$SHELLTEST/bin/codex"; chmod +x "$SHELLTEST/bin/codex"
(
  export PATH="$SHELLTEST/bin:$PATH"
  A hook install > "$S/hook-install.txt"
  grep -q 'shell-init.sh' "$S/shellrc" || { echo "FAIL: hook install did not wire $S/shellrc" >&2; exit 1; }
  sh -n "$EAG_HOME/shell-init.sh" || { echo "FAIL: the generated shell file is not valid POSIX sh" >&2; exit 1; }
  grep -q 'codex() { __eag_sync; command codex "$@"; }' "$EAG_HOME/shell-init.sh" || { echo "FAIL: no codex wrapper in the generated file" >&2; exit 1; }
  grep -q 'export [A-Z_]*=' "$EAG_HOME/shell-init.sh" && { echo "FAIL: the generated file carries a literal export; secrets must stay in the store" >&2; exit 1; }
  before="$(wc -c < "$S/shellrc")"; A hook install >/dev/null; after="$(wc -c < "$S/shellrc")"
  [ "$before" = "$after" ] || { echo "FAIL: hook install is not idempotent ($before -> $after bytes)" >&2; exit 1; }

  # A server added now must reach Codex because the wrapper synced, not because we applied.
  A mcp add e2e-wrapped --url https://example.com/wrapped >/dev/null
  out="$(sh -c ". \"$EAG_HOME/shell-init.sh\"; codex" 2>&1)" || true
  echo "$out" | grep -q 'REAL codex ran' || { echo "FAIL: the wrapper did not hand over to the real binary:" >&2; echo "$out" >&2; exit 1; }
  grep -q '\[mcp_servers.e2e-wrapped\]' "$CODEX_HOME/config.toml" || { echo "FAIL: the wrapper did not sync before launching" >&2; exit 1; }

  # Nothing left to do: the wrapper must be completely silent apart from the agent itself.
  out="$(sh -c ". \"$EAG_HOME/shell-init.sh\"; codex" 2>&1)" || true
  [ "$out" = "REAL codex ran" ] || { echo "FAIL: a no-op sync printed something:" >&2; printf '%s\n' "$out" >&2; exit 1; }

  # A NEW problem must break that silence on the very next launch, and then go quiet again.
  node -e 'const fs=require("fs"),f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("https://example.com/wrapped","https://example.com/hand-edited"))' "$CODEX_HOME/config.toml"
  out="$(sh -c ". \"$EAG_HOME/shell-init.sh\"; codex" 2>&1)" || true
  echo "$out" | grep -q 'conflict(s) left untouched' || { echo "FAIL: a new conflict did not break the quiet-mode silence:" >&2; printf '%s\n' "$out" >&2; exit 1; }
  out="$(sh -c ". \"$EAG_HOME/shell-init.sh\"; codex" 2>&1)" || true
  [ "$out" = "REAL codex ran" ] || { echo "FAIL: the same conflict was reported twice; quiet mode must report a problem once:" >&2; printf '%s\n' "$out" >&2; exit 1; }

  A apply --scope user --target codex --prefer source >/dev/null 2>&1 || true
  A mcp rm e2e-wrapped >/dev/null
  A apply --scope user --target codex >/dev/null 2>&1 || true
)
A hook uninstall >/dev/null
grep -q 'easy-agnostic' "$S/shellrc" && { echo "FAIL: hook uninstall left its block in $S/shellrc" >&2; exit 1; }
[ -f "$EAG_HOME/shell-init.sh" ] && { echo "FAIL: hook uninstall left the generated file behind" >&2; exit 1; }

# `eag setup` = init + adopt claude + adopt codex + apply + doctor --fix in one call. Prove
# it converges from scratch, in its own disposable sub-sandbox with a minimal fixture (not
# a copy of the real configs): a server that starts out known only to Claude must reach
# Codex too, and vice versa — that cross-agent convergence is the actual point of `setup`,
# not just "it runs without crashing".
SETUP_S="$S/setup-smoke"
mkdir -p "$SETUP_S/cc" "$SETUP_S/codex" "$SETUP_S/agents" "$SETUP_S/pi" "$SETUP_S/proj"
printf '{"mcpServers":{"setup-demo":{"type":"http","url":"https://example.com/setup-demo"}}}\n' > "$SETUP_S/cc/.claude.json"
printf '[mcp_servers.setup-codex-demo]\nurl = "https://example.com/setup-codex-demo"\n' > "$SETUP_S/codex/config.toml"
(cd "$SETUP_S/proj" && git init -q)
(
  cd "$SETUP_S/proj"
  export EAG_HOME="$SETUP_S/agents" CLAUDE_CONFIG_DIR="$SETUP_S/cc" CODEX_HOME="$SETUP_S/codex" PI_CODING_AGENT_DIR="$SETUP_S/pi" EAG_SECRET_SERVICE=eag-test
  export EAG_SHELL_RC="$SETUP_S/shellrc"; : > "$EAG_SHELL_RC"
  set +e; out="$(A setup)"; rc=$?; set -e
  echo "$out"
  [ "$rc" = 0 ] || { echo "FAIL: eag setup exited $rc on a clean fixture with nothing that should fail" >&2; exit 1; }
  for stage in '1/6 init' '2/6 adopt claude' '3/6 adopt codex' '4/6 apply' '5/6 hook install' '6/6 doctor'; do
    echo "$out" | grep -q "$stage" || { echo "FAIL: eag setup did not run stage: $stage" >&2; exit 1; }
  done
  [ -f "$SETUP_S/agents/mcp.json" ] || { echo "FAIL: eag setup did not create the source" >&2; exit 1; }
  grep -q 'setup-codex-demo' "$SETUP_S/cc/.claude.json" || { echo "FAIL: eag setup did not sync the codex-only server to Claude" >&2; exit 1; }
  grep -q 'setup-demo' "$SETUP_S/codex/config.toml" || { echo "FAIL: eag setup did not sync the claude-only server to Codex" >&2; exit 1; }
  grep -q 'shell-init.sh' "$SETUP_S/shellrc" || { echo "FAIL: eag setup did not wire the shell for sync-on-launch" >&2; exit 1; }
  sh -n "$SETUP_S/agents/shell-init.sh" || { echo "FAIL: the shell file eag setup generated is not valid POSIX sh" >&2; exit 1; }
)
rm -rf "$SETUP_S"

echo; echo "e2e ok"
