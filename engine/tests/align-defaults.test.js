import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

// Recurring papercut: nested frames defaulted to centered content, so cells
// staggered and titles centered. Default is now top-left, except a row's cross
// axis stays centered (vertical centering of icon+text is what you want).
describe('nested frame alignment defaults', () => {
  const client = new FigmaClient();

  it('a row cell with no justify left-aligns its content (no stagger)', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="Cell" flex="row" items="center"><Text>x</Text></Frame></Frame>');
    const block = code.slice(code.indexOf('"Cell"'));
    assert.ok(/primaryAxisAlignItems = 'MIN'/.test(block), 'justify defaults to MIN (left)');
    assert.ok(/counterAxisAlignItems = 'CENTER'/.test(block), 'explicit items=center kept (vertical centering)');
  });

  it('a row with no items still vertically centers (cross axis = CENTER)', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="Row" flex="row"><Text>x</Text></Frame></Frame>');
    const block = code.slice(code.indexOf('"Row"'));
    assert.ok(/counterAxisAlignItems = 'CENTER'/.test(block), 'row cross axis defaults CENTER');
  });

  it('a col with no align left-aligns its children (titles, not centered)', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="Titles" flex="col"><Text>Title</Text></Frame></Frame>');
    const block = code.slice(code.indexOf('"Titles"'));
    assert.ok(/counterAxisAlignItems = 'MIN'/.test(block), 'col cross axis defaults MIN (left)');
    assert.ok(/primaryAxisAlignItems = 'MIN'/.test(block), 'col main axis defaults MIN (top)');
  });

  it('explicit justify/items still win', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="C" flex="row" justify="center" items="end"><Text>x</Text></Frame></Frame>');
    const block = code.slice(code.indexOf('"C"'));
    assert.ok(/primaryAxisAlignItems = 'CENTER'/.test(block));
    assert.ok(/counterAxisAlignItems = 'MAX'/.test(block));
  });
});
