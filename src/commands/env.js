import { scopePaths, projectRoot } from '../paths.js';
import { loadSource, serverAllowed } from '../source.js';
import { refsIn, shellQuote } from '../util.js';
import { resolveSecret } from '../secrets.js';

// Explicit export utility and target-filtered payload for launch subshells.
// Never evaluate this in a shell startup file: that would export credentials broadly.
export function referencedNames(target, root = projectRoot()) {
  if (target !== undefined && !['claude', 'codex', 'pi'].includes(target)) throw new Error('--target must be claude, codex, or pi');
  const names = new Set();
  const user = loadSource(scopePaths('user'));
  for (const sc of ['user', 'project']) {
    const paths = scopePaths(sc, root);
    if (paths.collides) continue;
    const s = sc === 'user' ? user : loadSource(paths);
    const policy = sc === 'user' || !s.hasAgents ? user.agents : {
      targets: { ...user.agents.targets, ...s.agents.targets },
      servers: { ...user.agents.servers, ...s.agents.servers },
    };
    if (target && policy.targets?.[target] === false) continue;
    for (const [name, server] of Object.entries(s.servers)) {
      if (target && !serverAllowed(policy, name, target)) continue;
      refsIn(server, names);
      if (target) {
        const overrides = policy.servers?.[name]?.[target];
        refsIn(overrides, names);
        if (target === 'codex' && overrides) {
          for (const n of [overrides.bearer_token_env_var, ...(overrides.env_vars || []), ...Object.values(overrides.env_http_headers || {})]) {
            if (n === undefined) continue;
            if (typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error('invalid Codex environment pointer');
            names.add(n);
          }
        }
      }
    }
  }
  return names;
}

export async function run(_args = [], flags = {}) {
  const names = referencedNames(flags.target);
  const lines = [];
  let missing = false;
  for (const n of [...names].sort()) {
    const v = resolveSecret(n);
    if (v === undefined) {
      if (flags.target) { console.error(`${n}: not set (eag secret set ${n})`); missing = true; }
      else lines.push(`# ${n}: not set (eag secret set ${n})`);
    } else lines.push(`export ${n}=${shellQuote(v)}`);
  }
  // Never give a launcher a partially populated environment after resolution failure.
  if (missing) return 1;
  if (lines.length) console.log(lines.join('\n'));
  return 0;
}
