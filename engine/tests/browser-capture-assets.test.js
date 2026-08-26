import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrowserCaptureAssets } from '../src/lib/browser-capture-assets.js';

const captureFor = (src) => ({
  version: 2,
  documentOrigin: 'http://127.0.0.1:4173',
  root: { tag: 'main', children: [{ tag: 'img', asset: { kind: 'image', src }, children: [] }] },
});

describe('browser capture asset boundary', () => {
  it('resolves same-origin SVGs beneath the explicit project root and strips the URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'figma-bridge-dom-assets-'));
    mkdirSync(join(root, 'src/assets'), { recursive: true });
    writeFileSync(join(root, 'src/assets/chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>');
    const capture = captureFor('http://127.0.0.1:4173/src/assets/chart.svg?token=secret');

    const result = resolveBrowserCaptureAssets(capture, { projectRoot: root });

    assert.match(capture.root.children[0].svg, /^<svg/);
    assert.equal(capture.root.children[0].asset, null);
    assert.deepEqual(result.diagnostics, {
      references: 1, uniqueAssets: 1, uniqueContent: 1,
      svgAssets: 1, rasterAssets: 0,
      totalBytes: Buffer.byteLength(capture.root.children[0].svg),
      policy: 'project-root-bytes',
    });
    assert.doesNotMatch(JSON.stringify(capture), /token=secret/);
  });

  it('embeds verified raster bytes and deduplicates repeated files', () => {
    const root = mkdtempSync(join(tmpdir(), 'figma-bridge-dom-assets-'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(360, 20);
    writeFileSync(join(root, 'assets/pixel.png'), png);
    const capture = captureFor('/assets/pixel.png');
    capture.root.children.push({ tag: 'img', asset: { kind: 'image', src: '/assets/pixel.png' }, children: [] });

    const result = resolveBrowserCaptureAssets(capture, { projectRoot: root });

    assert.equal(capture.root.children[0].asset.kind, 'embedded-raster');
    assert.equal(capture.root.children[0].asset.base64, png.toString('base64'));
    assert.deepEqual(
      { width: capture.root.children[0].asset.width, height: capture.root.children[0].asset.height },
      { width: 640, height: 360 },
    );
    assert.equal(capture.root.children[0].asset, capture.root.children[1].asset);
    assert.equal(result.diagnostics.references, 2);
    assert.equal(result.diagnostics.uniqueAssets, 1);
    assert.equal(result.diagnostics.totalBytes, png.length);
  });

  it('rejects cross-origin, active SVG, mismatched raster and symlink escape inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'figma-bridge-dom-assets-'));
    const outside = mkdtempSync(join(tmpdir(), 'figma-bridge-dom-assets-outside-'));
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets/active.svg'), '<svg><script>alert(1)</script></svg>');
    writeFileSync(join(root, 'assets/fake.png'), Buffer.from('not a png'));
    writeFileSync(join(outside, 'secret.svg'), '<svg/>');
    symlinkSync(join(outside, 'secret.svg'), join(root, 'assets/escape.svg'));

    assert.throws(() => resolveBrowserCaptureAssets(captureFor('https://example.com/a.svg'), { projectRoot: root }), /Cross-origin/);
    assert.throws(() => resolveBrowserCaptureAssets(captureFor('/assets/active.svg'), { projectRoot: root }), /active or unsupported/);
    assert.throws(() => resolveBrowserCaptureAssets(captureFor('/assets/fake.png'), { projectRoot: root }), /type does not match/);
    assert.throws(() => resolveBrowserCaptureAssets(captureFor('/assets/escape.svg'), { projectRoot: root }), /outside allowed roots/);
  });

  it('requires current capture provenance instead of guessing an origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'figma-bridge-dom-assets-'));
    const capture = captureFor('/asset.png');
    delete capture.documentOrigin;
    assert.throws(() => resolveBrowserCaptureAssets(capture, { projectRoot: root }), /requires capture\.documentOrigin/);
  });
});
