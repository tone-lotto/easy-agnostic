import path from 'node:path';
import { CURSOR_HOME } from '../paths.js';
import { jsonMcp, translateRefs, checkedSource, rejectOverrides } from './json-mcp.js';
import { mapStrings } from '../util.js';
export const adapter = jsonMcp({ id: 'cursor', userFile: () => path.join(CURSOR_HOME,'mcp.json'), projectFile: '.cursor/mcp.json',
  render(name, src, { overrides, ...options } = {}) {
    rejectOverrides(overrides);
    const entry = src.url ? { url:src.url, ...(src.headers ? {headers:src.headers} : {}) } : {command:src.command, ...(src.args ? {args:src.args} : {}), ...(src.env ? {env:src.env} : {}), ...(src.cwd ? {cwd:src.cwd} : {})};
    return translateRefs(entry, {...options, syntax: n => `\${env:${n}}`});
  },
  toSource(native) {
    if (native.disabled || native.enabled === false || Object.keys(native).some(k => !['command','args','env','cwd','url','headers','type'].includes(k))) throw new Error('Cursor-specific MCP settings need manual review; entry preserved');
    const entry = mapStrings(native, s => s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_,n) => `\${${n}}`));
    if (/\$\{(?:workspaceFolder|userHome|pathSeparator|[A-Za-z]+:)/.test(JSON.stringify(entry))) throw new Error('Cursor path interpolation is not portable; entry preserved');
    return checkedSource(entry);
  },
});
