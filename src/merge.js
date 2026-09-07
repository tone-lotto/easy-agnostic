import { deepEqual } from './util.js';

// 3-way merge for one target. Inputs are maps name -> canonical object:
//   desired: what the source says this target should have
//   state:   what eag wrote last time
//   native:  what the agent's file has right now
// `foreign` names exist natively but were never written by eag.
// `locked` names exist natively inside someone else's managed block (cannot be edited by us).
export function planMerge({ desired, state, native, foreign = new Set(), locked = new Set(), prefer = null }) {
  const names = new Set([...desired.keys(), ...Object.keys(state), ...native.keys()]);
  const actions = [];
  for (const name of [...names].sort()) {
    const d = desired.get(name);
    const s = Object.hasOwn(state, name) ? state[name] : undefined; // a server named "toString" is not state
    const n = native.get(name);
    const isForeign = foreign.has(name);
    const isLocked = locked.has(name);
    let op, reason;
    if (d && !s && !n) { op = 'create'; reason = 'new in source'; }
    else if (d && s && n) {
      if (deepEqual(n, s)) { op = deepEqual(d, s) ? 'noop' : 'update'; reason = op === 'noop' ? 'in sync' : 'source changed'; }
      else if (deepEqual(n, d)) { op = 'refresh'; reason = 'native already matches source; refreshing state'; }
      else { op = 'conflict'; reason = 'native edited since last apply'; }
    }
    else if (d && s && !n) { op = 'conflict'; reason = 'removed natively since last apply'; }
    else if (!d && s && n) { op = deepEqual(n, s) ? 'delete' : 'conflict'; reason = op === 'delete' ? 'removed from source' : 'removed from source but edited natively'; }
    else if (!d && s && !n) { op = 'forget'; reason = 'gone on both sides'; }
    else if (d && !s && n) {
      if (deepEqual(d, n)) { op = isLocked ? 'noop' : 'adopt'; reason = isLocked ? 'managed elsewhere, already equal' : 'unmanaged entry already equal; taking ownership'; }
      else { op = 'conflict'; reason = isLocked ? 'name exists in another managed block with different content' : 'unmanaged entry with the same name and different content'; }
    }
    else { op = 'unmanaged'; reason = 'not managed by eag'; }

    if (op === 'conflict' && prefer && !isLocked) {
      if (prefer === 'source') { op = d ? (n ? 'update' : 'create') : 'delete'; reason += ' (prefer source)'; }
      // "refresh" writes `desired` back when there is no native table to keep, which would
      // undo the choice. Only a conflict that still has BOTH sides can refresh; anything
      // else is disowned, so the next apply reports it as unmanaged instead of re-deciding.
      else if (prefer === 'native') { op = n && d ? 'refresh' : 'forget'; reason += ' (prefer native)'; }
    }
    actions.push({ name, op, reason, desired: d, native: n, state: s, foreign: isForeign, locked: isLocked });
  }
  return actions;
}

export function summarize(actions) {
  const counts = {};
  for (const a of actions) counts[a.op] = (counts[a.op] || 0) + 1;
  return counts;
}
export function hasDrift(actions) { return actions.some((a) => ['create', 'update', 'delete', 'conflict', 'adopt', 'refresh', 'forget'].includes(a.op)); }
export function hasWrites(actions) { return actions.some((a) => ['create', 'update', 'delete'].includes(a.op)); }
