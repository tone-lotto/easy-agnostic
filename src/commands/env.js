import { scopePaths, projectRoot } from '../paths.js';
import { loadSource } from '../source.js';
import { refsIn } from '../util.js';
import { resolveSecret } from '../secrets.js';

// Print shell exports so ${VAR} references resolve inside Claude, Codex and Pi.
// Usage in ~/.zshrc:  eval "$(eag env)"
export async function run() {
  const names = new Set();
  for (const sc of ['user', 'project']) {
    const s = loadSource(scopePaths(sc, projectRoot()));
    if (s.hasMcp) refsIn(s.servers, names);
  }
  for (const n of [...names].sort()) {
    const v = resolveSecret(n);
    if (v === undefined) console.log(`# ${n}: not set (eag secret set ${n})`);
    else console.log(`export ${n}='${v.replace(/'/g, `'\\''`)}'`);
  }
  return 0;
}
