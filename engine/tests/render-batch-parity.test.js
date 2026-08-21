import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/lib/jsx-render.js';

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

  // A published-library component lives in ANOTHER file: only its key reaches
  // it. This is the handle `spec` prints as the reuse hint, so the renderer
  // must accept it — name/id lookups would both come up empty.
  it('resolves an Instance by published-library key', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Instance key="PLACEHOLDERCOMPONENTKEY" /></Frame>']);
    assert.ok(code.includes('importComponentByKeyAsync'), 'key must go through the library import');
    assert.ok(code.includes('"PLACEHOLDERCOMPONENTKEY"'), 'the key itself must reach the eval');
    assert.ok(code.includes('createInstance'));
    assertValidJs(code);
  });

  // key + id together is what `spec` emits. The key only resolves once the
  // component is published; for an unpublished local one the import fails and
  // the id has to catch it. Verified live: a local test component set has a
  // key, and importComponentByKeyAsync returns nothing for it.
  it('key and id together fall through key → id', async () => {
    const code = await client.parseJSXBatch(['<Frame name="A"><Instance key="PLACEHOLDERCOMPONENTKEY" id="4:296" /></Frame>']);
    assert.ok(/__resolveComponent\("4:296", null, null, "PLACEHOLDERCOMPONENTKEY"\)/.test(code),
      'both handles reach the resolver, id in the id slot');
    assert.ok(code.includes('if (!node && id)'), 'id is tried only after the key import failed');
    assertValidJs(code);
  });

  it('keeps an explicit instance layer name when the component resolves by id', async () => {
    const code = await client.parseJSXBatch([
      '<Frame name="A"><Instance id="4:31" name="Leading icon" /></Frame>',
    ]);
    assert.match(code, /\.name = "Leading icon"/);
    assertValidJs(code);
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

// The two render paths used to carry their own copy of the ~65-line variable
// preamble — the exact drift this file exists to catch. They now emit one
// shared snippet (FigmaClient#varPreambleCode).
describe('variable preamble is emitted from one source', () => {
  const c = new FigmaClient();

  it('single and batch paths emit a byte-identical preamble', async () => {
    const jsx = '<Frame name="P" bg="var:color/bg"><Text color="var:color/fg">Hi</Text></Frame>';
    const single = await c.parseJSX(jsx);
    const batch = await c.parseJSXBatch([jsx], {});
    const grab = (code) => {
      const i = code.indexOf('globalThis.__varsCache');
      const j = code.indexOf('globalThis.__varsCacheTime = Date.now()');
      return code.slice(i, j).replace(/\s+/g, ' ').trim();
    };
    assert.ok(grab(single).length > 200, 'single path emits a var preamble');
    assert.strictEqual(grab(single), grab(batch));
  });

  it('the collection filter reaches both paths', async () => {
    const jsx = '<Frame name="P" bg="var:color/bg" />';
    c.setCollection('Brand');
    const single = await c.parseJSX(jsx);
    const batch = await c.parseJSXBatch([jsx], {});
    c.setCollection(null);
    assert.ok(single.includes('"Brand"'), 'single path scopes to the collection');
    assert.ok(batch.includes('"Brand"'), 'batch path scopes to the collection');
  });
});
