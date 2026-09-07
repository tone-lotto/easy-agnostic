import { scopePaths, projectRoot } from '../paths.js';
import { loadSource, saveMcp, saveAgents, validateServer } from '../source.js';
import { c, refsIn } from '../util.js';
import { resolveSecret } from '../secrets.js';

function list(flag) { return flag === undefined ? [] : [].concat(flag); }

export async function run(args, flags) {
  const sub = args[0];
  const root = projectRoot();
  const scope = flags.scope || 'user';
  if (!['user', 'project'].includes(scope)) throw new Error(`--scope must be user or project (got "${scope}")`);
  const paths = scopePaths(scope, root);
  const src = loadSource(paths);

  if (sub === 'ls' || !sub) {
    const rows = [];
    for (const sc of ['user', 'project']) {
      const s = loadSource(scopePaths(sc, root));
      if (!s.hasMcp) continue;
      for (const [name, srv] of Object.entries(s.servers)) {
        const t = s.agents?.servers?.[name]?.targets || {};
        const off = Object.entries(t).filter(([, v]) => v === false).map(([k]) => `${k}:off`);
        const missing = [...refsIn(srv)].filter((r) => resolveSecret(r) === undefined);
        rows.push([name, sc, srv.url ? 'http' : 'stdio', srv.url || `${srv.command} ${(srv.args || []).join(' ')}`, off.join(' '), missing.length ? c.warn(`missing: ${missing.join(',')}`) : '']);
      }
    }
    if (!rows.length) { console.log('no servers in source. Try: eag adopt claude'); return 0; }
    const w = [Math.max(...rows.map((r) => r[0].length)), 7, 5];
    for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${c.dim(r[3].slice(0, 70))}  ${r[4]} ${r[5]}`);
    return 0;
  }

  if (sub === 'add') {
    const name = args[1];
    if (!name) throw new Error('usage: eag mcp add <name> (--url U [--header "K: V"]... | --command C [--args a,b] [--env K=V]...) [--type http|sse|stdio] [--scope user|project]');
    const entry = {};
    const one = (k) => { const v = flags[k]; if (v === undefined) return undefined; if (typeof v !== 'string') throw new Error(`--${k} needs one string value`); return v; };
    if (flags.url !== undefined && flags.command !== undefined) throw new Error('--url and --command are mutually exclusive');
    const type = one('type');
    if (type !== undefined && !['http', 'sse', 'stdio'].includes(type)) throw new Error(`--type must be http, sse or stdio (got "${type}")`);
    if (flags.url !== undefined) {
      if (type === 'stdio') throw new Error('--type stdio needs --command, not --url');
      entry.type = type || 'http'; entry.url = one('url');
      const headers = {}; for (const h of list(flags.header)) { const m = /^([^:]+):\s*(.*)$/.exec(String(h)); if (!m) throw new Error(`bad --header ${h}`); headers[m[1].trim()] = m[2]; }
      if (Object.keys(headers).length) entry.headers = headers;
    } else if (flags.command !== undefined) {
      if (type && type !== 'stdio') throw new Error(`--type ${type} needs --url, not --command`);
      entry.type = 'stdio'; entry.command = one('command');
      if (flags.args !== undefined) entry.args = String(one('args')).split(',');
      const env = {}; for (const e of list(flags.env)) { const m = /^([^=]+)=(.*)$/.exec(String(e)); if (!m) throw new Error(`bad --env ${e}`); env[m[1]] = m[2]; }
      if (Object.keys(env).length) entry.env = env;
      if (flags.cwd !== undefined) entry.cwd = one('cwd');
    } else throw new Error('need --url or --command');
    const errs = validateServer(name, entry);
    if (errs.length) throw new Error(errs.join('; '));
    if (Object.hasOwn(src.servers, name) && !flags.force) throw new Error(`${name} already exists in ${paths.mcp}; use --force to replace`);
    saveMcp(paths, { ...src.servers, [name]: entry }, src.mcp);
    console.log(`${c.ok('added  ')} ${name} → ${paths.mcp}`);
    for (const r of refsIn(entry)) if (resolveSecret(r) === undefined) console.log(`${c.warn('missing')} \${${r}} is not set. Run: eag secret set ${r}`);
    console.log(`Next: ${c.bold('eag apply' + (scope === 'project' ? ' --scope project' : ''))}`);
    return 0;
  }

  if (sub === 'rm') {
    const name = args[1];
    if (!name) throw new Error('usage: eag mcp rm <name> [--scope user|project]');
    if (!Object.hasOwn(src.servers, name)) throw new Error(`${name} not in ${paths.mcp}`);
    const servers = { ...src.servers }; delete servers[name];
    saveMcp(paths, servers, src.mcp);
    console.log(`${c.ok('removed')} ${name} from ${paths.mcp}. Run eag apply to remove it from the agents.`);
    return 0;
  }

  if (sub === 'target') {
    const [, name, agent, onoff] = args;
    if (!name || !agent || !['on', 'off'].includes(onoff)) throw new Error('usage: eag mcp target <name> <claude|codex|pi> on|off [--scope]');
    const agents = structuredClone(src.agents);
    agents.servers = Object.assign(Object.create(null), agents.servers); // a server named "toString" must not resolve through Object.prototype
    agents.servers[name] ||= {}; agents.servers[name].targets ||= {};
    if (onoff === 'on') delete agents.servers[name].targets[agent]; else agents.servers[name].targets[agent] = false;
    if (!Object.keys(agents.servers[name].targets).length) delete agents.servers[name].targets;
    if (!Object.keys(agents.servers[name]).length) delete agents.servers[name];
    saveAgents(paths, agents);
    console.log(`${c.ok('set    ')} ${name} → ${agent}: ${onoff}`);
    return 0;
  }
  throw new Error(`unknown subcommand: mcp ${sub}`);
}
