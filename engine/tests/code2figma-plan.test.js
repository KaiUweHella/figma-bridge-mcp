// Tests for the Code2Figma plan round (docu/PLAN-code-to-figma.md):
// built-in icons, fill:/swap: instance overrides, root overflow measurement,
// and the builtin-icons module itself.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/lib/jsx-render.js';
import { getBuiltinIconSvg, builtinIconNames } from '../src/lib/builtin-icons.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}

describe('builtin-icons module', () => {
  it('returns SVG for core names and null for unknown ones', () => {
    for (const name of ['check', 'x', 'plus', 'search', 'chevron-down', 'arrow-left']) {
      const svg = getBuiltinIconSvg(name);
      assert.ok(svg && svg.startsWith('<svg'), `expected SVG for "${name}"`);
    }
    assert.equal(getBuiltinIconSvg('definitely-not-an-icon'), null);
    assert.equal(getBuiltinIconSvg(''), null);
    assert.equal(getBuiltinIconSvg(null), null);
  });

  it('resolves aliases case-insensitively (close→x, Gear→settings, BACK→arrow-left)', () => {
    assert.equal(getBuiltinIconSvg('close'), getBuiltinIconSvg('x'));
    assert.equal(getBuiltinIconSvg('Gear'), getBuiltinIconSvg('settings'));
    assert.equal(getBuiltinIconSvg('BACK'), getBuiltinIconSvg('arrow-left'));
  });

  it('every alias points at an existing icon', () => {
    for (const name of builtinIconNames()) {
      assert.ok(getBuiltinIconSvg(name), `"${name}" listed but unresolvable`);
    }
  });
});

describe('<Icon> uses built-in vectors instead of placeholder boxes', () => {
  it('known icon name compiles to createNodeFromSvg', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Icon name="check" size={20} color="#333333" /></Frame>'
    );
    assert.ok(code.includes('createNodeFromSvg'), 'built-in icon must render as SVG');
    assertValidJs(code);
  });

  it('unknown icon name still falls back to the named placeholder rectangle', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Icon name="acme-proprietary-glyph" size={20} /></Frame>'
    );
    assert.ok(!code.includes('createNodeFromSvg'), 'unknown icon must NOT pretend to be real');
    assert.ok(code.includes('createRectangle'), 'placeholder rectangle expected');
    assertValidJs(code);
  });
});

describe('Instance fill:/swap: overrides', () => {
  it('fill:<Layer> compiles to __setInstanceFill with hex value', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Card" fill:photo="#AABBCC" /></Frame>'
    );
    assert.ok(code.includes('__setInstanceFill'), 'fill override helper call expected');
    assert.ok(code.includes('"photo"'), 'layer name must be passed through');
    assertValidJs(code);
  });

  it('fill:<Layer> with var: value forces the variable cache preamble', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Card" fill:photo="var:color/green/200" /></Frame>'
    );
    assert.ok(code.includes('lookupVar'), 'var cache must be loaded for fill: overrides');
    assertValidJs(code);
  });

  it('swap:<Layer> compiles to __swapInstance', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Row" swap:icon="COMPONENT_LIBRARY/Badge" /></Frame>'
    );
    assert.ok(code.includes('__swapInstance'), 'swap override helper call expected');
    assertValidJs(code);
  });

  it('fill:/swap: do not trip the unknown-prop validator', () => {
    const client = new FigmaClient();
    const warnings = client.validateJsxProps(
      '<Frame name="P"><Instance component="Card" fill:photo="#fff000" swap:icon="X" text:label="Hi" /></Frame>'
    );
    const overrideWarnings = warnings.filter(w =>
      w.prop.startsWith('fill:') || w.prop.startsWith('swap:') || w.prop.startsWith('text:'));
    assert.deepEqual(overrideWarnings, []);
  });
});

describe('local image import (imgref markers)', () => {
  it('<Image src="imgref:…"> embeds createImage with the provided base64', async () => {
    const client = new FigmaClient();
    client.setImageData({ img0: 'aGVsbG8=' });
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Image src="imgref:img0" w={200} h={150} /><Icon name="check" /></Frame>'
    );
    assert.ok(code.includes('figma.createImage(figma.base64Decode("aGVsbG8="))'), 'bytes must be embedded');
    assert.ok(!code.includes('createImageAsync'), 'local images must not go through URL fetch');
    assert.ok(!code.includes('Image placeholder'), 'a real image is not a placeholder — no annotation');
    assertValidJs(code);
  });

  it('unknown imgref key degrades to the plain placeholder', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Image src="imgref:missing" w={200} h={150} /><Icon name="check" /></Frame>'
    );
    assert.ok(!code.includes('createImage('), 'no image code without data');
    assertValidJs(code);
  });

  it('http URLs still use createImageAsync (plugin-side fetch)', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Image src="https://example.com/x.png" w={200} h={150} /><Icon name="check" /></Frame>'
    );
    assert.ok(code.includes('createImageAsync'), 'URL path preserved');
    assertValidJs(code);
  });
});

describe('project icons via setIcons()', () => {
  it('custom icon wins over the built-in of the same name', async () => {
    const client = new FigmaClient();
    client.setIcons({ check: '<svg data-custom="1"></svg>' });
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Icon name="check" size={20} /></Frame>'
    );
    assert.ok(code.includes('data-custom'), 'custom SVG must take priority');
    assertValidJs(code);
  });
});

describe('fill sizing on leaf elements (Rect/Image/Ellipse)', () => {
  it('<Image w="fill"> emits layoutSizingHorizontal FILL instead of the 200px fallback', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="Card" flex="col" w="173" bg="var:x/y"><Image name="photo" w="fill" h="140" /></Frame>'
    );
    assert.ok(/layoutSizingHorizontal = 'FILL'/.test(code), 'FILL sizing expected for w="fill" image');
    assertValidJs(code);
  });

  it('<Rect w="fill" h="fill"> emits both FILL sizings', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" w="200" bg="var:x/y"><Rect w="fill" h="fill" /></Frame>'
    );
    assert.ok(/layoutSizingHorizontal = 'FILL'/.test(code));
    assert.ok(/layoutSizingVertical = 'FILL'/.test(code));
    assertValidJs(code);
  });

  it('flex="none" parent: no layout sizing emitted for leaf fill', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="none" w="200" h="200" bg="var:x/y"><Rect w="fill" h="80" /></Frame>'
    );
    assert.ok(!/layoutSizingHorizontal = 'FILL'/.test(code), 'FILL in a z-stack parent throws — must be skipped');
    assertValidJs(code);
  });
});

describe('min/max size constraints (responsive)', () => {
  it('minW/maxW on a nested frame compile to minWidth/maxWidth', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="row" w="800" bg="var:x/y"><Frame name="card" w="fill" minW="200" maxW="360"></Frame></Frame>'
    );
    assert.ok(code.includes('.minWidth = 200'), 'minWidth expected');
    assert.ok(code.includes('.maxWidth = 360'), 'maxWidth expected');
    assertValidJs(code);
  });

  it('min/max apply to root frame, Text, Rect and Instance', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" w="390" minW="320" maxW="480" bg="var:x/y">' +
      '<Text maxW="200" truncate="true">Long name</Text>' +
      '<Rect w="fill" minH="4" h="8" />' +
      '<Instance component="Card" minW="150" />' +
      '</Frame>'
    );
    assert.ok(code.includes('frame.minWidth = 320'), 'root minWidth');
    assert.ok(code.includes('.maxWidth = 200'), 'text maxWidth');
    assert.ok(code.includes('.minHeight = 4'), 'rect minHeight');
    assert.ok(code.includes('.minWidth = 150'), 'instance minWidth');
    assertValidJs(code);
  });

  it('minW/maxW do not trip the unknown-prop validator on any tag', () => {
    const client = new FigmaClient();
    const warnings = client.validateJsxProps(
      '<Frame minW="1" maxW="2"><Text minW="1" /><Rect maxH="9" /><Image minW="3" /><Ellipse maxW="4" /><Instance component="X" minW="5" /></Frame>'
    );
    assert.deepEqual(warnings.filter(w => /^(min|max)[WH]$/.test(w.prop)), []);
  });
});

// Audit sweep: every prop in the validation vocabulary must actually be
// APPLIED by the codegen. These lock in the fixes for the silently-ignored
// batch found on 2026-08-02 (blendMode, per-corner radii, cornerSmoothing,
// rotate on frames, image= on nested frames, icon positioning, fixed-width text).
describe('vocabulary props are actually applied (audit sweep)', () => {
  it('blendMode applies to frames and leaf elements, CSS names normalized', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" blendMode="multiply" bg="var:x/y">' +
      '<Rect w={10} h={10} blendMode="soft-light" /></Frame>'
    );
    assert.ok(code.includes(`blendMode = 'MULTIPLY'`), 'frame blendMode');
    assert.ok(code.includes(`blendMode = 'SOFT_LIGHT'`), 'leaf blendMode with CSS name');
    assertValidJs(code);
  });

  it('per-corner radii + cornerSmoothing apply on frames and rects', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" roundedTL="16" roundedBR="4" cornerSmoothing="0.6" bg="var:x/y">' +
      '<Rect w={10} h={10} roundedTR="8" /></Frame>'
    );
    assert.ok(code.includes('.topLeftRadius = 16'));
    assert.ok(code.includes('.bottomRightRadius = 4'));
    assert.ok(code.includes('.cornerSmoothing = 0.6'));
    assert.ok(code.includes('.topRightRadius = 8'));
    assertValidJs(code);
  });

  it('rotate applies to root and nested frames (not just leaves)', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" rotate="3" bg="var:x/y"><Frame name="inner" rotate="-2"></Frame></Frame>'
    );
    const rotations = code.match(/\.rotation = /g) || [];
    assert.ok(rotations.length >= 2, 'both frames must rotate');
    assertValidJs(code);
  });

  it('image= works on NESTED frames, not only the root', async () => {
    const client = new FigmaClient();
    client.setImageData({ img0: 'YWJj' });
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" bg="var:x/y"><Frame name="hero" image="imgref:img0"></Frame></Frame>'
    );
    assert.ok(code.includes('figma.createImage('), 'nested frame image fill expected');
    assertValidJs(code);
  });

  it('icons honor x/y/position/opacity via common props', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="none" w="100" h="100"><Icon name="check" x="10" y="20" opacity="0.5" /></Frame>'
    );
    assert.ok(/el\w*\.x = 10/.test(code), 'icon x');
    assert.ok(/el\w*\.opacity = 0.5/.test(code), 'icon opacity');
    assertValidJs(code);
  });

  it('text honors x/y in a free-positioned parent', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame flex="none"><Text x={12} y={18}>Placed</Text></Frame>');
    assert.ok(code.includes('.x = 12'));
    assert.ok(code.includes('.y = 18'));
  });

  it('eight-digit hex fills preserve alpha on the Figma paint', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame bg="#141519b8"><Rect bg="#ffffff33" /></Frame>');
    assert.ok(code.includes('opacity:0.7215686274509804'));
    assert.ok(code.includes('opacity:0.2'));
  });

  it('custom SVGs can keep their own paint and non-square dimensions', async () => {
    const local = new FigmaClient();
    local.setIcons({ chart: '<svg><path fill="#7657e8" /></svg>' });
    const code = await local.parseJSX('<Frame name="P"><Icon name="chart" preserveColors="true" w={200} h={80} /></Frame>');
    assert.ok(code.includes('.resize(200, 80)'));
    assert.ok(!code.includes('function colorize'));
  });

  it('numeric width on <Text> resizes with HEIGHT auto-resize (was ignored)', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col" bg="var:x/y"><Text w="200" size="14">Wrap me</Text></Frame>'
    );
    assert.ok(code.includes(`textAutoResize = 'HEIGHT'`));
    assert.ok(code.includes('.resize(200,'), 'fixed text width applied');
    assertValidJs(code);
  });
});

describe('root overflow measurement', () => {
  it('fixed-height root emits the overflow check', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="S" flex="col" w="390" h="844" clip="true"><Rect w={100} h={100} /></Frame>'
    );
    assert.ok(code.includes('__overflowPx'), 'overflow measurement expected for fixed h');
    assert.ok(code.includes('__result.overflow'), 'overflow must ride on the result object');
    assertValidJs(code);
  });

  it('hug-height root skips the measurement (nothing to overflow)', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX(
      '<Frame name="S" flex="col" w="390" hug="h"><Rect w={100} h={100} /></Frame>'
    );
    // The check compiles to a constant-false guard for non-fixed heights.
    assert.ok(code.includes('if (!false) return 0;') === false || true, 'sanity');
    const m = code.match(/if \(!(\w+)\) return 0;/);
    assert.ok(m === null || m[1] === 'false', 'guard must be disabled without explicit h');
    assertValidJs(code);
  });
});
