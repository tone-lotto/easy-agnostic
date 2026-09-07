import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EAG_HOME } from './paths.js';
import { readJson, writeJson, writeFileAtomic, backup } from './util.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const names = { agents: 'AGENTS.md', claude: 'CLAUDE.md' };
export const BEGIN = '<!-- >>> easy-agnostic shared instructions >>> -->';
export const END = '<!-- <<< easy-agnostic shared instructions <<< -->';
const block = (text) => `${BEGIN}\n${text}\n${END}`;

// A legacy import can have Claude-only text around it. Mirror just the shared
// region in that case, retaining every byte outside the region on subsequent syncs.
function claudeDocument(raw, agents) {
  if (raw === null) return { shared: null, render: (text) => text };
  const markers = [...raw.matchAll(/^(<!-- (?:>>> easy-agnostic shared instructions >>>|<<< easy-agnostic shared instructions <<<) -->)\r?$/gm)];
  if (markers.length) {
    if (markers.length !== 2 || markers[0][1] !== BEGIN || markers[1][1] !== END) throw new Error('CLAUDE.md: damaged shared instruction markers; repair them before syncing');
    const start = markers[0].index + markers[0][0].length + 1;
    const end = markers[1].index;
    if (start >= end || raw[end - 1] !== '\n') throw new Error('CLAUDE.md: damaged shared instruction block');
    const sharedEnd = raw[end - 2] === '\r' ? end - 2 : end - 1;
    return {
      shared: raw.slice(start, sharedEnd),
      render: (text) => raw.slice(0, start) + text + raw.slice(sharedEnd),
    };
  }
  const imports = [...raw.matchAll(/^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*\r?$/gm)];
  if (!imports.length) return { shared: raw, render: (text) => text };
  if (imports.length !== 1 || agents === null) throw new Error('CLAUDE.md: expected one @AGENTS.md import and an existing AGENTS.md');
  if (raw.trim() === '@AGENTS.md' || raw.trim() === '@./AGENTS.md') return { shared: agents, render: (text) => text };
  const match = imports[0];
  return {
    shared: agents,
    render: (text) => raw.slice(0, match.index) + block(text) + raw.slice(match.index + match[0].length),
  };
}

function read(file) {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`${file}: instruction sync requires a regular file (symlinks are left alone)`);
    return fs.readFileSync(file, 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Keep machine-local enrollment and hashes outside the repository. No instruction
// content is exposed in status output or stored in the baseline.
export function instructionPaths(root) {
  root = fs.realpathSync(root);
  const dir = path.join(EAG_HOME, '.state', 'instructions', hash(root));
  return { root, dir, state: path.join(dir, 'state.json'), lock: path.join(dir, 'sync.lock') };
}

export function syncInstructions(root, { dryRun = false, prefer = null, trackedOnly = false } = {}) {
  if (prefer !== null && !Object.hasOwn(names, prefer)) throw new Error('--prefer must be agents or claude');
  const p = instructionPaths(root);
  // Preview must not create state directories or lock files.
  if (trackedOnly && !fs.existsSync(p.state)) return { op: 'skipped', message: 'instruction sync is not enabled' };
  let lock;
  if (!dryRun) {
    fs.mkdirSync(p.dir, { recursive: true });
    try { lock = fs.openSync(p.lock, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(`instruction sync is locked: ${p.lock}. If no eag sync is running, remove this stale lock and retry`);
      throw e;
    }
  }
  try {
    const missing = Symbol('missing');
    const saved = readJson(p.state, missing);
    if (saved !== missing && (saved?.version !== 1 || !/^[a-f0-9]{64}$/.test(saved?.hash))) throw new Error(`${p.state}: invalid instruction baseline`);
    const state = saved === missing ? null : saved;
    const files = Object.fromEntries(Object.entries(names).map(([k, n]) => [k, path.join(p.root, n)]));
    const texts = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, read(f)]));
    const result = (op, message) => ({ op, message });
    if (texts.agents === null && texts.claude === null) return result('skipped', 'no AGENTS.md or CLAUDE.md at the project root');

    // Never copy an import of the counterpart into that counterpart.
    const importsClaude = /^\s*@(?:\.\/)?CLAUDE\.md\s*$/m.test(texts.agents ?? '');
    if (importsClaude) return result('conflict', 'AGENTS.md imports CLAUDE.md; remove the counterpart import before syncing');
    const doc = claudeDocument(texts.claude, texts.agents);
    const shared = { agents: texts.agents, claude: doc.shared };
    if (Object.values(shared).some((text) => /^[ \t]*@(?:\.\/)?(?:AGENTS|CLAUDE)\.md[ \t]*\r?$/m.test(text ?? ''))) return result('conflict', 'shared instructions import a mirrored file; remove the circular import before syncing');
    if (Object.values(shared).some((text) => text?.includes(BEGIN) || text?.includes(END))) throw new Error('shared instructions contain reserved eag markers; remove nested markers before syncing');
    let chosen;
    if (prefer) {
      if (shared[prefer] === null) throw new Error(`${names[prefer]} does not exist; cannot prefer it`);
      chosen = shared[prefer];
    } else if (shared.agents === shared.claude) chosen = shared.agents;
    else if (shared.agents === null || shared.claude === null) {
      // Deletion after enrollment is intentional until explicitly resolved.
      if (state) return result('conflict', 'an instruction file was removed; restore it or select the surviving file with --prefer agents|claude');
      chosen = shared.agents ?? shared.claude;
    } else if (state && hash(shared.agents) === state.hash) chosen = shared.claude;
    else if (state && hash(shared.claude) === state.hash) chosen = shared.agents;
    else return result('conflict', 'AGENTS.md and CLAUDE.md differ; reconcile them or run eag instructions --prefer agents|claude');

    const desired = { agents: chosen, claude: doc.render(chosen) };
    const changed = Object.keys(names).filter((k) => texts[k] !== desired[k]);
    const baselineChanged = state?.hash !== hash(chosen);
    if (!dryRun) {
      for (const k of changed) {
        // The lock serializes eag writers; this catches edits made after planning.
        for (const key of Object.keys(names)) if (read(files[key]) !== texts[key]) throw new Error('instructions changed during sync; retry');
        backup(files[k], path.join(p.dir, 'backup'), k);
        // A newly shared copy must not widen the source's permissions.
        const sourceKey = Object.keys(names).find((key) => shared[key] === chosen && texts[key] !== null);
        const sourceMode = fs.statSync(files[sourceKey]).mode & 0o777;
        const mode = texts[k] === null ? sourceMode : (fs.statSync(files[k]).mode & sourceMode & 0o777);
        // Check again after preparing the backup, which can take time for large files.
        for (const key of Object.keys(names)) if (read(files[key]) !== texts[key]) throw new Error('instructions changed during sync; retry');
        writeFileAtomic(files[k], desired[k], mode);
        texts[k] = desired[k];
      }
      for (const k of Object.keys(names)) if (read(files[k]) !== desired[k]) throw new Error('instructions changed during sync; baseline not saved; retry');
      if (baselineChanged) writeJson(p.state, { version: 1, hash: hash(chosen) }, 0o600);
    }
    return result(changed.length ? 'sync' : baselineChanged ? 'enroll' : 'noop', changed.length
      ? `${dryRun ? 'would sync' : 'synced'} ${changed.map((k) => names[k]).join(', ')}; shared instructions match and Claude-only text is preserved`
      : baselineChanged ? `${dryRun ? 'would enable' : 'enabled'} bidirectional instruction sync` : 'AGENTS.md and CLAUDE.md are in sync');
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(p.lock); }
  }
}
