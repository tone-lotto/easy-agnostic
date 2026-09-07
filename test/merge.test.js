import test from 'node:test';
import assert from 'node:assert/strict';
import { planMerge, hasDrift, hasWrites, summarize } from '../src/merge.js';
import { mergeArgs, opOf } from './helpers.js';

const A = { url: 'https://a' };
const B = { url: 'https://b' };
const C = { url: 'https://c' };

test('every presence combination classifies as documented', () => {
  const cases = [
    // [desired, state, native, expected op]
    [A, undefined, undefined, 'create'],
    [A, A, A, 'noop'],
    [B, A, A, 'update'],           // source changed, native still what we wrote
    [A, B, A, 'refresh'],          // native already matches source
    [A, B, C, 'conflict'],         // all three differ
    [A, A, undefined, 'conflict'], // removed natively since last apply
    [undefined, A, A, 'delete'],   // removed from source, native untouched
    [undefined, A, B, 'conflict'], // removed from source but edited natively
    [undefined, A, undefined, 'forget'],
    [undefined, undefined, A, 'unmanaged'],
  ];
  for (const [d, s, n, expected] of cases) {
    const actions = planMerge(mergeArgs({
      desired: d ? { x: d } : {},
      state: s ? { x: s } : {},
      native: n ? { x: n } : {},
    }));
    assert.equal(opOf(actions, 'x'), expected, `desired=${!!d} state=${!!s} native=${!!n}`);
  }
});

test('desired + native without state: equal adopts, different conflicts', () => {
  assert.equal(opOf(planMerge(mergeArgs({ desired: { x: A }, native: { x: A } })), 'x'), 'adopt');
  assert.equal(opOf(planMerge(mergeArgs({ desired: { x: A }, native: { x: B } })), 'x'), 'conflict');
});

test('a locked name is never adopted, only noticed', () => {
  const locked = new Set(['x']);
  assert.equal(opOf(planMerge(mergeArgs({ desired: { x: A }, native: { x: A }, locked })), 'x'), 'noop');
  assert.equal(opOf(planMerge(mergeArgs({ desired: { x: A }, native: { x: B }, locked })), 'x'), 'conflict');
});

test('key order never produces a phantom conflict', () => {
  const one = { url: 'https://a', type: 'http', headers: { b: '2', a: '1' } };
  const other = { headers: { a: '1', b: '2' }, type: 'http', url: 'https://a' };
  assert.equal(opOf(planMerge(mergeArgs({ desired: { x: one }, state: { x: other }, native: { x: one } })), 'x'), 'noop');
});

test('--prefer source resolves a conflict towards the source', () => {
  const a = planMerge(mergeArgs({ desired: { x: A }, state: { x: B }, native: { x: C }, prefer: 'source' }));
  assert.equal(opOf(a, 'x'), 'update');
  // removed from source, edited natively -> the source says "gone"
  const b = planMerge(mergeArgs({ state: { x: B }, native: { x: C }, prefer: 'source' }));
  assert.equal(opOf(b, 'x'), 'delete');
  // removed natively, still in source -> put it back
  const c = planMerge(mergeArgs({ desired: { x: A }, state: { x: B }, prefer: 'source' }));
  assert.equal(opOf(c, 'x'), 'create');
});

test('--prefer native only refreshes when both sides still exist', () => {
  // both sides present: keep the native table AND stay tracked
  const a = planMerge(mergeArgs({ desired: { x: A }, state: { x: B }, native: { x: C }, prefer: 'native' }));
  assert.equal(opOf(a, 'x'), 'refresh');
  assert.equal(a.find((x) => x.name === 'x').native, C);
});

// Regression: "refresh" writes `desired` back when there is nothing native to keep, so a
// conflict with no desired side used to be recorded as if eag still owned it — and the
// next run read state == native and deleted the entry the user had just asked to keep.
test('--prefer native on an entry dropped from the source disowns it, never refreshes', () => {
  const a = planMerge(mergeArgs({ state: { x: B }, native: { x: C }, prefer: 'native' }));
  assert.equal(opOf(a, 'x'), 'forget');
  assert.equal(a.find((x) => x.name === 'x').native, C, 'the native table must survive for applyPlan to keep');
});

test('--prefer never touches a locked conflict', () => {
  const locked = new Set(['x']);
  for (const prefer of ['source', 'native']) {
    const a = planMerge(mergeArgs({ desired: { x: A }, native: { x: B }, locked, prefer }));
    assert.equal(opOf(a, 'x'), 'conflict', `prefer=${prefer}`);
  }
});

test('a server named toString does not resolve through Object.prototype', () => {
  const actions = planMerge(mergeArgs({ desired: { toString: A }, state: {}, native: {} }));
  assert.equal(opOf(actions, 'toString'), 'create');
});

test('foreign marks natives eag never wrote', () => {
  const actions = planMerge(mergeArgs({ native: { x: A }, foreign: new Set(['x']) }));
  assert.equal(actions[0].foreign, true);
});

test('actions come back sorted by name', () => {
  const actions = planMerge(mergeArgs({ desired: { b: A, a: A, c: A } }));
  assert.deepEqual(actions.map((a) => a.name), ['a', 'b', 'c']);
});

test('hasDrift / hasWrites / summarize agree with the ops', () => {
  const clean = planMerge(mergeArgs({ desired: { x: A }, state: { x: A }, native: { x: A } }));
  assert.equal(hasDrift(clean), false);
  assert.equal(hasWrites(clean), false);
  const dirty = planMerge(mergeArgs({ desired: { x: B }, state: { x: A }, native: { x: A } }));
  assert.equal(hasDrift(dirty), true);
  assert.equal(hasWrites(dirty), true);
  // unmanaged alone is not drift: it is someone else's entry
  const foreign = planMerge(mergeArgs({ native: { x: A } }));
  assert.equal(hasDrift(foreign), false);
  assert.deepEqual(summarize(foreign), { unmanaged: 1 });
});
