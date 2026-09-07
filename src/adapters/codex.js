import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { CODEX_HOME } from '../paths.js';
import { exists, writeFileAtomic, backup, WHOLE_REF, SECRET_REF, mapStrings, sortKeys } from '../util.js';
import { resolveSecret } from '../secrets.js';
import { validateServer } from '../source.js';
import { containsSensitiveLiteral } from '../redact.js';

// Codex keeps MCP servers in TOML. eag owns exactly one region of that file,
// delimited by markers, and never rewrites text outside it. Anything defined
// outside the region (hand-written, or another tool's own managed block)
// is "locked": read for comparison, never edited.
export const id = 'codex';
export const OPEN = '# >>> easy-agnostic managed >>>';
// Set on a rendered table when render() had to resolve a ${NAME} into a literal value.
// Symbol-keyed and non-enumerable, so sortKeys, deepEqual, the JSON state snapshot and
// the TOML serialiser never see it: it only travels render() -> write().
export const HAS_LITERAL = Symbol('eag.hasLiteral');
export const CLOSE = '# <<< easy-agnostic managed <<<';

export function configPath(scope, root) {
  return scope === 'user' ? path.join(CODEX_HOME, 'config.toml') : path.join(root, '.codex', 'config.toml');
}

// Markers are matched as whole lines so one quoted inside a TOML string cannot move the
// region, and CRLF is tolerated (trim() eats the \r).
function markerLines(text) {
  const opens = [];
  const closes = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === OPEN) opens.push({ start: pos, end: pos + line.length });
    else if (t === CLOSE) closes.push({ start: pos, end: pos + line.length });
    pos += line.length + 1;
  }
  return { opens, closes };
}

// Exactly one OPEN and one CLOSE, in that order, or the region is ambiguous. Guessing here
// means deleting whatever sits between an orphan marker and the next one — which is how a
// lost CLOSE (a dotfiles merge, a hand edit) used to swallow hand-written tables.
function splitBlock(text) {
  const { opens, closes } = markerLines(text);
  if (!opens.length && !closes.length) return { before: text, block: null, after: '', damaged: null };
  if (opens.length === 1 && closes.length === 1 && closes[0].start > opens[0].start) {
    return { before: text.slice(0, opens[0].start), block: text.slice(opens[0].start, closes[0].end), after: text.slice(closes[0].end), damaged: null };
  }
  const say = (n, what) => `${n} "${what}" marker line${n === 1 ? '' : 's'}`;
  return { before: text, block: null, after: '', damaged: `the easy-agnostic managed block is damaged: found ${say(opens.length, OPEN)} and ${say(closes.length, CLOSE)}` };
}

export function canonical(obj) { return sortKeys(obj); }

// Tables inside ANOTHER tool's marker block ("# >>> simbos managed >>>" … "# <<< … <<<").
// Returns name -> owner label. Whole-line match, same discipline as our own markers.
function foreignBlocks(text) {
  const owners = new Map();
  const lines = text.split('\n');
  let owner = null;
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    const open = /^# >>> (.+?) >>>$/.exec(t);
    const close = /^# <<< (.+?) <<<$/.exec(t);
    if (open && !t.includes('easy-agnostic')) { owner = open[1].replace(/\s*\(.*\)\s*$/, '').replace(/\s+managed$/, ''); buf = []; continue; }
    if (close && owner) {
      try { for (const n of Object.keys(parse(buf.join('\n')).mcp_servers || {})) owners.set(n, owner); } catch { /* unparsable fragment: no claim */ }
      owner = null; buf = [];
      continue;
    }
    if (owner) buf.push(line);
  }
  return owners;
}

// Why a locked table must not be shared with the other agents. Null means it is a plain
// hand-written table the user put in config.toml, which is exactly the kind of thing eag
// exists to share.
export function keepReason(name, obj, owners) {
  if (owners.has(name)) return `managed by ${owners.get(name)}`;
  const cmd = typeof obj?.command === 'string' ? obj.command : '';
  if (/\.app\//.test(cmd)) return 'a macOS app internal (command inside an .app bundle)';
  if (['node_repl', 'computer-use', 'cua_repl'].includes(name)) return 'a ChatGPT/Codex app internal';
  if (obj?.enabled === false) return 'disabled in Codex';
  return null;
}

export function read(scope, root) {
  const file = configPath(scope, root);
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  let parsed = {};
  try { parsed = text ? parse(text) : {}; } catch { throw new Error(`${file} is not valid TOML (content withheld)`); }
  const all = parsed.mcp_servers && typeof parsed.mcp_servers === 'object' ? parsed.mcp_servers : {};
  const { block, damaged } = splitBlock(text);
  let managed = new Set();
  if (block) {
    try { managed = new Set(Object.keys(parse(block).mcp_servers || {})); } catch { managed = new Set(); }
  }
  const owners = foreignBlocks(text);
  const servers = new Map();
  const locked = new Set();
  const keep = new Map(); // locked name -> why it must stay Codex's alone
  for (const [name, obj] of Object.entries(all)) {
    servers.set(name, canonical(obj));
    if (!managed.has(name)) {
      locked.add(name);
      const why = keepReason(name, obj, owners);
      if (why) keep.set(name, why);
    }
  }
  return { file, text, exists: exists(file), servers, locked, managed, keep, hasBlock: !!block, damaged, parsed };
}

// Source entry (Claude/.mcp.json shape) -> Codex table. Secrets travel as env
// references wherever Codex has a field for it; elsewhere they become literals
// and the caller is warned.
export function render(name, src, overrides = {}, warn = () => {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(`${name}: Codex overrides must be an object`);
  let resolved = false;
  const literal = (v, where) => mapStrings(v, (s) => s.replace(SECRET_REF, (_m, n) => {
    const val = resolveSecret(n);
    if (val === undefined) throw new Error(`${name}: secret ${n} (in ${where}) is not set. Run: eag secret set ${n}`);
    warn(`${name}: ${where} has no env-ref field in Codex; writing \${${n}} as a literal`);
    resolved = true;
    return val;
  }));
  const o = {};
  if (src.url) {
    if (src.type === 'sse') warn(`${name}: type "sse" is not supported by Codex; writing as streamable HTTP`);
    o.url = literal(src.url, 'url');
    const headers = {};
    const envHeaders = {};
    for (const [h, v] of Object.entries(src.headers || {})) {
      const bearer = /^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
      if (h.toLowerCase() === 'authorization' && bearer) { o.bearer_token_env_var = bearer[1]; continue; }
      const whole = WHOLE_REF.exec(v);
      if (whole) { envHeaders[h] = whole[1]; continue; }
      headers[h] = literal(v, `headers.${h}`);
    }
    if (Object.keys(headers).length) o.http_headers = headers;
    if (Object.keys(envHeaders).length) o.env_http_headers = envHeaders;
  } else {
    o.command = literal(src.command, 'command');
    if (src.args?.length) o.args = literal(src.args, 'args');
    const env = {};
    const envVars = [];
    for (const [k, v] of Object.entries(src.env || {})) {
      const whole = WHOLE_REF.exec(v);
      if (whole && whole[1] === k) { envVars.push(k); continue; }
      env[k] = literal(v, `env.${k}`);
    }
    if (Object.keys(env).length) o.env = env;
    if (envVars.length) o.env_vars = envVars;
    if (src.cwd) o.cwd = literal(src.cwd, 'cwd');
  }
  // Overrides are still configuration, not a bypass around reference resolution,
  // validation, or the exact literal-permission marker.
  Object.assign(o, overrides);
  validateNative(name, o);
  Object.assign(o, literal(overrides, 'Codex overrides'));
  validateNative(name, o); // Resolved values may contain invalid URLs/control characters.
  const out = canonical(o); // after canonical(): sortKeys rebuilds the object and would drop the marker
  if (resolved) Object.defineProperty(out, HAS_LITERAL, { value: true });
  return out;
}

function validateNative(name, table) {
  const source = {};
  for (const key of ['url', 'command', 'args', 'cwd', 'env']) if (key in table) source[key] = table[key];
  if ('http_headers' in table) source.headers = table.http_headers;
  const errors = validateServer(name, source);
  const identifier = (v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
  if ('bearer_token_env_var' in table && !identifier(table.bearer_token_env_var)) errors.push('bearer_token_env_var must be an environment variable name');
  if ('env_vars' in table && (!Array.isArray(table.env_vars) || !table.env_vars.every(identifier))) errors.push('env_vars must be an array of environment variable names');
  if ('env_http_headers' in table) {
    const value = table.env_http_headers;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(identifier)) errors.push('env_http_headers must map header names to environment variable names');
    else errors.push(...validateServer(name, { url: 'https://example.com', headers: value }));
  }
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec']) if (key in table && (typeof table[key] !== 'number' || !Number.isFinite(table[key]) || table[key] <= 0)) errors.push(`${key} must be a positive finite number`);
  for (const key of ['enabled', 'required']) if (key in table && typeof table[key] !== 'boolean') errors.push(`${key} must be boolean`);
  for (const key of ['enabled_tools', 'disabled_tools']) if (key in table && (!Array.isArray(table[key]) || table[key].some((v) => typeof v !== 'string' || !v || /[\0\r\n]/.test(v)))) errors.push(`${key} must contain non-empty single-line tool names`);
  if (errors.length) throw new Error(`${name}: invalid Codex configuration: ${errors.join('; ')}`);
}

function renderBlock(entries, scope) {
  const lines = [OPEN, '# Generated by eag. Edit the source (~/.agents/mcp.json or ./.mcp.json) and run `eag apply`.'];
  if (scope === 'project') lines.push('# Only this project\'s own servers: Codex merges these with ~/.codex/config.toml, and a name in both resolves here.');
  // Code-unit order, like sortKeys and the merge: localeCompare would reorder the block
  // between machines with different locales and produce diffs that mean nothing.
  for (const [name, obj] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push('', stringify({ mcp_servers: { [name]: obj } }).trim());
  }
  lines.push(CLOSE);
  return lines.join('\n');
}

// True when any of these tables came out of render() with a ${NAME} resolved into a
// literal, or (for tables eag did not render) looks like it carries a credential.
function carriesLiteral(entries) {
  for (const t of entries.values()) {
    if (t[HAS_LITERAL]) return true;                                            // render() resolved one: exact
    if (containsSensitiveLiteral(t)) return true;
  }
  return false;
}

// Nothing to write, but the block may already hold a credential in a file whose mode was
// widened since. Only ever tightens, and only a file that exists.
export function ensureMode(scope, root, entries) {
  const file = configPath(scope, root);
  if (!exists(file) || !carriesLiteral(entries)) return null;
  if (!(fs.statSync(file).mode & 0o077)) return null;
  fs.chmodSync(file, fs.statSync(file).mode & 0o600);
  return file;
}

// entries: Map name -> table object that must end up inside the managed block.
export function write(scope, root, entries, { backupDir, dryRun, expectedText } = {}) {
  const cur = read(scope, root);
  if (expectedText !== undefined && cur.text !== expectedText) throw new Error('Codex configuration changed since planning; retry');
  if (cur.damaged) throw new Error(`refusing to write ${cur.file}: ${cur.damaged}. Repair the markers by hand (an older copy may be under .state/backup/) and run eag apply again.`);
  const { before, after } = splitBlock(cur.text);
  const block = renderBlock(entries, scope);
  let text;
  if (cur.hasBlock) text = before + block + after;
  else {
    const base = cur.text === '' || cur.text.endsWith('\n') ? cur.text : `${cur.text}\n`;
    text = `${base}${base ? '\n' : ''}${block}\n`;
  }
  // Never leave the agent with a file it cannot parse.
  try { parse(text); } catch { throw new Error(`refusing to write ${cur.file}: result is not valid TOML (content withheld)`); }
  if (dryRun) return { file: cur.file, text, changed: text !== cur.text };
  const bak = backup(cur.file, backupDir, `codex-${scope}`);
  // A rewritten file keeps its own mode, except when the block we are writing carries a
  // credential: then 0600. Modes are only ever tightened, never widened.
  const mode = cur.exists ? (carriesLiteral(entries) ? fs.statSync(cur.file).mode & 0o600 : undefined) : 0o600;
  writeFileAtomic(cur.file, text, mode, { expected: cur.exists ? cur.text : null });
  return { file: cur.file, text, backup: bak, changed: text !== cur.text };
}

// Codex table -> source entry, for `eag adopt codex`.
export function toSource(obj) {
  const s = {};
  const overrides = {};
  if (obj.url) {
    s.type = 'http';
    s.url = obj.url;
    const headers = { ...(obj.http_headers || {}) };
    if (obj.bearer_token_env_var) headers.Authorization = `Bearer \${${obj.bearer_token_env_var}}`;
    for (const [h, v] of Object.entries(obj.env_http_headers || {})) headers[h] = `\${${v}}`;
    if (Object.keys(headers).length) s.headers = headers;
  } else if (obj.command) {
    s.type = 'stdio';
    s.command = obj.command;
    if (obj.args) s.args = obj.args;
    const env = { ...(obj.env || {}) };
    for (const v of obj.env_vars || []) env[v] = `\${${v}}`;
    if (Object.keys(env).length) s.env = env;
    if (obj.cwd) s.cwd = obj.cwd;
  }
  for (const k of ['startup_timeout_sec', 'tool_timeout_sec', 'enabled', 'enabled_tools', 'disabled_tools']) if (k in obj) overrides[k] = obj[k];
  return { entry: s, overrides };
}
