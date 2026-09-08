import fs from 'node:fs';
import path from 'node:path';
import { parseTree, getNodeValue, modify, applyEdits } from 'jsonc-parser';
import { physicalPath } from './paths.js';
import { writeFileAtomic, backup } from './util.js';

export const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function parseConfig(text) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('configuration exceeds 4 MiB');
  const errors = [], tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || tree?.type !== 'object') throw new Error('invalid JSON/JSONC configuration (content withheld)');
  const walk = (node, depth = 0) => {
    if (depth > 64) throw new Error('configuration nesting exceeds limit');
    if (node.type === 'object') {
      const keys = node.children.map(p => p.children[0].value);
      if (new Set(keys).size !== keys.length || keys.some(k => ['__proto__','constructor','prototype'].includes(k))) throw new Error('duplicate or reserved configuration key');
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(tree); return getNodeValue(tree);
}
export function readConfig(file) {
  let text;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) throw new Error('configuration must be a regular non-linked file');
      if (st.size > 4 * 1024 * 1024) throw new Error('configuration exceeds 4 MiB');
      text = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  }
  catch (e) { if (e.code === 'ENOENT') return { file, text: null, data: {} }; throw e; }
  return { file, text, data: parseConfig(text) };
}
export function guardConfig(file, { root, forbidden = [] } = {}) {
  // No aliases, even to another project or another vendor's user file.
  const boundary = physicalPath(root || path.dirname(file));
  for (let p = path.resolve(file); path.dirname(p) !== p; p = path.dirname(p)) {
    let st; try { st = fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink() && physicalPath(p) !== p && !['/tmp','/var'].includes(p)) throw new Error('native configuration aliases are refused');
  }
  const actual = physicalPath(file);
  if (root && !actual.startsWith(boundary + path.sep)) throw new Error('native configuration escapes scope');
  if (forbidden.some(p => physicalPath(p) === actual)) throw new Error('project configuration overlaps a user configuration');
}
export function renderConfig(snapshot, changes) {
  let text = snapshot.text ?? '{}\n';
  for (const [keys, value] of changes) text = applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
  parseConfig(text);
  return text;
}
export function editConfig(snapshot, changes, { dryRun = false, backupDir, guard = () => {} } = {}) {
  guard();
  const text = renderConfig(snapshot,changes);
  if (text === snapshot.text || (!changes.length && snapshot.text === null)) {
    if (!dryRun && snapshot.text !== null) {
      const fd = fs.openSync(snapshot.file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || fs.readFileSync(fd,'utf8') !== snapshot.text) throw new Error('configuration changed since planning');
        fs.fchmodSync(fd,0o600);
      } finally { fs.closeSync(fd); }
    }
    return { file: snapshot.file, changed: false };
  }
  if (dryRun) return { file: snapshot.file, changed: true, dryRun: true };
  guard();
  if (readConfig(snapshot.file).text !== snapshot.text) throw new Error('native configuration changed since planning');
  const saved = snapshot.text !== null && backupDir ? backup(snapshot.file, backupDir, path.basename(snapshot.file)) : null;
  fs.mkdirSync(path.dirname(snapshot.file), { recursive: true });
  writeFileAtomic(snapshot.file, text, 0o600, { expected: snapshot.text });
  return { file: snapshot.file, changed: true, backup: saved };
}
