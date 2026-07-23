import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

// rowGap was a documented, known prop but never read — only wrapGap/
// counterAxisSpacing were. So wrapped rows had 0 vertical spacing.
describe('rowGap maps to counterAxisSpacing on wrap rows', () => {
  const client = new FigmaClient();

  it('nested wrap row honours rowGap', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="W" flex="row" wrap={true} rowGap={12} w={300}><Frame w={140} h={20} bg="#000"/><Frame w={140} h={20} bg="#000"/><Frame w={140} h={20} bg="#000"/></Frame></Frame>');
    assert.ok(/counterAxisSpacing = 12/.test(code), 'rowGap=12 -> counterAxisSpacing 12');
  });

  it('root wrap row honours rowGap', async () => {
    const code = await client.parseJSX('<Frame name="W" flex="row" wrap={true} rowGap={16} w={300}><Frame w={140} h={20} bg="#000"/><Frame w={140} h={20} bg="#000"/></Frame>');
    assert.ok(/counterAxisSpacing = 16/.test(code));
  });

  it('wrapGap still works (alias)', async () => {
    const code = await client.parseJSX('<Frame name="P"><Frame name="W" flex="row" wrap={true} wrapGap={8} w={300}><Frame w={140} h={20} bg="#000"/><Frame w={140} h={20} bg="#000"/></Frame></Frame>');
    assert.ok(/counterAxisSpacing = 8/.test(code));
  });
});
