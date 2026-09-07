#!/usr/bin/env node
// Deliberately narrow native-CLI fixture. Unknown operations fail, never run a real agent.
const fs = require('node:fs');
const path = require('node:path');
const [,, ...args] = process.argv;
const agent = path.basename(process.argv[1]);
if (args[0] === '--version') { console.log(`${agent} fixture`); process.exit(0); }
if (agent === 'codex' && args[0] === 'app-server') {
  // Trust state is intentionally unknown. A fixture must not claim real user approval.
  process.exit(1);
}
if (agent !== 'claude' || args[0] !== 'mcp') process.exit(1);
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const [, op, name, payload] = args;
const scope = args[args.indexOf('-s') + 1];
const servers = scope === 'user' ? (data.mcpServers ||= {})
  : scope === 'local' ? (data.projects?.[fs.realpathSync(process.cwd())]?.mcpServers || {}) : null;
if (!servers) process.exit(2);
if (op === 'remove') {
  if (!Object.hasOwn(servers, name)) process.exit(2);
  delete servers[name];
} else if (op === 'add-json') {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || Object.hasOwn(servers, name)) process.exit(2);
  servers[name] = JSON.parse(payload);
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
