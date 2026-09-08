import fs from 'node:fs';
import path from 'node:path';
import { readConfig, editConfig, guardConfig, record } from '../json-config.js';
import { mapStrings, SECRET_REF } from '../util.js';
import { resolveSecret } from '../secrets.js';
import { validateServer } from '../source.js';

export function translateRefs(value, { secrets = 'literal', syntax, warn = () => {} } = {}) {
  return mapStrings(value, text => text.replace(SECRET_REF, (match, name) => {
    if (secrets === 'env' && syntax) return syntax(name);
    if (secrets === 'env') throw new Error('this agent has no verified environment-reference syntax; use literal mode');
    const resolved = resolveSecret(name);
    if (resolved === undefined) throw new Error(`${name}: secret is not set (eag secret set ${name})`);
    warn(`${name}: resolved into a private native configuration`); return resolved;
  }));
}
export function jsonMcp({ id, userFile, projectFile, key = 'mcpServers', render, toSource }) {
  const file = (scope, root) => scope === 'user' ? userFile() : path.join(root, projectFile);
  const guard = (scope, root) => guardConfig(file(scope,root), { root: scope === 'project' ? root : undefined, forbidden: scope === 'project' ? [userFile(), userFile().replace(/\.json$/, '.jsonc')] : [] });
  const read = (scope, root, { mcpFormat = 'auto' } = {}) => {
    guard(scope,root);
    let chosen = file(scope,root);
    if (id === 'opencode') {
      const jsonc = chosen.replace(/\.json$/, '.jsonc');
      if (fs.existsSync(chosen) && fs.existsSync(jsonc)) throw new Error('both opencode.json and opencode.jsonc exist; choose one before syncing');
      if (fs.existsSync(jsonc)) chosen = jsonc;
      guardConfig(chosen, { root: scope === 'project' ? root : undefined, forbidden: scope === 'project' ? [userFile(), userFile().replace(/\.json$/, '.jsonc')] : [] });
    }
    const snapshot = readConfig(chosen);
    const container = snapshot.data[key];
    if (container !== undefined && !record(container)) throw new Error(`${id}: ${key} must be an object`);
    // OpenCode v2 uses mcp.servers. Preserve its other MCP settings.
    const hasContainer = container && Object.keys(container).length > 0;
    const detectedNested = record(container?.servers) && !['local','remote'].includes(container.servers.type);
    if (id === 'opencode' && hasContainer && mcpFormat !== 'auto' && detectedNested !== (mcpFormat === 'v2')) throw new Error('OpenCode MCP format differs from the selected profile; migrate it explicitly before syncing');
    const nested = id === 'opencode' && (hasContainer ? detectedNested : mcpFormat === 'v2');
    const entries = nested ? container?.servers ?? {} : container ?? {};
    if (Object.values(entries).some(v => !record(v))) throw new Error(`${id}: malformed server table`);
    return { ...snapshot, keyPath: nested ? [key,'servers'] : [key], servers: new Map(Object.entries(entries)), locked: new Set(), keep: new Map() };
  };
  return { file, read, render, toSource,
    write(scope, root, actions, options) {
      const snapshot = read(scope,root,options);
      if (snapshot.text !== options.expectedText) throw new Error('native configuration changed since planning');
      const changes = actions.map(a => [[...snapshot.keyPath,a.name], a.op === 'delete' ? undefined : a.desired]);
      return editConfig(snapshot, changes, { ...options, guard: () => { guard(scope,root); guardConfig(snapshot.file); } });
    },
  };
}
export function checkedSource(entry) {
  const errors = validateServer('server', entry);
  if (errors.length) throw new Error('unsupported native MCP definition; entry preserved');
  return { entry, overrides: {} };
}
export function rejectOverrides(overrides) {
  if (Object.keys(overrides ?? {}).length) throw new Error('native overrides for this agent are not supported; use portable source fields');
}
