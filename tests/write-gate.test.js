// Write-confirm gate: the isWrite matrix, verified against the engine's real
// subcommand surface. Previously untested — which is how `combos`/`sizes`
// (variant generators) bypassed the gate and `node tree` (a pure read)
// demanded confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate state files before importing anything from src/.
process.env.PLUGIN_KEY_FILE = join(mkdtempSync(join(tmpdir(), 'figma-safe-gate-')), 'plugin-key');
process.env.AUDIT_LOG_PATH = join(mkdtempSync(join(tmpdir(), 'figma-safe-gate-')), 'audit.log');

const { isWrite } = await import('../src/server.js');

test('always-write commands are gated regardless of arguments', () => {
  for (const args of [
    ['render', '<Frame/>'],
    ['render-batch', '[]'],
    ['import', 'DESIGN.md'],
    ['pin', '1:2'],
    ['gradient', 'mesh', '#f00,#00f'],
    ['combos', '1:2'],          // generates a variant grid — was ungated
    ['sizes', '1:2'],           // generates size variants — was ungated
  ]) {
    assert.equal(isWrite(args), true, args.join(' '));
  }
});

test('read subcommands of gated groups pass without confirm', () => {
  for (const args of [
    ['node', 'tree', '1:2'],       // advertised in INSTRUCTIONS as a read
    ['node', 'bindings', '1:2'],
    ['component', 'list'],
    ['component', 'main', '1:2'],
    ['dev', 'list'],
    ['annotate', 'list', '1:2'],
    ['section', 'list'],
    ['grid', 'list', '1:2'],
    ['col', 'list'],
    ['var', 'list'],
    ['var', 'find', 'color'],
    ['tokens'],                    // bare = export (read)
    ['tokens', 'overlap', 'a', 'b'],
  ]) {
    assert.equal(isWrite(args), false, args.join(' '));
  }
});

test('write subcommands of gated groups require confirm', () => {
  for (const args of [
    ['node', 'delete', '1:2'],
    ['node', 'to-component', '1:2'],
    ['component', 'prop', 'add', '1:2'],
    ['component', 'combine', '1:2,1:3'],
    ['dev', 'link', '1:2', 'https://x'],
    ['annotate', 'add', 'hello'],
    ['annotate', 'clear', '1:2'],
    ['section', 'create', 'S'],
    ['grid', 'set', '1:2'],
    ['col', 'create', 'Colors'],       // was ungated (comment claimed col = colors)
    ['var', 'create', 'x'],
    ['var', 'delete-all'],
    ['tokens', 'spacing'],             // was ungated
    ['tokens', 'radii'],               // was ungated
    ['tokens', 'add', 'x', '4'],       // was ungated
    ['tokens', 'import', 'f.json'],
    ['tokens', 'import-design-md', 'DESIGN.md'],  // was ungated (exact-match miss)
  ]) {
    assert.equal(isWrite(args), true, args.join(' '));
  }
});

test('unknown subcommands of gated groups default to WRITE (safe direction)', () => {
  assert.equal(isWrite(['node', 'future-subcommand']), true);
  assert.equal(isWrite(['tokens', 'future-subcommand']), true);
});

test('map writes a repo file (figma-map.json), never the design — not gated', () => {
  assert.equal(isWrite(['map', 'storybook', 'http://localhost:6006']), false);
  assert.equal(isWrite(['map']), false);
  assert.equal(isWrite(['map', '--help']), false);
});

test('help flags and bare group commands never gate', () => {
  assert.equal(isWrite(['render', '--help']), false);
  assert.equal(isWrite(['tokens', '-h']), false);
  assert.equal(isWrite(['node']), false);        // usage output only
  assert.equal(isWrite(['node', '--flag']), false);
  assert.equal(isWrite(['canvas', 'info']), false); // read-only group
  assert.equal(isWrite([]), false);
});
