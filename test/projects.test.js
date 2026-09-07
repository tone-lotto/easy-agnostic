import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, write } from './helpers.js';

const dir = sandbox();
const projects = await import('../src/projects.js');
const { CLAUDE_JSON, EAG_HOME } = await import('../src/paths.js');

const setClaude = (obj) => write(CLAUDE_JSON, JSON.stringify(obj, null, 2));
const repo = (name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };

test('claudeLocalProjects lists only projects that actually have servers', () => {
  const a = repo('alpha');
  const b = repo('beta');
  setClaude({
    mcpServers: { global: { url: 'https://g' } },        // user scope: not a project
    projects: {
      [a]: { mcpServers: { one: { url: 'https://1' }, two: { url: 'https://2' } } },
      [b]: { mcpServers: {} },                            // empty: nothing to migrate
      [path.join(dir, 'gamma')]: { lastCost: 1 },         // a project with no servers at all
    },
  });
  const got = projects.claudeLocalProjects();
  assert.equal(got.length, 1);
  assert.equal(got[0].root, a);
  assert.deepEqual(got[0].names, ['one', 'two']);
});

test('a project whose directory is gone is skipped, not migrated', () => {
  const gone = path.join(dir, 'deleted-repo');
  setClaude({ projects: { [gone]: { mcpServers: { x: { url: 'https://x' } } } } });
  assert.match(projects.skipReason(gone), /no longer exists/);
  assert.equal(projects.migratable()[0].skip, projects.skipReason(gone));
});

// The case that made paths.js grow a guard: EAG_HOME defaults to ~/.agents, so $HOME as a
// "project" would put project policy in the machine-wide agents.json.
test('a project whose .agents/ is EAG_HOME is skipped', () => {
  const home = path.dirname(EAG_HOME);
  assert.match(projects.skipReason(home), /user-level config/);
});

test('a normal existing repo is migratable', () => {
  const r = repo('normal');
  assert.equal(projects.skipReason(r), null);
});

test('a .mcp.json that does not parse is skipped rather than overwritten', () => {
  const r = repo('broken');
  write(path.join(r, '.mcp.json'), 'not json');
  assert.match(projects.skipReason(r), /does not parse/);
});

test('migratable pairs every project with its reason, keeping the skipped ones visible', () => {
  const ok = repo('visible-ok');
  const gone = path.join(dir, 'visible-gone');
  setClaude({ projects: {
    [ok]: { mcpServers: { a: { url: 'https://a' } } },
    [gone]: { mcpServers: { b: { url: 'https://b' } } },
  } });
  const got = projects.migratable();
  assert.equal(got.length, 2, 'a skipped project must still be reported, not dropped');
  assert.equal(got.find((p) => p.root === ok).skip, null);
  assert.match(got.find((p) => p.root === gone).skip, /no longer exists/);
});
