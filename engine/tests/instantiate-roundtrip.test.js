import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'src', 'index.js');
function run(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}
// Gate on a LIVE Figma connection, not just a running daemon: probe with a
// trivial eval. When Figma is not connected the CLI exits 1 → execFileSync
// throws → we skip. Only a real round-trip (exit 0, 'ok') unlocks the test.
function figmaReady() {
  try { return /ok/.test(run(['eval', `(async () => 'ok')()`])); } catch { return false; }
}

// eval source that creates a 2-variant "Button" COMPONENT_SET and returns its id.
const BUILD_SET = `(async () => {
  const mk = (name) => { const c = figma.createComponent(); c.name = name; c.resize(80, 40); return c; };
  const a = mk('Size=Small'); const b = mk('Size=Large');
  const set = figma.combineAsVariants([a, b], figma.currentPage);
  set.name = 'Button';
  return JSON.stringify({ id: set.id });
})()`;

const cleanup = (id) => `(async () => {
  const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
  if (n) n.remove();
  return 'ok';
})()`;

test('extract → instantiate roundtrip (gated on a connected Figma)', { skip: !figmaReady() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-'));
  const md = join(dir, 'DESIGN.md');
  let setId;
  try {
    const built = JSON.parse(run(['eval', BUILD_SET]).trim().split('\n').pop());
    setId = built.id;

    run(['extract', md]);
    const text = readFileSync(md, 'utf8');
    assert.match(text, /### Button/);
    assert.match(text, /Reuse: import existing/);

    const out = run(['instantiate', 'Button', '--file', md]);
    assert.match(out, /Instanced "Button" via (key|id)/);
  } finally {
    // Delete the created set (and the instance, selected by `instantiate`).
    if (setId) { try { run(['eval', cleanup(setId)]); } catch {} }
    try { run(['eval', `(async () => { const s = figma.currentPage.selection; s.forEach(n => n.remove()); return 'ok'; })()`]); } catch {}
  }
});
