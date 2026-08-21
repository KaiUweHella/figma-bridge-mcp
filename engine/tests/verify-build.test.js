// verify-build: the mechanical assets.json-vs-build check (acceptance evidence: a one-line
// grep found all three dropped SVGs — this command is that grep, made a tool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyBuild, describeMissing } from '../src/lib/verify-build.js';
import { assetContentDigest } from '../src/lib/asset-manifest.js';

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

test('verifyBuild: Manifest v2 detects a physically tampered asset even when the filename is referenced', () => {
  const original = Buffer.from('<svg width="8" height="8"><path fill="red" d="M0 0h8v8z"/></svg>');
  const tampered = Buffer.from('<svg width="8" height="8"><path fill="blue" d="M0 0h8v8z"/></svg>');
  const v2 = {
    schemaVersion: 2,
    root: '1:1',
    rootName: 'Frame',
    assets: [{
      sourceIdentity: 'design-entity:icon.alert',
      contentDigest: assetContentDigest(original, 'vector'),
      semanticLabel: 'alert',
      file: 'alert.svg',
      kind: 'vector',
      placements: [{ nodeId: '1:2', rootId: '1:1' }],
    }],
  };
  const source = [{ path: 'src/App.tsx', text: "import alert from './assets/alert.svg';" }];

  const clean = verifyBuild([v2], source, [{ file: 'alert.svg', path: 'assets/alert.svg', bytes: original }]);
  assert.deepEqual(clean.integrity.mismatched, []);
  assert.deepEqual(clean.integrity.checked, ['alert.svg']);

  const changed = verifyBuild([v2], source, [{ file: 'alert.svg', path: 'assets/alert.svg', bytes: tampered }]);
  assert.equal(changed.missing.length, 0, 'the build still references the filename');
  assert.equal(changed.integrity.mismatched.length, 1);
  assert.equal(changed.integrity.mismatched[0].file, 'alert.svg');
  assert.equal(changed.integrity.mismatched[0].expected, v2.assets[0].contentDigest);
  assert.equal(changed.integrity.mismatched[0].actual, assetContentDigest(tampered, 'vector'));
});

test('describeMissing: placement fields make the report line actionable', () => {
  const line = describeMissing({
    file: 'navigation-step.svg',
    entries: [{
      width: 26, height: 34, x: -13, y: 4, rootX: 0, rootY: 488, rootId: '12:34',
      parent: 'Sidebar / Menu', parentId: '12:35',
      absolutePosition: true, overhang: true,
    }],
  });
  assert.match(line, /navigation-step\.svg \(26×34\) @ root 0,488 \[root 12:34\] in "Sidebar \/ Menu" \[parent 12:35\]/);
  assert.match(line, /absolutely positioned/);
  assert.match(line, /overhangs its parent/);
});

test('describeMissing: legacy parent coordinates stay explicitly labeled', () => {
  assert.equal(describeMissing({ file: 'x.svg', entries: [{ x: -13, y: 4 }] }),
    'x.svg @ parent -13,4');
});

test('describeMissing: degrades gracefully without placement data', () => {
  assert.equal(describeMissing({ file: 'x.svg', entries: [{}] }), 'x.svg');
  assert.equal(describeMissing({ file: 'x.svg', entries: [] }), 'x.svg');
});

test('verify-build CLI fails when a referenced Manifest v2 asset was tampered with', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = mkdtempSync(join(tmpdir(), 'verify-build-integrity-'));
  const assetsDir = join(dir, 'src', 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const original = Buffer.from('<svg width="8" height="8"><path fill="red" d="M0 0h8v8z"/></svg>');
  const tampered = Buffer.from('<svg width="8" height="8"><path fill="blue" d="M0 0h8v8z"/></svg>');
  writeFileSync(join(assetsDir, 'alert.svg'), tampered);
  writeFileSync(join(assetsDir, 'assets.json'), JSON.stringify({
    schemaVersion: 2,
    root: '1:1',
    rootName: 'Frame',
    roots: [{ id: '1:1', name: 'Frame' }],
    assets: [{
      sourceIdentity: 'design-entity:icon.alert',
      contentDigest: assetContentDigest(original, 'vector'),
      semanticLabel: 'alert',
      file: 'alert.svg',
      kind: 'vector',
      placements: [{ nodeId: '1:2', rootId: '1:1' }],
    }],
  }));
  writeFileSync(join(dir, 'src', 'App.tsx'), "import alert from './assets/alert.svg';");
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [entry, 'verify-build', dir, '--json'])
    .then((value) => ({ code: 0, ...value }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));

  assert.equal(result.code, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.missing.length, 0, 'the source still references alert.svg');
  assert.equal(output.integrity.mismatched.length, 1);
  assert.equal(output.integrity.mismatched[0].file, 'alert.svg');
});

// ---- CLI smoke: the offline visual pass (--compare + --design) ----

test('verify-build --compare --design: offline visual diff end to end', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { PNG } = await import('pngjs');

  const dir = mkdtempSync(join(tmpdir(), 'verify-build-visual-'));
  mkdirSync(join(dir, 'src', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'src', 'assets', 'assets.json'), JSON.stringify({
    root: '1:1', rootName: 'Frame', roots: [{ id: '1:1', name: 'Frame' }],
    assets: [{ nodeId: '1:2', file: 'deco.svg', kind: 'vector' }],
  }));
  writeFileSync(join(dir, 'src', 'App.tsx'), "import deco from './assets/deco.svg';");
  const mkPng = (paint) => {
    const png = new PNG({ width: 80, height: 60 });
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4;
      const [r, g, b] = paint(x, y);
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  };
  writeFileSync(join(dir, 'design.png'), mkPng(() => [255, 255, 255]));
  writeFileSync(join(dir, 'build.png'), mkPng((x, y) => (x < 40 && y < 30) ? [255, 0, 0] : [255, 255, 255]));

  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const run = (extra) => promisify(execFile)(process.execPath,
    [entry, 'verify-build', dir, '--compare', join(dir, 'build.png'), '--design', join(dir, 'design.png'), '--json', ...extra])
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

  // Informational by default: a quarter of the image differs, exit stays 0.
  const ok = await run([]);
  assert.equal(ok.code, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.missing.length, 0);
  assert.ok(out.visual.diffPct > 20 && out.visual.diffPct < 30, `~25% expected, got ${out.visual.diffPct}`);
  assert.equal(out.visual.reference.source, 'file');
  assert.ok(out.visual.regions.length >= 1);
  assert.ok(existsSync(out.visual.diffOut), 'diff PNG must be written');

  // --max-diff gates the exit code.
  const gated = await run(['--max-diff', '5']);
  assert.equal(gated.code, 1);
});
