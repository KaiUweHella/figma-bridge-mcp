import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}
function blockFor(code, name) {
  const lines = code.split('\n');
  const i = lines.findIndex(l => l.includes(`"${name}"`));
  assert.ok(i >= 0, `no block for "${name}"`);
  return lines.slice(i, i + 40).join('\n');
}

// Regression: w="60%" used to leak the raw "60%" string into resize() and
// produce broken JS (SyntaxError). Percentages now resolve to a FIXED px size
// computed from the parent's dimension at append time.
describe('percentage width/height', () => {
  const client = new FigmaClient();

  it('does not leak "60%" into resize() (no broken JS)', async () => {
    const code = await client.parseJSX('<Frame name="P" w={300} flex="row"><Frame name="Fill" w="60%" h="fill" bg="#0a0"/></Frame>');
    assert.ok(!/resize\([^)]*60%/.test(code), 'percentage must not reach resize() as a raw string');
    assertValidJs(code);
  });

  it('emits a runtime resolver against the parent width', async () => {
    const code = await client.parseJSX('<Frame name="P" w={300} flex="row"><Frame name="Fill" w="60%" bg="#0a0"/></Frame>');
    const block = blockFor(code, 'Fill');
    assert.ok(/_pp\.width \* 0\.6/.test(block), 'should resize to 60% of parent width');
    assert.ok(/layoutSizingHorizontal = 'FIXED'/.test(block), 'percentage axis is FIXED');
  });

  it('supports percentage height too', async () => {
    const code = await client.parseJSX('<Frame name="P" h={200} flex="col"><Frame name="Half" h="50%" bg="#0a0"/></Frame>');
    const block = blockFor(code, 'Half');
    assert.ok(/_pp\.height \* 0\.5/.test(block), 'should resize to 50% of parent height');
    assertValidJs(code);
  });

  it('parity through parseJSXBatch', async () => {
    const code = await client.parseJSXBatch(['<Frame name="P" w={300} flex="row"><Frame name="Fill" w="75%" bg="#0a0"/></Frame>']);
    assert.ok(!/resize\([^)]*75%/.test(code), 'batch path must not leak % into resize');
    assert.ok(/_pp\.width \* 0\.75/.test(code), 'batch path resolves percentage');
    assertValidJs(code);
  });
});
