import { runCommand as execFileSync } from '../process.js';
import { redactConfig, processFailure } from '../redact.js';
import { CLAUDE_JSON } from '../paths.js';
import { readJson, exists, sortKeys, prune, mapStrings, refsIn, SECRET_REF } from '../util.js';
import { resolveSecret } from '../secrets.js';

// Claude Code, user scope. ~/.claude.json is rewritten wholesale by Claude and
// carries a lot of unrelated state, so eag never edits it directly: it reads
// it for comparison and writes through `claude mcp add-json` / `claude mcp remove`.
// Project scope needs no adapter: .mcp.json is the source and Claude reads it as is.
export const id = 'claude';

export function canonical(obj) {
  const o = { ...obj };
  if (!o.type) o.type = o.url ? 'http' : 'stdio';
  return sortKeys(prune(o));
}

export function read() {
  const data = readJson(CLAUDE_JSON, {});
  const servers = new Map();
  for (const [name, obj] of Object.entries(data.mcpServers || {})) servers.set(name, canonical(obj));
  return { file: CLAUDE_JSON, exists: exists(CLAUDE_JSON), servers, locked: new Set(), raw: data };
}

// Entries Claude stores under projects[<root>].mcpServers ("local" scope). Informational.
export function readLocal(root) {
  return readRaw().projects?.[root]?.mcpServers || {};
}
// The whole file, for the one caller that needs the projects map rather than one project.
export function readRaw() { return readJson(CLAUDE_JSON, {}); }

// Drop a "local" entry once the same server lives in the project's own .mcp.json, so Claude
// stops carrying a private second copy that nothing keeps in sync. Local scope is keyed by
// the directory the CLI runs in, hence cwd. Failure is reported, never fatal.
export function removeLocal(root, name) {
  try { execFileSync('claude', ['mcp', 'remove', name, '-s', 'local'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); return null; }
  catch (e) { return processFailure('claude mcp remove', e); }
}

// Claude Code does expand ${VAR} — in `env` values and in HTTP headers alike, including
// mid-string ("Bearer ${TOK}"); verified against claude 2.1.x by starting a probe server
// through `claude mcp list`. But it expands from THE AGENT'S OWN ENVIRONMENT, and an agent
// launched from a desktop app or an IDE on macOS inherits the launchd environment, not the
// user's shell rc: there the reference resolves to nothing and the server cannot
// authenticate. So `literal` is the default because it works from every launch context, and
// `env` is the opt-in for someone who only ever starts their agents from a terminal
// (agents.json: {"claude": {"secrets": "env"}}).
export function render(name, src, { secrets = 'literal', warn = () => {} } = {}) {
  if (secrets === 'env') {
    // A reference to a value that exists nowhere would hand the agent a server that can
    // never authenticate. Fail here, exactly as literal mode does.
    for (const r of refsIn(src)) if (resolveSecret(r) === undefined) throw new Error(`${name}: secret ${r} is not set. Run: eag secret set ${r}`);
    return canonical(src);
  }
  const resolved = new Set();
  const out = mapStrings(src, (s) => s.replace(SECRET_REF, (_m, n) => {
    const v = resolveSecret(n);
    if (v === undefined) throw new Error(`${name}: secret ${n} is not set. Run: eag secret set ${n}`);
    resolved.add(n);
    return v;
  }));
  // A value written resolved must never be invisible: dry-run redacts it, and the file it
  // lands in is the user's. Say so every time, and say how to stop it.
  for (const n of resolved) warn(`${name}: ${n} is written to ~/.claude.json as a resolved value (works from any launch context). Terminal-only? Set claude.secrets = "env" in agents.json to keep it a reference`);
  return canonical(out);
}

// redact: show ${NAME} references instead of resolved values. The real command
// needs the literals; anything shown to a human (dry-run) must not carry them.
export function commandsFor(actions, { redact = false } = {}) {
  const cmds = [];
  for (const a of actions) {
    if (a.op === 'delete' || a.op === 'update') cmds.push(['mcp', 'remove', a.name, '-s', 'user']);
    if (a.op === 'create' || a.op === 'update') cmds.push(['mcp', 'add-json', a.name, JSON.stringify(redact ? redactConfig(a.source ? canonical(a.source) : a.desired) : a.desired), '-s', 'user']);
  }
  return cmds;
}

// One bad entry (a name the `claude` CLI itself refuses, say) must not abort every other
// entry in this target, or the other targets after it: run every command, collect what
// failed, and let the caller decide what to report and what to retry next time.
export function write(actions, { dryRun, timeout = 10000 } = {}) {
  if (dryRun) return { commands: commandsFor(actions, { redact: true }), failures: [] };
  const failures = [];
  for (const action of actions) {
    let removed = false;
    for (const cmd of commandsFor([action])) {
      try {
        execFileSync('claude', cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout });
        if (cmd[1] === 'remove') removed = true;
      } catch (e) {
        const failure = { name: action.name, op: cmd[1], error: processFailure(`claude mcp ${cmd[1]}`, e) };
        // Never attempt add after a failed remove. If replacement fails after removal,
        // restore exactly the previous native entry, not a re-rendered source template.
        if (removed && action.op === 'update') {
          const previous = action.native ?? action.state;
          if (previous) {
            try {
              execFileSync('claude', ['mcp', 'add-json', action.name, JSON.stringify(previous), '-s', 'user'], { stdio: ['ignore', 'pipe', 'pipe'], timeout });
              failure.rollback = 'restored';
            } catch (restoreError) {
              failure.rollback = 'failed';
              failure.rollbackError = processFailure('claude rollback', restoreError);
            }
          } else failure.rollback = 'unavailable';
        }
        failures.push(failure);
        break;
      }
    }
  }
  return { commands: commandsFor(actions, { redact: true }), failures };
}

// `claude mcp add-json` refuses a name with anything outside [A-Za-z0-9_-]; `claude mcp
// remove` accepts any name at all. An update is remove-then-add, so a name the add will
// refuse must never reach the write: the remove would succeed and the entry would be gone
// with nothing left to restore it from.
export function nameError(name) {
  return /^[A-Za-z0-9_-]+$/.test(name)
    ? null
    : `${name}: Claude Code only accepts server names matching [A-Za-z0-9_-]. Rename it in the source, or run: eag mcp target ${name} claude off`;
}

export function available() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
