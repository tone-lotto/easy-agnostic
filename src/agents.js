// Agent identity is shared by MCP policy, skill policy and launchers. New targets
// have no implicit enablement; installing an application never grants permission.
export const AGENTS = ['claude', 'codex', 'pi', 'cursor', 'antigravity', 'opencode'];
export const NEW_AGENTS = ['cursor', 'antigravity', 'opencode'];
export const AGENT_BINS = { claude: 'claude', codex: 'codex', pi: 'pi', cursor: 'cursor-agent', antigravity: 'agy', opencode: 'opencode' };
export const isAgent = value => AGENTS.includes(value);
