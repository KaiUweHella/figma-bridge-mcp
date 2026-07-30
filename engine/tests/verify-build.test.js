// verify-build: the mechanical assets.json-vs-build check (acceptance evidence: a one-line
// grep found all three dropped SVGs — this command is that grep, made a tool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBuild, describeMissing } from '../src/lib/verify-build.js';

const manifest = (assets) => ({ root: '1:1', rootName: 'Frame', assets });

test('verifyBuild: unreferenced manifest files are listed, referenced ones are not', () => {
  const m = manifest([
    { nodeId: '1:2', file: 'background-pattern.svg', kind: 'vector', absolutePosition: true },
    { nodeId: '1:3', file: 'metric-item.svg', kind: 'vector' },
    { nodeId: '1:4', file: 'logo.png', kind: 'image' },
  ]);
  const files = [
    { path: 'src/App.tsx', text: "import logo from './assets/logo.png';" },
    { path: 'src/Card.tsx', text: "import deco from './assets/metric-item.svg';" },
  ];
  const r = verifyBuild([m], files);
  assert.equal(r.total, 3);
  assert.deepEqual(r.referenced.sort(), ['logo.png', 'metric-item.svg']);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].file, 'background-pattern.svg');
  // The entries ride along so the report can say WHERE the file belongs.
  assert.equal(r.missing[0].entries[0].absolutePosition, true);
});

test('verifyBuild: multiple manifests merge; duplicate files dedupe by name', () => {
  const a = manifest([{ nodeId: '1:2', file: 'wave.svg' }]);
  const b = manifest([{ nodeId: '9:9', file: 'wave.svg' }, { nodeId: '9:8', file: 'dot.svg' }]);
  const r = verifyBuild([a, b], [{ path: 'x.css', text: 'url(wave.svg)' }]);
  assert.equal(r.total, 2);
  // both manifests' entries collect under the one file name
  assert.deepEqual(r.referenced, ['wave.svg']);
  assert.equal(r.missing[0].file, 'dot.svg');
});

test('verifyBuild: border-image lint reports path and 1-indexed line', () => {
  const files = [
    { path: 'src/a.css', text: '.card {\n  border-image: linear-gradient(red, blue) 1;\n}' },
    { path: 'src/b.css', text: '.ok { border: 1px solid; }' },
  ];
  const r = verifyBuild([manifest([])], files);
  assert.deepEqual(r.borderImage, [{ path: 'src/a.css', line: 2 }]);
});

test('verifyBuild: empty manifest and empty project do not throw', () => {
  const r = verifyBuild([], []);
  assert.equal(r.total, 0);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.borderImage, []);
});

test('describeMissing: placement fields make the report line actionable', () => {
  const line = describeMissing({
    file: 'navigation-step.svg',
    entries: [{
      width: 26, height: 34, x: -13, y: 4,
      parent: 'Sidebar / Menu', parentId: '12:35',
      absolutePosition: true, overhang: true,
    }],
  });
  assert.match(line, /navigation-step\.svg \(26×34\) @ -13,4 in "Sidebar \/ Menu" \[parent 12:35\]/);
  assert.match(line, /absolutely positioned/);
  assert.match(line, /overhangs its parent/);
});

test('describeMissing: degrades gracefully without placement data', () => {
  assert.equal(describeMissing({ file: 'x.svg', entries: [{}] }), 'x.svg');
  assert.equal(describeMissing({ file: 'x.svg', entries: [] }), 'x.svg');
});
