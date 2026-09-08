import path from 'node:path';
import { ANTIGRAVITY_HOME } from '../paths.js';
import { jsonMcp, translateRefs, checkedSource, rejectOverrides } from './json-mcp.js';
const CWD_BRIDGE = 'cd -- "$1" && shift && exec "$@"';
export const adapter = jsonMcp({ id:'antigravity', userFile:() => path.join(ANTIGRAVITY_HOME,'mcp_config.json'), projectFile:'.agents/mcp_config.json',
  render(name, src, {overrides,...options} = {}) {
    rejectOverrides(overrides);
    const entry = src.url ? {serverUrl:src.url, ...(src.headers ? {headers:src.headers} : {})} : {command:src.command, ...(src.args ? {args:src.args} : {}), ...(src.env ? {env:src.env} : {})};
    if (!src.url && src.cwd) { entry.command = '/bin/sh'; entry.args = ['-c',CWD_BRIDGE,'eag-mcp',src.cwd,src.command,...(src.args ?? [])]; }
    return translateRefs(entry,options);
  },
  toSource(native) {
    if (Object.keys(native).some(k => !['serverUrl','headers','command','args','env'].includes(k))) throw new Error('Antigravity-specific MCP settings need manual review; entry preserved');
    const entry = {...native}; if ('serverUrl' in entry) { entry.url = entry.serverUrl; delete entry.serverUrl; }
    if (entry.command === '/bin/sh' && entry.args?.[0] === '-c' && entry.args[1] === CWD_BRIDGE && entry.args[2] === 'eag-mcp' && entry.args.length >= 5) {
      entry.cwd = entry.args[3]; entry.command = entry.args[4]; entry.args = entry.args.slice(5);
    }
    return checkedSource(entry);
  },
});
