import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}

// Helper: pull the generated block for a named child frame.
function blockFor(code, name) {
  const lines = code.split('\n');
  const i = lines.findIndex(l => l.includes(`"${name}"`));
  assert.ok(i >= 0, `no generated block for "${name}"`);
  return lines.slice(i, i + 30).join('\n');
}

// Regression: a thin divider used to render at the 100px frame default and
// inflate its parent's cross-axis ("looks zu hoch"). Two fixes guard this:
//   1. `stretch={true}` now fills the parent's cross axis (was a silent no-op).
//   2. a thin (w<=2 / h<=2) child with an unset cross axis auto-fills it.
// In both cases the fill axis is seeded at 1px (not 100) so the parent hugs to
// real content before FILL is applied.
describe('divider / stretch cross-axis fill', () => {
  const client = new FigmaClient();

  it('stretch={true} fills the cross axis (vertical) of a row parent', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="row"><Frame name="D" w={1} stretch={true} bg="#999" /></Frame>');
    const block = blockFor(code, 'D');
    assert.ok(/layoutSizingVertical = 'FILL'/.test(block), 'stretch must set vertical FILL in a row');
    assert.ok(/resize\(1, 1\)/.test(block), 'fill axis seeded at 1px, not 100');
    assertValidJs(code);
  });

  it('stretch={true} fills the cross axis (horizontal) of a col parent', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Frame name="D" h={1} stretch={true} bg="#999" /></Frame>');
    const block = blockFor(code, 'D');
    assert.ok(/layoutSizingHorizontal = 'FILL'/.test(block), 'stretch must set horizontal FILL in a col');
    assertValidJs(code);
  });

  it('thin 1px-wide child without stretch auto-fills height in a row', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="row"><Frame name="Rule" w={1} bg="#999" /></Frame>');
    const block = blockFor(code, 'Rule');
    assert.ok(/layoutSizingVertical = 'FILL'/.test(block), 'thin divider must auto-fill height');
    assert.ok(/resize\(1, 1\)/.test(block), 'seeded at 1px so parent hugs real content first');
    assertValidJs(code);
  });

  it('thin 1px-tall child without stretch auto-fills width in a col', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Frame name="Rule" h={1} bg="#999" /></Frame>');
    const block = blockFor(code, 'Rule');
    assert.ok(/layoutSizingHorizontal = 'FILL'/.test(block), 'thin divider must auto-fill width');
    assertValidJs(code);
  });

  it('a normal sized child is NOT auto-filled (no false positives)', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="row"><Frame name="Box" w={40} h={24} bg="#999" /></Frame>');
    const block = blockFor(code, 'Box');
    assert.ok(/layoutSizingVertical = 'FIXED'/.test(block), 'a 40x24 box keeps FIXED height');
    assert.ok(/resize\(40, 24\)/.test(block), 'explicit dims preserved');
  });

  it('parity: same behavior through parseJSXBatch', async () => {
    const code = await client.parseJSXBatch(['<Frame name="P" flex="row"><Frame name="Rule" w={1} bg="#999" /></Frame>']);
    const block = blockFor(code, 'Rule');
    assert.ok(/layoutSizingVertical = 'FILL'/.test(block), 'batch path must auto-fill too');
    assertValidJs(code);
  });
});
