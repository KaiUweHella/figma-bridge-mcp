import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

const client = new FigmaClient();

// Helper: assert that a generated code string is syntactically valid JavaScript
function assertValidJs(code, msg) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, msg || `Generated code is not valid JS:\n${code}`);
}

// ----------------------------------------------------------------
// hexToRgb / hexToRgbCode
// ----------------------------------------------------------------
describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    assert.deepStrictEqual(client.hexToRgb('#ffffff'), { r: 1, g: 1, b: 1 });
    assert.deepStrictEqual(client.hexToRgb('#000000'), { r: 0, g: 0, b: 0 });
  });

  it('parses 3-digit shorthand hex', () => {
    assert.deepStrictEqual(client.hexToRgb('#fff'), { r: 1, g: 1, b: 1 });
    const c = client.hexToRgb('#f00');
    assert.strictEqual(c.r, 1);
    assert.strictEqual(c.g, 0);
    assert.strictEqual(c.b, 0);
  });

  it('parses real-world color', () => {
    const c = client.hexToRgb('#3b82f6');
    assert.ok(Math.abs(c.r - 59 / 255) < 1e-9);
    assert.ok(Math.abs(c.g - 130 / 255) < 1e-9);
    assert.ok(Math.abs(c.b - 246 / 255) < 1e-9);
  });

  it('returns null for non-hex input', () => {
    assert.strictEqual(client.hexToRgb('red'), null);
    assert.strictEqual(client.hexToRgb(''), null);
    assert.strictEqual(client.hexToRgb(null), null);
    assert.strictEqual(client.hexToRgb(undefined), null);
  });
});

describe('hexToRgbCode', () => {
  it('generates an object literal string', () => {
    assert.strictEqual(client.hexToRgbCode('#ffffff'), '{r:1,g:1,b:1}');
    assert.strictEqual(client.hexToRgbCode('#fff'), '{r:1,g:1,b:1}');
  });

  it('output is valid JS', () => {
    assertValidJs(`const c = ${client.hexToRgbCode('#3b82f6')};`);
  });
});

// ----------------------------------------------------------------
// isVarRef / getVarName
// ----------------------------------------------------------------
describe('var: reference parsing', () => {
  it('detects var: refs', () => {
    assert.strictEqual(client.isVarRef('var:primary'), true);
    assert.strictEqual(client.isVarRef('var:colors/blue-500'), true);
  });

  it('rejects non-refs', () => {
    assert.strictEqual(client.isVarRef('#ffffff'), false);
    assert.strictEqual(client.isVarRef(''), false);
    assert.strictEqual(client.isVarRef(null), false);
    assert.strictEqual(client.isVarRef(42), false);
  });

  it('extracts the variable name', () => {
    assert.strictEqual(client.getVarName('var:primary'), 'primary');
    assert.strictEqual(client.getVarName('var:cursor:primary'), 'cursor:primary');
  });
});

// ----------------------------------------------------------------
// parseProps
// ----------------------------------------------------------------
describe('parseProps', () => {
  it('parses string props', () => {
    const p = client.parseProps('name="Card" bg="#ffffff"');
    assert.strictEqual(p.name, 'Card');
    assert.strictEqual(p.bg, '#ffffff');
  });

  it('parses brace props', () => {
    const p = client.parseProps('w={320} gap={16} opacity={0.8}');
    assert.strictEqual(p.w, '320');
    assert.strictEqual(p.gap, '16');
    assert.strictEqual(p.opacity, '0.8');
  });

  it('parses mixed props', () => {
    const p = client.parseProps('flex="row" gap={8} bg="var:card"');
    assert.strictEqual(p.flex, 'row');
    assert.strictEqual(p.gap, '8');
    assert.strictEqual(p.bg, 'var:card');
  });

  it('handles empty input', () => {
    assert.deepStrictEqual(client.parseProps(''), {});
  });

  it('parses multi-line props', () => {
    const p = client.parseProps('name="Card"\n  bg="#fff"\n  w={200}');
    assert.strictEqual(p.name, 'Card');
    assert.strictEqual(p.bg, '#fff');
    assert.strictEqual(p.w, '200');
  });
});

// ----------------------------------------------------------------
// extractContent
// ----------------------------------------------------------------
describe('extractContent', () => {
  it('extracts simple content', () => {
    const inner = client.extractContent('<Text>Hello</Text></Frame>', 'Frame');
    assert.strictEqual(inner, '<Text>Hello</Text>');
  });

  it('handles nested same-named tags', () => {
    const str = '<Frame bg="#fff"><Text>In</Text></Frame></Frame>';
    const inner = client.extractContent(str, 'Frame');
    assert.strictEqual(inner, '<Frame bg="#fff"><Text>In</Text></Frame>');
  });

  it('skips self-closing tags without changing depth', () => {
    const str = '<Frame w={10} /><Text>x</Text></Frame>';
    const inner = client.extractContent(str, 'Frame');
    assert.strictEqual(inner, '<Frame w={10} /><Text>x</Text>');
  });

  it('returns whole string when no closing tag found', () => {
    assert.strictEqual(client.extractContent('no closing tag', 'Frame'), 'no closing tag');
  });
});

// ----------------------------------------------------------------
// parseGradient
// ----------------------------------------------------------------
describe('parseGradient', () => {
  it('parses a 2-stop linear gradient with angle', () => {
    const code = client.parseGradient('linear-gradient(180deg, #FF0000, #00FF00)');
    assert.ok(code.includes("type:'GRADIENT_LINEAR'"));
    assert.ok(code.includes('gradientStops'));
    assertValidJs(`const g = ${code};`);
  });

  it('defaults to 180deg without angle', () => {
    const withAngle = client.parseGradient('linear-gradient(180deg, #000, #fff)');
    const without = client.parseGradient('linear-gradient(#000, #fff)');
    assert.strictEqual(without, withAngle);
  });

  it('parses explicit stop positions', () => {
    const code = client.parseGradient('linear-gradient(90deg, #FF0000 10%, #00FF00 90%)');
    assert.ok(code.includes('position:0.1'));
    assert.ok(code.includes('position:0.9'));
  });

  it('parses rgba() stops', () => {
    const code = client.parseGradient('linear-gradient(0deg, rgba(255,0,0,0.5), rgba(0,0,255,1))');
    assert.ok(code.includes('a:0.5'));
    assertValidJs(`const g = ${code};`);
  });

  it('parses 8-digit hex alpha', () => {
    const code = client.parseGradient('linear-gradient(#00000040, #ffffffff)');
    assert.ok(code.includes('a:0.25'));
  });

  it('maps radial/angular/diamond types', () => {
    assert.ok(client.parseGradient('radial-gradient(#000, #fff)').includes('GRADIENT_RADIAL'));
    assert.ok(client.parseGradient('angular-gradient(#000, #fff)').includes('GRADIENT_ANGULAR'));
    assert.ok(client.parseGradient('diamond-gradient(#000, #fff)').includes('GRADIENT_DIAMOND'));
  });

  it('returns null for invalid input', () => {
    assert.strictEqual(client.parseGradient('not-a-gradient'), null);
    assert.strictEqual(client.parseGradient('linear-gradient(#000)'), null);
    assert.strictEqual(client.parseGradient('linear-gradient()'), null);
  });
});

// ----------------------------------------------------------------
// parseShadowString
// ----------------------------------------------------------------
describe('parseShadowString', () => {
  it('parses px values with rgba color', () => {
    const e = client.parseShadowString('0 4px 12px rgba(0,0,0,0.1)');
    assert.strictEqual(e.x, 0);
    assert.strictEqual(e.y, 4);
    assert.strictEqual(e.blur, 12);
    assert.strictEqual(e.color.a, 0.1);
  });

  it('parses 8-digit hex alpha', () => {
    const e = client.parseShadowString('0 2px 4px #00000040');
    assert.ok(Math.abs(e.color.a - 0.25) < 0.01);
  });

  it('supports tailwind keywords', () => {
    const e = client.parseShadowString('lg');
    assert.strictEqual(e.y, 10);
    assert.strictEqual(e.blur, 15);
  });

  it('supports descriptive aliases', () => {
    assert.ok(client.parseShadowString('soft'));
    assert.ok(client.parseShadowString('glow'));
  });

  it('returns null for none and invalid input', () => {
    assert.strictEqual(client.parseShadowString('none'), null);
    assert.strictEqual(client.parseShadowString(42), null);
    assert.strictEqual(client.parseShadowString('x'), null);
  });

  it('defaults color when missing', () => {
    const e = client.parseShadowString('0 4px 12px');
    assert.deepStrictEqual(e.color, { r: 0, g: 0, b: 0, a: 0.1 });
  });
});

// ----------------------------------------------------------------
// generateFillCode
// ----------------------------------------------------------------
describe('generateFillCode', () => {
  it('null value clears fills', () => {
    const { code, usesVars } = client.generateFillCode(null, 'frame');
    assert.strictEqual(code, 'frame.fills = [];');
    assert.strictEqual(usesVars, false);
  });

  it('hex value generates SOLID paint', () => {
    const { code, usesVars } = client.generateFillCode('#3b82f6', 'frame');
    assert.ok(code.includes("type:'SOLID'"));
    assert.strictEqual(usesVars, false);
    assertValidJs(`const frame = {}; ${code}`);
  });

  it('var: ref generates bound fill', () => {
    const { code, usesVars } = client.generateFillCode('var:primary', 'frame');
    assert.ok(code.includes('boundFill'));
    assert.ok(code.includes('lookupVar'));
    assert.strictEqual(usesVars, true);
  });

  it('gradient value generates gradient paint', () => {
    const { code } = client.generateFillCode('linear-gradient(180deg, #000, #fff)', 'frame');
    assert.ok(code.includes('GRADIENT_LINEAR'));
    assertValidJs(`const frame = {}; ${code}`);
  });
});

// ----------------------------------------------------------------
// generateEffectsCode
// ----------------------------------------------------------------
describe('generateEffectsCode', () => {
  it('returns empty string when no effect props', () => {
    assert.strictEqual(client.generateEffectsCode({}, 'el'), '');
  });

  it('generates drop shadow', () => {
    const code = client.generateEffectsCode({ shadow: '0 4px 12px rgba(0,0,0,0.25)' }, 'el');
    assert.ok(code.includes('DROP_SHADOW'));
    assertValidJs(`const el = {}; ${code}`);
  });

  it('generates layer and background blur', () => {
    const code = client.generateEffectsCode({ blur: '4', bgBlur: '8' }, 'el');
    assert.ok(code.includes('LAYER_BLUR'));
    assert.ok(code.includes('BACKGROUND_BLUR'));
    assertValidJs(`const el = {}; ${code}`);
  });

  it('ignores zero/invalid blur', () => {
    assert.strictEqual(client.generateEffectsCode({ blur: '0' }, 'el'), '');
    assert.strictEqual(client.generateEffectsCode({ blur: 'abc' }, 'el'), '');
  });

  it('generates NOISE effect with defaults', () => {
    const code = client.generateEffectsCode({ noise: 'mono' }, 'el');
    assert.ok(code.includes('"type":"NOISE"'));
    assert.ok(code.includes('"noiseType":"MONOTONE"'));
    assert.ok(code.includes('"density":0.4'));
    assertValidJs(`const el = {}; ${code}`);
  });

  it('generates DUOTONE noise with secondary color', () => {
    const code = client.generateEffectsCode({ noise: 'duo', noiseColor2: '#ff0000' }, 'el');
    assert.ok(code.includes('"noiseType":"DUOTONE"'));
    assert.ok(code.includes('secondaryColor'));
  });

  it('generates TEXTURE effect', () => {
    const code = client.generateEffectsCode({ texture: 'true' }, 'el');
    assert.ok(code.includes('"type":"TEXTURE"'));
    assert.ok(code.includes('"clipToShape":true'));
  });

  it('generates progressive blur with direction', () => {
    const code = client.generateEffectsCode({ progressiveBlur: '40', progressiveBlurDir: 'up' }, 'el');
    assert.ok(code.includes('"blurType":"PROGRESSIVE"'));
    assert.ok(code.includes('"startOffset":{"x":0.5,"y":1}'));
  });

  it('generates GLASS effect with tuned defaults', () => {
    const code = client.generateEffectsCode({ glass: 'true' }, 'el');
    assert.ok(code.includes('"type":"GLASS"'));
    assert.ok(code.includes('"refraction":0.95'));
    assert.ok(code.includes('"depth":50'));
    assertValidJs(`const el = {}; ${code}`);
  });

  it('treats noise="false" / glass={false} as off', () => {
    assert.strictEqual(client.generateEffectsCode({ noise: 'false' }, 'el'), '');
    assert.strictEqual(client.generateEffectsCode({ glass: 'false' }, 'el'), '');
  });

  it('accumulates multiple effects', () => {
    const code = client.generateEffectsCode({ shadow: 'lg', noise: 'mono', glass: 'true' }, 'el');
    assert.ok(code.includes('DROP_SHADOW'));
    assert.ok(code.includes('NOISE'));
    assert.ok(code.includes('GLASS'));
    assertValidJs(`const el = {}; ${code}`);
  });
});

// ----------------------------------------------------------------
// generateStrokeCode
// ----------------------------------------------------------------
describe('generateStrokeCode', () => {
  it('hex stroke generates SOLID paint with weight', () => {
    const { code } = client.generateStrokeCode('#000000', 'el', 2);
    assert.ok(code.includes('strokeWeight = 2'));
    assertValidJs(`const el = {}; ${code}`);
  });

  it('var: stroke generates bound fill', () => {
    const { code, usesVars } = client.generateStrokeCode('var:border', 'el', 1);
    assert.ok(code.includes('boundFill'));
    assert.strictEqual(usesVars, true);
  });

  it('strokeAlign is uppercased', () => {
    const { code } = client.generateStrokeCode('#000', 'el', 1, 'inside');
    assert.ok(/strokeAlign = ["']INSIDE["']/.test(code));
  });
});

// ----------------------------------------------------------------
// hexToRgb robustness (invalid hex must not produce NaN)
// ----------------------------------------------------------------
describe('hexToRgb invalid input', () => {
  it('returns null for non-hex digits instead of NaN', () => {
    assert.strictEqual(client.hexToRgb('#gggggg'), null);
    assert.strictEqual(client.hexToRgb('#zzz'), null);
  });

  it('returns null for wrong-length hex', () => {
    assert.strictEqual(client.hexToRgb('#ff'), null);
    assert.strictEqual(client.hexToRgb('#fffff'), null);
  });
});
