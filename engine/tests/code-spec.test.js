// Walker v2 (instance descent, ids, variable bindings) + code-spec formatter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkerCode, nodeWalkerCode, dedupSiblings, formatTree } from '../src/design-extract.js';
import {
  isVectorish, identSeg, layoutSeg, paintSeg, typeSeg, specLines, formatCodeSpec,
  layerCoverage, specModel,
} from '../src/lib/code-spec.js';

// ============ walker v2 flags ============

test('walkerCode defaults keep v1 behavior (no instance descent, no ids, no vars)', () => {
  const code = walkerCode('1:1');
  assert.match(code, /RESOLVE_INSTANCES = false/);
  assert.match(code, /WITH_IDS = false/);
  assert.match(code, /WITH_VARS = false/);
});

test('walkerCode v2 flags are embedded and the code stays valid JS', () => {
  const code = walkerCode('1:1', { resolveInstances: true, withIds: true, withVars: true });
  assert.match(code, /RESOLVE_INSTANCES = true/);
  assert.match(code, /WITH_IDS = true/);
  assert.match(code, /WITH_VARS = true/);
  assert.match(code, /getMainComponentAsync/);
  assert.match(code, /boundVariables/);
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('nodeWalkerCode targets the node and walks it as the single frame', () => {
  const code = nodeWalkerCode('12:34', { resolveInstances: true });
  assert.match(code, /"12:34"/);
  assert.match(code, /frames: \[await walk\(node, 0\)\]\.filter\(Boolean\)/);
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('exact capture keeps complete text and native Figma CSS on every layer', async () => {
  const longText = 'Exact '.repeat(80);
  const root = {
    id: 'css:1', name: 'Title', type: 'TEXT', visible: true, width: 240, height: 80,
    characters: longText,
    fontName: { family: 'Inter', style: 'Bold' }, fontSize: 32,
    getCSSAsync: async () => ({ color: '#123456', 'font-size': '32px', 'text-align': 'center' }),
    children: [],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode(root.id, {
    resolveInstances: true, withIds: true, withVars: true, textLimit: 0,
  }), root));
  assert.equal(result.frames[0].txt.chars, longText, 'design-to-code text must never be truncated');
  assert.deepEqual(result.frames[0].css, {
    color: '#123456', 'font-size': '32px', 'text-align': 'center',
  });
  const output = formatCodeSpec(result, { phase: 'style', dedup: false });
  assert.match(output, /css\{color:#123456; font-size:32px; text-align:center\}/);
});

// ============ hidden-node filtering (IMPROVEMENTS #1) ============
// The walker snippets run inside Figma, but they are plain JS — so we can
// execute them against a stub `figma` global and assert real behavior
// instead of just grepping the generated string.

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  variables: { getVariableByIdAsync: async () => null },
});
const runWalker = (code, root) => new Function('figma', `return ${code}`)(stubFigma(root));
const frameFixture = () => ({
  id: '9:1', name: 'Card', type: 'FRAME', width: 100, height: 50, visible: true,
  children: [
    { id: '9:2', name: 'Shown', type: 'FRAME', width: 10, height: 10, visible: true, children: [] },
    { id: '9:3', name: 'Ghost', type: 'FRAME', width: 10, height: 10, visible: false, children: [] },
  ],
});

test('walker drops invisible nodes by default (no phantom elements)', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), frameFixture()));
  const kids = result.frames[0].kids;
  assert.equal(kids.length, 1);
  assert.equal(kids[0].n, 'Shown');
});

test('walker keeps invisible nodes with includeHidden, marked hidden:true', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1', { includeHidden: true }), frameFixture()));
  const kids = result.frames[0].kids;
  assert.equal(kids.length, 2);
  const ghost = kids.find((k) => k.n === 'Ghost');
  assert.equal(ghost.hidden, true);
  assert.equal(kids.find((k) => k.n === 'Shown').hidden, undefined);
});

test('depth 0 captures the requested node completely without descending', async () => {
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1', {
    maxDepth: 0, withIds: true,
  }), frameFixture()));
  assert.equal(result.visibleNodeCount, 1);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].id, '9:1');
  assert.equal(result.frames[0].kids, undefined);
  assert.equal(result.frames[0].more, undefined, 'node-only is intentional, not truncated');
});

test('exact component-set capture keeps the set id and includes every variant', async () => {
  const variants = [
    { id: 'set:2', key: 'REST', name: 'State=Rest', type: 'COMPONENT', visible: true, width: 80, height: 32, children: [] },
    { id: 'set:3', key: 'HOVER', name: 'State=Hover', type: 'COMPONENT', visible: true, width: 80, height: 32, children: [] },
  ];
  const root = {
    id: 'set:1', name: 'Button', type: 'COMPONENT_SET', visible: true,
    width: 180, height: 32, children: variants, defaultVariant: variants[0],
    variantGroupProperties: { State: { values: ['Rest', 'Hover'] } },
  };
  for (const variant of variants) variant.parent = root;
  const result = JSON.parse(await runWalker(nodeWalkerCode(root.id, {
    maxDepth: 1, withIds: true,
  }), root));
  assert.equal(result.frames[0].id, 'set:1');
  assert.equal(result.frames[0].dvId, 'set:2');
  assert.deepEqual(result.frames[0].kids.map((node) => node.id), ['set:2', 'set:3']);
  assert.equal(layerCoverage(result.frames, result.visibleNodeCount).complete, true);
});

test('walker exposes Figma prototype scrolling and fixed-child facts', async () => {
  const root = {
    ...frameFixture(), overflowDirection: 'VERTICAL_SCROLLING', numberOfFixedChildren: 1,
  };
  for (const child of root.children) child.parent = root;
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  assert.equal(result.frames[0].scroll, 'VERTICAL_SCROLLING');
  assert.equal(result.frames[0].kids[0].fixed, undefined);
  assert.equal(result.frames[0].kids[1], undefined, 'hidden nodes remain excluded');

  root.children[1].visible = true;
  const withFixed = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  assert.equal(withFixed.frames[0].kids[1].fixed, true);
  assert.match(layoutSeg(withFixed.frames[0], { detail: false }), /scroll:vertical/);
  assert.match(layoutSeg(withFixed.frames[0].kids[1], { detail: false }), /prototype-fixed/);
  const model = specModel(withFixed, { phase: 'structure', dedup: false });
  assert.equal(model.frames[0].scroll, 'VERTICAL_SCROLLING');
  assert.equal(model.frames[0].kids[1].fixed, true);
});

test('scroll on a vertically HUG node is marked incidental, not an inner-scroll contract', () => {
  const segment = layoutSeg({ scroll: 'VERTICAL_SCROLLING', sv: 'HUG' }, { detail: true });
  assert.match(segment, /scroll:vertical/);
  assert.match(segment, /incidental/);
  assert.match(segment, /document scroll/);
});

test('a hidden ROOT yields an empty spec rather than a crash', async () => {
  const root = { ...frameFixture(), visible: false };
  const result = JSON.parse(await runWalker(nodeWalkerCode('9:1'), root));
  assert.deepEqual(result.frames, []);
});

test('specLines marks hidden nodes loudly', () => {
  const lines = specLines({ t: 'FRAME', n: 'Ghost', hidden: true, w: 10, h: 10 }, 0, 'all');
  assert.match(lines[0], /\(hidden — not rendered\)/);
});

test('structure map exposes every layer id so exact style calls are unambiguous', () => {
  const lines = specLines({
    t: 'FRAME', n: 'Root', id: '1:1', kids: [
      { t: 'FRAME', n: 'Repeated name', id: '1:2' },
      { t: 'FRAME', n: 'Repeated name', id: '1:3' },
    ],
  }, 0, 'structure');
  assert.match(lines.join('\n'), /Root · \[1:1\]/);
  assert.match(lines.join('\n'), /Repeated name · \[1:2\]/);
  assert.match(lines.join('\n'), /Repeated name · \[1:3\]/);
});

test('layer coverage accounts for explicit rows, SVG internals and non-rendering helpers', () => {
  const frames = [{
    t: 'FRAME', n: 'Screen', kids: [
      { t: 'GROUP', n: 'Logo', kids: [
        { t: 'VECTOR', n: 'Path A' },
        { t: 'VECTOR', n: 'Path B' },
      ] },
      { t: 'RECTANGLE', n: 'Bounds' },
      { t: 'TEXT', n: 'Label', txt: { chars: 'Hello' } },
    ],
  }];
  assert.deepEqual(layerCoverage(frames, 6), {
    sourceVisible: 6,
    captured: 6,
    explicitRows: 3,
    assetInternalLayers: 2,
    componentInternalLayers: 0,
    nonRenderingHelpers: 1,
    unaccounted: 0,
    complete: true,
  });
  const output = formatCodeSpec({ id: '1:1', name: 'Screen', visibleNodeCount: 6, frames }, {
    phase: 'style', dedup: false,
  });
  assert.match(output, /Layer coverage: 6\/6 visible Figma layers accounted for/);
  assert.match(output, /0 unaccounted/);
});

test('structure-only spec ends with the "pull style too" reminder; full spec does not', () => {
  const result = { id: '1:1', name: 'X', frames: [{ t: 'FRAME', n: 'Root' }] };
  assert.match(formatCodeSpec(result, { phase: 'structure' }), /--phase style/);
  assert.doesNotMatch(formatCodeSpec(result, { phase: 'all' }), /Styles fehlen/);
});

test('walker captures sizing modes and alignment', () => {
  const code = walkerCode('1:1');
  assert.match(code, /layoutSizingHorizontal/);
  assert.match(code, /primaryAxisAlignItems/);
});

// ============ dedup with ids ============

test('dedupSiblings collapses siblings that differ only by node id', () => {
  const kids = [
    { t: 'FRAME', n: 'Row', id: '1:1', w: 100, h: 40 },
    { t: 'FRAME', n: 'Row', id: '1:2', w: 100, h: 40 },
  ];
  const out = dedupSiblings(kids);
  assert.equal(out.length, 1);
  assert.equal(out[0].repeat, 2);
});

test('dedupSiblings keeps siblings apart when their text content differs', () => {
  const kids = [
    { t: 'TEXT', n: 'Label', id: '1:1', txt: { chars: 'Total plants' } },
    { t: 'TEXT', n: 'Label', id: '1:2', txt: { chars: 'Need water' } },
  ];
  const out = dedupSiblings(kids);
  assert.equal(out.length, 2);
});

// ============ formatTree with resolved instances ============

test('formatTree prefers resolved main-component name over stale layer name', () => {
  const lines = formatTree({ t: 'INSTANCE', n: 'leaf', mc: 'leaf', main: 'calendar' }, 0);
  assert.match(lines[0], /instance of calendar/);
  assert.doesNotMatch(lines[0], /instance of leaf/);
});

test('formatTree qualifies main with the parent set and shows props', () => {
  const lines = formatTree(
    { t: 'INSTANCE', n: 'Nav', mc: 'Nav', main: 'State=Active', set: 'Nav Item', props: { State: 'Active' } },
    0,
  );
  assert.match(lines[0], /instance of Nav Item \/ State=Active/);
  assert.match(lines[0], /State=Active/);
});

// ============ code-spec formatter ============

test('isVectorish: vectors and vector-only groups are vectorish, content is not', () => {
  assert.equal(isVectorish({ t: 'VECTOR', n: 'Vector' }), true);
  assert.equal(isVectorish({ t: 'GROUP', n: 'G', kids: [{ t: 'VECTOR', n: 'V' }] }), true);
  assert.equal(isVectorish({ t: 'GROUP', n: 'G', kids: [{ t: 'TEXT', n: 'T', txt: { chars: 'x' } }] }), false);
  assert.equal(isVectorish({ t: 'FRAME', n: 'F' }), false);
});

test('identSeg quotes real text and drops the layer name when redundant', () => {
  assert.equal(identSeg({ t: 'TEXT', n: 'Overview', txt: { chars: 'Overview' } }), '"Overview"');
  assert.equal(identSeg({ t: 'TEXT', n: 'Title', txt: { chars: 'Good morning' } }), 'Title: "Good morning"');
});

test('identSeg shows resolved instance target; variant props stated by the name are not repeated', () => {
  const seg = identSeg({ t: 'INSTANCE', n: 'Nav Overview', mc: 'x', main: 'State=Active', set: 'Nav Item', props: { State: 'Active' } });
  assert.match(seg, /Nav Overview/);
  assert.equal(seg, 'Nav Overview → Nav Item/State=Active');
});

test('layoutSeg: structure phase shows only direction, style adds detail', () => {
  const node = { lm: 'HORIZONTAL', gap: 12, pad: [16, 20, 16, 20], ap: 'SPACE_BETWEEN', ac: 'CENTER', sh: 'FILL', sv: 'HUG' };
  assert.equal(layoutSeg(node, { detail: false }), 'row');
  const full = layoutSeg(node, { detail: true });
  assert.match(full, /row/);
  assert.match(full, /gap12/);
  assert.match(full, /pad16\/20/);
  assert.match(full, /main:between/);
  assert.match(full, /cross:center/);
  assert.match(full, /w:fill h:hug/);
});

test('paintSeg renders fills/strokes/radius with variable bindings', () => {
  const seg = paintSeg({
    fills: ['#ffffff'], strokes: ['#e6eae1'], sw: 1, r: 16,
    bv: { fills: 'color/surface', strokes: 'color/border', topLeftRadius: 'radius/lg' },
  });
  assert.match(seg, /fill #ffffff → var\(color\/surface\)/);
  assert.match(seg, /stroke #e6eae1 w1 → var\(color\/border\)/);
  assert.match(seg, /r16 → var\(radius\/lg\)/);
});

test('paintSeg renders shadows compactly', () => {
  const seg = paintSeg({ fx: [{ type: 'DROP_SHADOW', x: 0, y: 2, blur: 8, spread: 0, color: '#000000', a: 0.1 }] });
  assert.equal(seg, 'shadow 0/2/8/0 #000000@10%');
});

test('typeSeg renders font, size/lh and letter spacing', () => {
  const seg = typeSeg({ txt: { font: 'Inter', style: 'Semi Bold', size: 16, lh: 19, ls: 0.2 } });
  assert.equal(seg, 'Inter Semi Bold 16/19 ls0.2');
});

test('typeSeg keeps Figma-reported weight, enabled OpenType features and metadata-only axes explicit', () => {
  const seg = typeSeg({ txt: {
    font: 'Roboto Flex', style: 'Regular', weight: 357, size: 16,
    ot: ['LIGA', 'SS01'],
    axisRanges: [{ start: 0, end: 5, axes: { wght: 357, wdth: 82 } }],
  } });
  assert.match(seg, /Roboto Flex Regular fw357 16/);
  assert.match(seg, /ot\(LIGA,SS01\)/);
  assert.match(seg, /axes-meta\[0:5\]\(wght=357,wdth=82\)/);
});

test('typeSeg leads with the applied text style and shows EVERY typography token binding', () => {
  const seg = typeSeg({
    txt: { ts: 'display/medium', font: 'Clash Grotesk', style: 'Bold', size: 40, lh: 48 },
    bv: {
      fontFamily: 'fonts/family/display',
      fontStyle: 'fonts/fontweight/bold',
      fontSize: 'fonts/fontsize/xl',
      lineHeight: 'fonts/lineheight/xl',
    },
  });
  assert.match(seg, /^style:display\/medium /, 'style name is the leading segment');
  assert.match(seg, /Clash Grotesk → var\(fonts\/family\/display\)/, 'family binding rendered');
  assert.match(seg, /Bold → var\(fonts\/fontweight\/bold\)/, 'weight binding rendered (was silently dropped)');
  assert.match(seg, /40 → var\(fonts\/fontsize\/xl\)/, 'size binding rendered');
  assert.match(seg, /48 → var\(fonts\/lineheight\/xl\)/, 'line-height binding rendered');
});

test('paintSeg names the applied color style on the fill', () => {
  const seg = paintSeg({ fills: ['#0e1425'], fs: 'Color/Surface' });
  assert.equal(seg, 'fill #0e1425 → style(Color/Surface)');
});

test('ts and fs are style fields (dedup + yaml/json model carry them)', async () => {
  const { styleFields } = await import('../src/lib/code-spec.js');
  const f = styleFields({ fills: ['#fff'], fs: 'Color/Surface', txt: { chars: 'x', ts: 'label/large', size: 20 } });
  assert.equal(f.fs, 'Color/Surface');
  assert.equal(f.txt.ts, 'label/large');
  assert.equal(f.txt.chars, undefined, 'content stays out of style fields');
});

test('walker captures text-style name and merges the STYLE variable bindings (node-level wins)', async () => {
  const styles = {
    'S:txt1': {
      name: 'display/medium',
      boundVariables: {
        fontSize: { id: 'V:size' },
        fontStyle: { id: 'V:weight' },
        fontFamily: { id: 'V:family' },
      },
    },
    'S:fill1': { name: 'Color/Surface' },
  };
  const vars = { 'V:size': 'fonts/fontsize/xl', 'V:weight': 'fonts/fontweight/bold', 'V:family': 'fonts/family/display', 'V:node': 'fonts/fontsize/override' };
  const root = {
    id: 't:1', name: 'Card', type: 'FRAME', visible: true, width: 100, height: 50,
    fillStyleId: 'S:fill1',
    children: [{
      id: 't:2', name: 'Title', type: 'TEXT', visible: true, width: 80, height: 20,
      characters: 'Rechte', textStyleId: 'S:txt1',
      fontName: { family: 'Clash Grotesk', style: 'Bold' }, fontSize: 40,
      // node-level binding for fontSize — must WIN over the style's binding
      boundVariables: { fontSize: { id: 'V:node' } },
      children: [],
    }],
  };
  const figmaStub = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async (id) => (id === root.id ? root : null),
    getStyleByIdAsync: async (id) => styles[id] || null,
    variables: { getVariableByIdAsync: async (id) => (vars[id] ? { name: vars[id] } : null) },
  };
  const code = nodeWalkerCode('t:1', { resolveInstances: true, withIds: true, withVars: true });
  const result = JSON.parse(await new Function('figma', `return ${code}`)(figmaStub));
  const frame = result.frames[0];
  assert.equal(frame.fs, 'Color/Surface', 'fill style name captured');
  const text = frame.kids[0];
  assert.equal(text.txt.ts, 'display/medium', 'text style name captured');
  assert.equal(text.bv.fontSize, 'fonts/fontsize/override', 'node-level binding wins');
  assert.equal(text.bv.fontStyle, 'fonts/fontweight/bold', 'style-level weight binding merged');
  assert.equal(text.bv.fontFamily, 'fonts/family/display', 'style-level family binding merged');
});

test('walker without getStyleByIdAsync (older stubs) neither crashes nor emits ts', async () => {
  const root = {
    id: 'u:1', name: 'T', type: 'TEXT', visible: true, width: 10, height: 10,
    characters: 'x', textStyleId: 'S:whatever',
    fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, children: [],
  };
  const figmaStub = {
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async (id) => (id === root.id ? root : null),
    variables: { getVariableByIdAsync: async () => null },
  };
  const code = nodeWalkerCode('u:1', { withVars: true });
  const result = JSON.parse(await new Function('figma', `return ${code}`)(figmaStub));
  assert.equal(result.frames[0].txt.ts, undefined);
});

test('walker carries reported weight, enabled OpenType features and range axis metadata losslessly', async () => {
  const root = {
    id: 'vf:1', name: 'Variable label', type: 'TEXT', visible: true, width: 100, height: 20,
    characters: 'Hello', fontName: { family: 'Roboto Flex', style: 'Regular' },
    fontWeight: 357, fontSize: 16, openTypeFeatures: { LIGA: true, SS01: false },
    getPluginData: () => JSON.stringify({
      schemaVersion: 1,
      ranges: [{ start: 0, end: 5, axes: { wght: 357, wdth: 82 } }],
    }),
    children: [],
  };
  const result = JSON.parse(await runWalker(nodeWalkerCode(root.id, { withIds: true }), root));
  const text = result.frames[0];
  assert.equal(text.txt.weight, 357);
  assert.deepEqual(text.txt.ot, ['LIGA']);
  assert.deepEqual(text.txt.axisRanges, [{ start: 0, end: 5, axes: { wght: 357, wdth: 82 } }]);
});

test('walker and tree keep mixed rich-text run styles instead of flattening the text layer', async () => {
  const mixed = Symbol('mixed');
  const root = {
    id: 'rt:1', name: 'Rich label', type: 'TEXT', visible: true, width: 160, height: 24,
    characters: 'Hello world', fontName: mixed, fontWeight: mixed, fontSize: mixed,
    lineHeight: mixed, letterSpacing: mixed, openTypeFeatures: mixed,
    getStyledTextSegments: () => [
      {
        start: 0, end: 5, characters: 'Hello',
        fontName: { family: 'Inter', style: 'Regular' }, fontWeight: 400, fontSize: 16,
        lineHeight: { unit: 'PIXELS', value: 20 }, letterSpacing: { unit: 'PIXELS', value: 0 },
        fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
        textDecoration: 'NONE', textCase: 'ORIGINAL', openTypeFeatures: {}, boundVariables: {},
      },
      {
        start: 6, end: 11, characters: 'world',
        fontName: { family: 'Inter', style: 'Bold' }, fontWeight: 700, fontSize: 18,
        lineHeight: { unit: 'PERCENT', value: 150 }, letterSpacing: { unit: 'PERCENT', value: 2 },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }],
        textDecoration: 'UNDERLINE', textCase: 'UPPER', openTypeFeatures: { SS01: true }, boundVariables: {},
      },
    ],
    children: [],
  };
  const figmaStub = {
    mixed,
    getNodeByIdAsync: async (id) => (id === root.id ? root : null),
    getStyleByIdAsync: async () => null,
    variables: { getVariableByIdAsync: async () => null },
  };
  const code = nodeWalkerCode(root.id, { resolveInstances: true, withIds: true, withVars: true, textLimit: 0 });
  const result = JSON.parse(await new Function('figma', `return ${code}`)(figmaStub));
  const runs = result.frames[0].txt.runs;
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], {
    start: 0, end: 5, chars: 'Hello', font: 'Inter', style: 'Regular', weight: 400,
    size: 16, lh: 20, fills: ['#ff0000'],
  });
  assert.deepEqual(runs[1], {
    start: 6, end: 11, chars: 'world', font: 'Inter', style: 'Bold', weight: 700,
    size: 18, lh: 27, ls: '2%', fills: ['#0000ff'], decoration: 'UNDERLINE',
    case: 'UPPER', ot: ['SS01'],
  });
  const output = formatCodeSpec(result, { phase: 'style', dedup: false });
  assert.match(output, /runs\{0:5 "Hello" → Inter Regular fw400 16\/20 · fill #ff0000/);
  assert.match(output, /6:11 "world" → Inter Bold fw700 18\/27 ls2% · fill #0000ff · decoration:underline · case:upper · ot\(SS01\)/);
});

const SPEC_FIXTURE = {
  id: '1:2', name: 'Dashboard',
  frames: [{
    t: 'FRAME', n: 'Stats', id: '1:3', w: 1008, h: 145, lm: 'HORIZONTAL', gap: 16,
    fills: ['#ffffff'], bv: { fills: 'color/surface' },
    kids: [
      {
        t: 'INSTANCE', n: 'Stat Total', id: '1:4', w: 240, h: 145, mc: 'Stat Total', main: 'Stat Card',
        kids: [
          { t: 'TEXT', n: 'Total plants', id: '1:5', txt: { chars: 'Need water', font: 'Inter', style: 'Medium', size: 12 } },
          { t: 'GROUP', n: 'Icon paths', id: '1:6', kids: [{ t: 'VECTOR', n: 'Vector', id: '1:7' }] },
        ],
      },
    ],
  }],
};

test('specLines structure phase: hierarchy + content + target ids, no sizes', () => {
  const lines = specLines(SPEC_FIXTURE.frames[0], 0, 'structure');
  const text = lines.join('\n');
  assert.match(text, /Stats · row/);
  assert.match(text, /Stat Total → Stat Card/);
  // The OVERRIDE characters, not the stale layer name:
  assert.match(text, /Total plants: "Need water"/);
  assert.doesNotMatch(text, /1008×145/);
  assert.match(text, /\[1:3\]/);
  assert.doesNotMatch(text, /Vector/);
});

test('specLines style phase: sizes, paints with tokens, typography, ids', () => {
  const lines = specLines(SPEC_FIXTURE.frames[0], 0, 'style');
  const text = lines.join('\n');
  assert.match(text, /1008×145/);
  assert.match(text, /fill #ffffff → var\(color\/surface\)/);
  assert.match(text, /Inter Medium 12/);
  assert.match(text, /\[1:3\]/);
});

test('formatCodeSpec emits both phases for phase=all and a copy-dont-invent footer', () => {
  const md = formatCodeSpec(SPEC_FIXTURE, { phase: 'all' });
  assert.match(md, /# Code-Spec: Dashboard \(1:2\)/);
  assert.match(md, /## Structure/);
  assert.match(md, /## Style/);
  assert.match(md, /copy, never invent/);
});

test('formatCodeSpec phase=structure omits the style section', () => {
  const md = formatCodeSpec(SPEC_FIXTURE, { phase: 'structure' });
  assert.match(md, /## Structure/);
  assert.doesNotMatch(md, /## Style/);
});

test('specLines notes depth-truncated children explicitly', () => {
  const lines = specLines({ t: 'FRAME', n: 'Deep', more: 5 }, 0, 'structure');
  assert.match(lines.join('\n'), /…5 more \(depth limit/);
});

// ============ acceptance: the test missing-decor bug class ============
// End-to-end walker → formatter over a fixture modeled on the reported
// nodes: gradient overlay rectangle, deco wave vector, nav glyph, bubble
// shape, clipped card frame. NONE of these may vanish from the spec.

test('ACCEPTANCE: decorative vectors, gradient overlays and clip survive walker → spec (text AND model)', async () => {
  const stub = (root) => ({
    mixed: Symbol('mixed'),
    getNodeByIdAsync: async (id) => (id === root.id ? root : null),
    variables: { getVariableByIdAsync: async () => null },
  });
  const container = {
    id: 'c:1', name: 'content-container', type: 'FRAME', visible: true,
    width: 1200, height: 800, layoutMode: 'NONE', clipsContent: true, children: [],
  };
  container.children = [
    { // gradient overlay, overhangs the frame — Figma clips it
      id: 'c:2', name: 'Rectangle 28', type: 'RECTANGLE', visible: true,
      width: 600, height: 600, x: 0, y: -100, opacity: 0.8,
      constraints: { horizontal: 'MIN', vertical: 'MIN' },
      fills: [{ type: 'GRADIENT_LINEAR', gradientStops: [
        { position: 0, color: { r: 0x29 / 255, g: 0x50 / 255, b: 0xa3 / 255, a: 1 } },
        { position: 1, color: { r: 0x21 / 255, g: 0x30 / 255, b: 0x59 / 255, a: 0 } },
      ] }], children: [], parent: container,
    },
    { // deco wave — hand-drawn vector
      id: 'c:3', name: 'Vector', type: 'VECTOR', visible: true,
      width: 204, height: 363, x: 159, y: 0,
      fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.5 } }],
      children: [], parent: container,
    },
    { // notification bubble: frame w/ fill + speech-bubble vector inside
      id: 'c:4', name: 'notification-bubble', type: 'FRAME', visible: true,
      width: 28, height: 34, x: 900, y: 10, layoutMode: 'NONE', children: [], parent: container,
    },
    { // real content — keeps the container itself from collapsing to art
      id: 'c:6', name: 'Headline', type: 'TEXT', visible: true,
      width: 400, height: 40, x: 24, y: 24, characters: 'Rechteverwaltung',
      fontName: { family: 'Geist', style: 'Medium' }, fontSize: 28,
      children: [], parent: container,
    },
  ];
  container.children[2].children = [{
    id: 'c:5', name: 'Vector', type: 'VECTOR', visible: true,
    width: 22, height: 30, x: 903, y: 12,
    fills: [{ type: 'SOLID', color: { r: 0xd5 / 255, g: 0xf3 / 255, b: 0x79 / 255 } }],
    children: [], parent: container.children[2],
  }];
  const code = nodeWalkerCode('c:1', { resolveInstances: true, withIds: true, withVars: true });
  const result = JSON.parse(await new Function('figma', `return ${code}`)(stub(container)));

  const text = formatCodeSpec(result, { phase: 'all' });
  assert.match(text, /clip/, 'clipsContent reaches the spec');
  assert.match(text, /Rectangle 28 .*linear-gradient/, 'gradient overlay rendered with its gradient');
  assert.match(text, /abs left:0 top:-100/, 'overlay position present (overhang readable against clip)');
  assert.match(text, /\(clipped by parent\)/, 'overhang against a clipping parent is flagged');
  assert.match(text, /opacity 80%/, 'layer opacity present');
  assert.match(text, /Vector · 204×363 · vector art → assets\//, 'deco wave listed as exportable artwork');
  assert.match(text, /vector art → assets\/notification-bubble\.svg/, 'small glyph inside the bubble listed');

  const { specModel } = await import('../src/lib/code-spec.js');
  const model = specModel(result, { phase: 'all' });
  const json = JSON.stringify(model);
  assert.match(json, /vectorArt/, 'yaml/json model carries the artwork pointers too');
  assert.match(json, /linear-gradient/, 'yaml/json model carries the gradient');
  assert.match(json, /"clip":true/, 'yaml/json model carries clip');
});
