import { execFileSync } from 'node:child_process';
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
  catch (e) { return e.stderr?.toString().trim() || `claude mcp remove exited ${e.status ?? e.signal ?? 'abnormally'}`; }
}

// Claude Code does expand ${VAR} — in `env` values and in HTTP headers alike, including
// mid-string ("Bearer ${TOK}"); verified against claude 2.1.x by starting a probe server
// through `claude mcp list`. But it expands from THE AGENT'S OWN ENVIRONMENT, and an agent
// launched from a desktop app or an IDE on macOS inherits the launchd environment, not the
// user's shell rc: there the reference resolves to nothing and the server cannot
// authenticate. So `literal` is the default because it works from every launch context, and
// `env` is the opt-in for someone who only ever starts their agents from a terminal
// (agents.json: {"claude": {"secrets": "env"}}).
export function render(name, src, { secrets = 'literal' } = {}) {
  if (secrets === 'env') {
    // A reference to a value that exists nowhere would hand the agent a server that can
    // never authenticate. Fail here, exactly as literal mode does.
    for (const r of refsIn(src)) if (resolveSecret(r) === undefined) throw new Error(`${name}: secret ${r} is not set. Run: eag secret set ${r}`);
    return canonical(src);
  }
  const out = mapStrings(src, (s) => s.replace(SECRET_REF, (_m, n) => {
    const v = resolveSecret(n);
    if (v === undefined) throw new Error(`${name}: secret ${n} is not set. Run: eag secret set ${n}`);
    return v;
  }));
  return canonical(out);
}

// redact: show ${NAME} references instead of resolved values. The real command
// needs the literals; anything shown to a human (dry-run) must not carry them.
export function commandsFor(actions, { redact = false } = {}) {
  const cmds = [];
  for (const a of actions) {
    if (a.op === 'delete' || a.op === 'update') cmds.push(['mcp', 'remove', a.name, '-s', 'user']);
    if (a.op === 'create' || a.op === 'update') cmds.push(['mcp', 'add-json', a.name, JSON.stringify(redact && a.source ? canonical(a.source) : a.desired), '-s', 'user']);
  }
  return cmds;
}

// Same op/order logic as commandsFor, kept separate so a failed command can be traced
// back to the server name without depending on redact or on `-s user`'s exact position.
function namesFor(actions) {
  const names = [];
  for (const a of actions) {
    if (a.op === 'delete' || a.op === 'update') names.push(a.name);
    if (a.op === 'create' || a.op === 'update') names.push(a.name);
  }
  return names;
}

// One bad entry (a name the `claude` CLI itself refuses, say) must not abort every other
// entry in this target, or the other targets after it: run every command, collect what
// failed, and let the caller decide what to report and what to retry next time.
export function write(actions, { dryRun } = {}) {
  if (dryRun) return { commands: commandsFor(actions, { redact: true }), failures: [] };
  const cmds = commandsFor(actions);
  const names = namesFor(actions);
  const failures = [];
  for (let i = 0; i < cmds.length; i++) {
    try { execFileSync('claude', cmds[i], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      // e.message embeds the whole argv, and for add-json that argv carries the resolved
      // secret. Never fall back to it: report the CLI's own stderr, or the exit status.
      const stderr = e.stderr?.toString().trim();
      failures.push({ name: names[i], op: cmds[i][1], error: stderr || `claude mcp ${cmds[i][1]} exited ${e.status ?? e.signal ?? 'abnormally'}` });
    }
  }
  return { commands: cmds, failures };
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
