import path from 'node:path';
import { readJson, writeJson } from './util.js';

// The snapshot of what eag wrote last time, per target. This is the third leg of
// the 3-way merge: it is how we tell "the user edited the native file" from
// "the source changed".
export function loadState(stateDir, targetId) {
  return readJson(path.join(stateDir, `${targetId}.json`), { servers: {} });
}
export function saveState(stateDir, targetId, servers) {
  // Rendered entries can hold literal secrets (Claude user scope), so the snapshot is 0600.
  writeJson(path.join(stateDir, `${targetId}.json`), { updatedAt: new Date().toISOString(), servers }, 0o600);
}
