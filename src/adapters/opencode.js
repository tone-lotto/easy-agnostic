import path from 'node:path';
import { OPENCODE_HOME } from '../paths.js';
import { jsonMcp, translateRefs, checkedSource, rejectOverrides } from './json-mcp.js';
import { mapStrings } from '../util.js';
export const adapter = jsonMcp({ id:'opencode', userFile:() => path.join(OPENCODE_HOME,'opencode.json'), projectFile:'opencode.json', key:'mcp',
  render(name, src, {overrides,...options} = {}) {
    rejectOverrides(overrides);
    const entry = src.url ? {type:'remote',url:src.url,...(src.headers ? {headers:src.headers} : {})}
      : {type:'local',command:[src.command,...(src.args ?? [])],...(src.env ? {environment:src.env} : {}),...(src.cwd ? {cwd:src.cwd} : {})};
    return translateRefs(entry,{...options,syntax:n => `{env:${n}}`});
  },
  toSource(native) {
    if (native.enabled === false || Object.keys(native).some(k => !['type','command','environment','cwd','url','headers','enabled'].includes(k))) throw new Error('OpenCode-specific MCP settings need manual review; entry preserved');
    const n = mapStrings(native,s => s.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name)=>`\${${name}}`));
    if (/\{(?:file|env):/.test(JSON.stringify(n))) throw new Error('OpenCode interpolation is not portable; entry preserved');
    let entry;
    if (n.type === 'local' && Array.isArray(n.command) && n.command.length) entry = {command:n.command[0],args:n.command.slice(1),...(n.environment ? {env:n.environment} : {}),...(n.cwd ? {cwd:n.cwd} : {})};
    else if (n.type === 'remote') entry = {url:n.url,...(n.headers ? {headers:n.headers} : {})};
    else throw new Error('unsupported OpenCode MCP transport');
    return checkedSource(entry);
  },
});
