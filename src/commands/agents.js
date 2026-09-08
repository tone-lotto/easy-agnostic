import { AGENTS, NEW_AGENTS, AGENT_BINS } from '../agents.js';
import { projectRoot, scopePaths, assertProjectScope } from '../paths.js';
import { loadSource, saveAgents, targetEnabled, mergeAgentPolicies } from '../source.js';
import { JSON_ADAPTERS } from '../adapters/registry.js';

export async function run(args, flags) {
  const [command = 'ls',agent] = args, scope = flags.scope ?? 'user', root = projectRoot();
  for (const key of ['dry-run','json']) if (flags[key] !== undefined && flags[key] !== true) throw new Error(`--${key} is a boolean flag`);
  if (flags['mcp-format'] !== undefined && (agent !== 'opencode' || command !== 'enable' || !['v1','v2'].includes(flags['mcp-format']))) throw new Error('--mcp-format v1|v2 requires agents enable opencode');
  if (!['user','project'].includes(scope)) throw new Error('--scope must be user or project');
  const paths = scopePaths(scope,root), source = loadSource(paths);
  if (command === 'ls' && args.length <= 1) {
    if (scope === 'project') assertProjectScope(paths);
    const policy = scope === 'project' ? mergeAgentPolicies(loadSource(scopePaths('user')).agents,source.hasAgents ? source.agents : {}) : source.agents;
    const rows = AGENTS.map(id => ({agent:id,scope,enabled:targetEnabled(policy,id) || id === 'pi' && policy.targets?.pi === 'read-only',
      inherited:scope === 'project' && (!source.hasAgents || !Object.hasOwn(source.agents.targets ?? {},id)),
      launchBinary:AGENT_BINS[id],mcpFile:JSON_ADAPTERS[id]?.read(scope,root,policy[id]).file ?? null,
      history:NEW_AGENTS.includes(id) ? 'explicit local export; see eag history import --help' : 'local session discovery'}));
    if (flags.json) console.log(JSON.stringify({agents:rows},null,2));
    else for (const r of rows) console.log(`${r.agent}: ${r.enabled ? 'enabled' : 'off'} (${scope})${r.mcpFile ? ` — ${r.mcpFile}` : ''}`);
    return 0;
  }
  if (!['enable','disable'].includes(command) || args.length !== 2 || !AGENTS.includes(agent)) throw new Error('usage: eag agents ls | enable AGENT | disable AGENT --scope user|project');
  if (!flags.scope) throw new Error('--scope user|project is required to change agent enrollment');
  assertProjectScope(paths);
  // A new project policy is overrides-only. Copying DEFAULT_AGENTS here would
  // silently re-enable Claude/Codex that the user disabled machine-wide.
  const policy = scope === 'project' && !source.hasAgents ? {targets:{},servers:{}} : structuredClone(source.agents);
  policy.targets ??= {};
  if (flags['mcp-format']) policy.opencode = {...policy.opencode,mcpFormat:flags['mcp-format']};
  policy.targets[agent] = command === 'enable' ? agent === 'pi' ? 'read-only' : true : false;
  if (!flags['dry-run']) saveAgents(paths,policy);
  const result = {agent,scope,enabled:command === 'enable',dryRun:!!flags['dry-run'],note:command === 'enable'
    ? 'MCP sync authorized in this scope; skills and hooks require separate enrollment. Run eag apply --scope ' + scope
    : 'Sync disabled. Existing native entries are retained; disabling sync is not native MCP removal.'};
  console.log(flags.json ? JSON.stringify(result,null,2) : `${agent}: ${result.enabled ? 'enabled' : 'off'}${result.dryRun ? ' (dry run)' : ''}. ${result.note}`);
  return 0;
}
