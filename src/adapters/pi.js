import path from 'node:path';
import os from 'node:os';
import { PI_AGENT_DIR, EAG_HOME } from '../paths.js';
import { readJson, exists, deepEqual } from '../util.js';

// Pi is a reader, not a write target. With pi-mcp-adapter installed it loads
// ~/.agents/mcp.json and the project's .mcp.json on its own. Doctor only checks
// that the reading side is wired.
export const id = 'pi';

export function checks(root, sourceServers = {}) {
  const out = [];
  if (!exists(PI_AGENT_DIR)) { out.push({ level: 'info', msg: `Pi not found at ${PI_AGENT_DIR}` }); return out; }
  const settings = readJson(path.join(PI_AGENT_DIR, 'settings.json'), {});
  const pkgs = settings.packages || [];
  const adapterInstalled = pkgs.some((p) => /pi-mcp-adapter/.test(p)) || exists(path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'pi-mcp-adapter'));
  out.push(adapterInstalled
    ? { level: 'ok', msg: 'Pi: pi-mcp-adapter installed; Pi reads ~/.agents/mcp.json and ./.mcp.json directly' }
    : { level: 'warn', msg: 'Pi: pi-mcp-adapter not installed; Pi will not see any MCP server. Install: pi install npm:pi-mcp-adapter' });
  const canonical = path.join(os.homedir(), '.agents');
  if (path.resolve(EAG_HOME) !== canonical) out.push({ level: 'warn', msg: `Pi reads ${canonical}/mcp.json, but EAG_HOME is ${EAG_HOME}` });
  // Everything that can shadow the source. pi-mcp-adapter loads these after ~/.agents/mcp.json,
  // so a stale copy here is why "Pi still sees the old URL" even when eag reports no drift.
  const nested = path.join(EAG_HOME, 'mcp', 'mcp.json');
  if (exists(nested)) out.push({ level: 'warn', msg: `Pi also loads ${nested}, which overrides ${path.join(EAG_HOME, 'mcp.json')}` });
  for (const override of [path.join(PI_AGENT_DIR, 'mcp.json'), root ? path.join(root, '.pi', 'mcp.json') : null]) {
    if (!override || !exists(override)) continue;
    const servers = readJson(override, {}).mcpServers || {};
    const names = Object.keys(servers);
    if (!names.length) { out.push({ level: 'info', msg: `Pi: ${override} exists (no servers, settings only)` }); continue; }
    // An override whose extra keys are Pi-only options (directTools, …) over an otherwise
    // identical entry is a deliberate tweak, not drift. Only report what actually differs.
    const stale = names.filter((n) => {
      const src = sourceServers[n];
      if (!src) return true;
      return !deepEqual(src, Object.fromEntries(Object.entries(servers[n]).filter(([k]) => k in src)));
    });
    out.push(stale.length
      ? { level: 'warn', msg: `Pi: ${override} shadows the source with different content for: ${stale.join(', ')}` }
      : { level: 'info', msg: `Pi: ${override} tweaks (same content as the source): ${names.join(', ')}` });
  }
  const shared = path.join(os.homedir(), '.config', 'mcp', 'mcp.json');
  if (exists(shared)) out.push({ level: 'info', msg: `Pi also loads ${shared}` });
  return out;
}
