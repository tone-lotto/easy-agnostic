import path from 'node:path';
import { readJson, writeJson } from './util.js';

// The snapshot of what eag wrote last time, per target. This is the third leg of
// the 3-way merge: it is how we tell "the user edited the native file" from
// "the source changed".
export function loadState(stateDir, targetId) {
  const file = path.join(stateDir, `${targetId}.json`);
  const state = readJson(file, { servers: {} });
  if (!state || typeof state !== 'object' || !state.servers || typeof state.servers !== 'object' || Array.isArray(state.servers)
    || Object.values(state.servers).some((s) => !s || typeof s !== 'object' || Array.isArray(s))) throw new Error(`${file}: invalid state snapshot; restore a valid backup before applying`);
  return state;
}
export function saveState(stateDir, targetId, servers) {
  // Rendered entries can hold literal secrets (Claude user scope), so the snapshot is 0600.
  writeJson(path.join(stateDir, `${targetId}.json`), { updatedAt: new Date().toISOString(), servers }, 0o600);
}
