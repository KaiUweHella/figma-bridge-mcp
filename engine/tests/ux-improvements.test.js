import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';
import { getVariety } from '../src/shadcn.js';

const client = new FigmaClient();

// ----------------------------------------------------------------
// justify="between" must map to SPACE_BETWEEN on the primary axis
// (root frames, nested frames, batch root frames)
// ----------------------------------------------------------------
describe('justify="between"', () => {
  it('works on the root frame (single render)', async () => {
    const code = await client.parseJSX('<Frame name="Nav" flex="row" justify="between" w={400}><Text>L</Text><Text>R</Text></Frame>');
    assert.ok(code.includes("frame.primaryAxisAlignItems = 'SPACE_BETWEEN'"), 'root justify="between" must map to SPACE_BETWEEN');
  });

  it('works on nested frames', async () => {
    const code = await client.parseJSX('<Frame name="Card"><Frame flex="row" justify="between" w="fill"><Text>L</Text><Text>R</Text></Frame></Frame>');
    assert.ok(/el\w*\.primaryAxisAlignItems = 'SPACE_BETWEEN'/.test(code), 'nested justify="between" must map to SPACE_BETWEEN');
  });

  it('works on batch root frames', async () => {
    const code = await client.parseJSXBatch(['<Frame name="Nav" flex="row" justify="between" w={400}><Text>L</Text><Text>R</Text></Frame>']);
    assert.ok(code.includes("primaryAxisAlignItems = 'SPACE_BETWEEN'"), 'batch root justify="between" must map to SPACE_BETWEEN');
  });

  it('does not leak between into the cross axis', async () => {
    const code = await client.parseJSX('<Frame name="X" flex="row" items="between"><Text>x</Text></Frame>');
    assert.ok(!code.includes("counterAxisAlignItems = 'SPACE_BETWEEN'"), 'items="between" is invalid and must not produce SPACE_BETWEEN on counter axis');
  });
});

// ----------------------------------------------------------------
// Single render must surface unresolved var: references like batch does
// ----------------------------------------------------------------
describe('unresolved vars in single render', () => {
  it('generated code returns unresolved list when vars are used', async () => {
    const code = await client.parseJSX('<Frame name="T" bg="var:primary"><Text color="var:nope">x</Text></Frame>');
    assert.ok(code.includes('__unresolvedVars'), 'var tracking must be present');
    assert.ok(code.includes('unresolved'), 'return value must include unresolved list');
    assert.ok(/__unresolved\.length > 0/.test(code), 'must return wrapped object when unresolved vars exist');
  });

  // Regression: shadcn components bound to var:primary etc. used to render
  // grey-on-grey (invisible text) when no matching variable existed, because
  // boundFill fell back to opaque grey for BOTH fill and text. The fallback now
  // resolves to the semantic token's real default color so components stay
  // visible WITHOUT requiring any variables to be loaded.
  it('unresolved semantic vars fall back to their real default color, not grey', async () => {
    const single = await client.parseJSX('<Frame name="B" bg="var:primary"><Text color="var:primary-foreground">x</Text></Frame>');
    const batch = await client.parseJSXBatch(['<Frame name="B" bg="var:primary"><Text color="var:primary-foreground">x</Text></Frame>']);
    for (const [label, code] of [['single', single], ['batch', batch]]) {
      assert.ok(code.includes('__varDefaults'), `${label}: default-color map must be embedded`);
      assert.ok(code.includes('__defaultColor'), `${label}: default-color resolver must be present`);
      // primary default is dark zinc, primary-foreground is near-white — both
      // must be in the embedded map so bg + text don't collapse to grey.
      assert.ok(code.includes('"primary"') && code.includes('0.094'), `${label}: primary default (dark) must be present`);
      assert.ok(code.includes('"primary-foreground"') && code.includes('0.98'), `${label}: primary-foreground default (near-white) must be present`);
    }
  });
});

// ----------------------------------------------------------------
// Variety pools: `shadcn add card --count N` gives N DIFFERENT cards
// ----------------------------------------------------------------
describe('component variety pools', () => {
  it('card --count N yields N DISTINCT designs (not clones)', () => {
    const four = getVariety('card', 4);
    assert.strictEqual(four.length, 4, 'must return exactly N items');
    assert.strictEqual(new Set(four.map(c => c.jsx)).size, 4, 'all 4 must be different layouts');
    assert.strictEqual(new Set(four.map(c => c.name)).size, 4, 'each gets a distinct, descriptive name');
    four.forEach(c => {
      assert.ok(c.name.startsWith('Card '), `name "${c.name}" must be a descriptive Card name, not bare "Card"`);
      assert.ok(c.jsx.includes(`name="${c.name}"`), 'JSX root frame name must match the descriptive name');
    });
  });

  it('cycles through the pool when N exceeds its size', () => {
    const eight = getVariety('card', 8);
    assert.strictEqual(eight.length, 8, 'still returns N items');
    assert.ok(new Set(eight.map(c => c.jsx)).size >= 6, 'covers the whole pool before repeating');
  });

  it('button --count N yields N DISTINCT styles with descriptive names', () => {
    const four = getVariety('button', 4);
    assert.strictEqual(four.length, 4, 'must return exactly N items');
    assert.strictEqual(new Set(four.map(b => b.jsx)).size, 4, 'all 4 must be different styles');
    assert.strictEqual(new Set(four.map(b => b.name)).size, 4, 'each gets a distinct, descriptive name');
    four.forEach(b => {
      assert.ok(b.name.startsWith('Button ') && b.name !== 'Button', `name "${b.name}" must distinguish the style, not bare "Button"`);
      assert.ok(b.jsx.includes(`name="${b.name}"`), 'JSX root frame name must match the descriptive name');
    });
  });

  it('returns null for components without a variety pool', () => {
    assert.strictEqual(getVariety('badge', 3), null, 'components without a pool clone the default');
  });
});

// ----------------------------------------------------------------
// Unknown prop validation with suggestions
// ----------------------------------------------------------------
describe('validateJsxProps', () => {
  it('flags CSS-style prop names with the right suggestion', () => {
    const warnings = client.validateJsxProps('<Frame cornerRadius={12} backgroundColor="#fff"><Text fontSize={18} fontWeight="bold">x</Text></Frame>');
    const byProp = Object.fromEntries(warnings.map(w => [w.prop, w]));
    assert.strictEqual(byProp.cornerRadius.suggestion, 'rounded');
    assert.strictEqual(byProp.backgroundColor.suggestion, 'bg');
    assert.strictEqual(byProp.fontSize.suggestion, 'size');
    assert.strictEqual(byProp.fontWeight.suggestion, 'weight');
  });

  it('accepts padding and fill as working aliases (no warning)', () => {
    const warnings = client.validateJsxProps('<Frame padding={24} fill="#fff"><Text>x</Text></Frame>');
    assert.deepStrictEqual(warnings, []);
  });

  it('flags layout= with flex suggestion', () => {
    const warnings = client.validateJsxProps('<Frame layout="horizontal"><Text>x</Text></Frame>');
    assert.strictEqual(warnings[0].prop, 'layout');
    assert.strictEqual(warnings[0].suggestion, 'flex');
  });

  it('suggests near-miss names (typos)', () => {
    const warnings = client.validateJsxProps('<Frame roundedd={8}><Text>x</Text></Frame>');
    assert.strictEqual(warnings[0].suggestion, 'rounded');
  });

  it('accepts all documented props without warnings', () => {
    const jsx = `<Frame name="A" flex="row" gap={16} p={24} px={16} py={8} pt={8} pr={16} pb={8} pl={16}
      justify="between" items="center" w={320} h={200} minW={100} maxW={500} minH={50} maxH={300}
      bg="var:card" stroke="#000" strokeWidth={2} strokeAlign="inside" opacity={0.8} blendMode="multiply"
      rounded={16} roundedTL={8} roundedTR={8} roundedBL={0} roundedBR={0} cornerSmoothing={0.6}
      shadow="lg" blur={8} overflow="hidden" rotate={45} noise="mono" texture={true} progressiveBlur={40}
      glass={true} glassDepth={50} wrap={true} rowGap={12} grow={1} stretch={true} clip={true}
      position="absolute" x={12} y={12} top={4} right={4} bottom={4} left={4} image="https://x.com/a.png">
      <Text size={18} weight="bold" color="#000" font="Inter" w="fill" align="center">T</Text>
      <Icon name="lucide:home" size={20} color="#fff" />
      <Rect w={10} h={10} bg="#f00" rounded={2} />
      <Slot name="Content" flex="col" gap={8} w="fill" />
    </Frame>`;
    const warnings = client.validateJsxProps(jsx);
    assert.deepStrictEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
  });

  it('returns empty array for valid minimal JSX', () => {
    assert.deepStrictEqual(client.validateJsxProps('<Frame bg="#fff"><Text>x</Text></Frame>'), []);
  });
});

// ----------------------------------------------------------------
// Fonts: family + full weight scale + italic + fallback
// ----------------------------------------------------------------
describe('font support in JSX', () => {
  it('passes font family through to fontName', async () => {
    const code = await client.parseJSX('<Frame name="T"><Text font="Playfair Display" size={24}>Hi</Text></Frame>');
    assert.ok(code.includes('Playfair Display'), 'custom font family must reach generated code');
  });

  it('supports the full weight scale', async () => {
    const code = await client.parseJSX('<Frame name="T"><Text weight="light">a</Text><Text weight="black">b</Text><Text weight="extrabold">c</Text></Frame>');
    assert.ok(code.includes('Light'));
    assert.ok(code.includes('Black'));
    assert.ok(code.includes('Extra Bold'));
  });

  it('supports italic', async () => {
    const code = await client.parseJSX('<Frame name="T"><Text italic={true} weight="bold">x</Text></Frame>');
    assert.ok(code.includes('Bold Italic'));
  });

  it('falls back to Inter when the font cannot load', async () => {
    const code = await client.parseJSX('<Frame name="T"><Text font="NotInstalledFont">x</Text></Frame>');
    assert.ok(code.includes('catch'), 'font loading must have a fallback path');
    assert.ok(code.includes('Inter'), 'fallback family must be Inter');
  });

  it('batch path supports custom fonts too', async () => {
    const code = await client.parseJSXBatch(['<Frame name="T"><Text font="Georgia" weight="medium">x</Text></Frame>']);
    assert.ok(code.includes('Georgia'));
  });
});
