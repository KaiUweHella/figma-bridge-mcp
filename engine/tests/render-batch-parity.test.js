import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}

// render-batch must support the same child types and layout props as single
// render. Children that batch used to silently drop (icons, rects, images,
// instances) must produce creation code.
describe('parseJSXBatch child-type parity with single render', () => {
  const client = new FigmaClient();

  it('renders Rect children (not silently dropped)', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Rect w={10} h={10} bg="#ff0000" /></Frame>']);
    assert.ok(code.includes('createRectangle'), 'Rect child must create a rectangle');
    assertValidJs(code);
  });

  it('renders Image children (not silently dropped)', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Image w={100} h={50} /></Frame>']);
    assert.ok(code.includes('createRectangle'), 'Image child must create a placeholder rectangle');
  });

  it('renders Icon children (SVG or placeholder, never dropped)', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Icon name="not-a-real-prefix" size={16} color="#000000" /></Frame>']);
    assert.ok(
      code.includes('createNodeFromSvg') || code.includes('createRectangle'),
      'Icon child must create an SVG node or placeholder'
    );
  });

  it('renders Instance children', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Instance name="Button" /></Frame>']);
    assert.ok(code.includes('createInstance'), 'Instance child must instantiate the component');
  });

  it('supports grow on nested frames', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A" flex="row"><Frame grow={1} bg="#fff"></Frame></Frame>']);
    assert.ok(/layoutSizingHorizontal = .FILL./.test(code), 'grow in row parent must map to FILL');
  });

  it('supports absolute positioning with edge attrs on nested frames', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Frame position="absolute" x={12} y={12} bg="#fff"></Frame></Frame>']);
    assert.ok(code.includes("layoutPositioning = 'ABSOLUTE'"), 'position="absolute" must set layoutPositioning');
  });

  it('supports wrap on nested row frames', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Frame flex="row" wrap={true} bg="#fff"></Frame></Frame>']);
    assert.ok(/layoutWrap = .WRAP./.test(code), 'wrap on nested row frame must set layoutWrap');
  });

  it('supports strokeWidth on nested frames', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Frame stroke="#000000" strokeWidth={3} bg="#fff"></Frame></Frame>']);
    assert.ok(code.includes('strokeWeight = 3'), 'nested strokeWidth must be honored');
  });

  it('binds var: refs in batch (regression: var support stays)', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A" bg="var:primary"><Text color="var:on-primary">x</Text></Frame>']);
    assert.ok(code.includes('boundFill'));
    assert.ok(code.includes('lookupVar'));
    assert.ok(code.includes('__varsCache'));
  });

  it('detects var usage in icon colors (was missed by batch collector)', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Icon name="x" size={16} color="var:primary" /></Frame>']);
    assert.ok(code.includes('__varsCache'), 'icon var: color must trigger variable loading');
  });

  it('positions multiple frames side by side (batch layout preserved)', async () => {
    const code = await client.parseJSXBatch([
      '<Frame name="A" bg="#fff"><Text>a</Text></Frame>',
      '<Frame name="B" bg="#000"><Text>b</Text></Frame>',
    ], { gap: 40 });
    assert.ok(code.includes('posX'));
    assert.ok(code.includes('results.push'));
    assert.ok((code.match(/figma\.createFrame\(\)/g) || []).length >= 2);
    assertValidJs(code);
  });

  it('generated batch code declares __currentNode used by shared child code', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Text>x</Text></Frame>']);
    assert.ok(code.includes('__currentNode'), 'batch wrapper must declare __currentNode');
    assertValidJs(code);
  });
});

// The single-render path must keep working exactly as before the refactor.
describe('single render path unchanged (characterization)', () => {
  const client = new FigmaClient();

  it('generates root frame with smart positioning and children', async () => {
    const code = await client.parseJSX('<Frame name="Card" bg="#ffffff" flex="col" gap={8} p={16} w={320}><Text size={16} weight="bold" color="#000000" w="fill">Title</Text><Frame bg="#3b82f6" px={16} py={10} rounded={10} flex="row" justify="center" items="center"><Text color="#ffffff">Button</Text></Frame></Frame>');
    assert.ok(code.includes('figma.createFrame()'));
    assert.ok(code.includes('smartX'));
    assert.ok(code.includes('figma.createText()'));
    assert.ok(code.includes("textAutoResize = 'HEIGHT'") || code.includes("layoutSizingHorizontal = 'FILL'"));
    assert.ok(code.includes('__currentNode'));
    assert.ok(code.includes('frame.remove()'));
    assertValidJs(code);
  });

  it('still supports slots, rects and instances', async () => {
    const code = await client.parseJSX('<Frame name="C"><Slot name="Content" flex="col" gap={8} /><Rect w={10} h={10} /><Instance name="Btn" /></Frame>');
    assert.ok(code.includes('createSlot'));
    assert.ok(code.includes('createRectangle'));
    assert.ok(code.includes('createInstance'));
    assertValidJs(code);
  });
});
