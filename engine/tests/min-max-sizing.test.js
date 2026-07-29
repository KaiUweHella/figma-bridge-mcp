// Min/max sizing (sizing regression): minWidth/maxWidth/minHeight/
// maxHeight were never read — "Breite: Fill" rebuilt as fixed px because the
// bounds that make fill safe were missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWalkerCode } from '../src/design-extract.js';
import { layoutSeg, formatCodeSpec, styleFields } from '../src/lib/code-spec.js';

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (root) =>
  new Function('figma', `return ${nodeWalkerCode(root.id)}`)(stubFigma(root));

test('walker: min/max width and height are captured; null stays silent', async () => {
  const root = {
    id: 'm:1', name: 'Card', type: 'FRAME', visible: true, width: 400, height: 300,
    layoutMode: 'HORIZONTAL', children: [],
    minWidth: 200, maxWidth: 560.4, minHeight: null, maxHeight: null,
  };
  const out = JSON.parse(await runWalker(root)).frames[0];
  assert.equal(out.mnw, 200);
  assert.equal(out.mxw, 560);
  assert.equal(out.mnh, undefined, 'null bounds are not emitted');
  assert.equal(out.mxh, undefined);
});

test('layoutSeg renders min/max next to the fill/hug markers', () => {
  const seg = layoutSeg({ lm: 'HORIZONTAL', sh: 'FILL', mnw: 200, mxw: 560 }, { detail: true });
  assert.match(seg, /w:fill min-w:200 max-w:560/);
  const vertical = layoutSeg({ mnh: 44 }, { detail: true });
  assert.equal(vertical, 'min-h:44');
});

test('min/max are style-bundle relevant and reach the yaml/json model', () => {
  assert.equal(styleFields({ mnw: 200 }).mnw, 200);
});

test('style footer spells out the fill→CSS mapping', () => {
  const md = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'F', id: 'f:1' }] }, { phase: 'style' });
  assert.match(md, /`w:fill` = stretch into the parent/);
  assert.match(md, /NEVER a fixed px width/);
  const structureOnly = formatCodeSpec({ id: 'r', name: 'X', frames: [{ t: 'FRAME', n: 'F', id: 'f:1' }] }, { phase: 'structure' });
  assert.doesNotMatch(structureOnly, /w:fill` = stretch/);
});
