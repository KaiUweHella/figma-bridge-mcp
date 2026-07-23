import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

const client = new FigmaClient();

// Ellipse / Rect / Image used to be "second-class" children: they ignored the
// generic node props (opacity, blur/effects, x/y position) that Frames honored.
describe('generic node props on non-frame children', () => {
  it('Ellipse honors opacity', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Ellipse name="B" w={20} h={20} bg="#6366f1" opacity={0.28}/></Frame>');
    assert.ok(/\.opacity = 0\.28/.test(code), code);
    assertValidJs(code);
  });

  it('Ellipse honors blur (LAYER_BLUR effect)', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Ellipse name="B" w={20} h={20} bg="#6366f1" blur={50}/></Frame>');
    assert.ok(/LAYER_BLUR/.test(code), code);
    assertValidJs(code);
  });

  it('Ellipse honors x/y in a flex="none" parent', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Ellipse name="B" w={20} h={20} bg="#6366f1" x={200} y={150}/></Frame>');
    assert.ok(/\.x = 200/.test(code), code);
    assert.ok(/\.y = 150/.test(code), code);
    assertValidJs(code);
  });

  it('Rect honors opacity and x/y in a flex="none" parent', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Rect name="R" w={20} h={20} bg="#6366f1" opacity={0.5} x={10} y={12}/></Frame>');
    assert.ok(/\.opacity = 0\.5/.test(code), code);
    assert.ok(/\.x = 10/.test(code) && /\.y = 12/.test(code), code);
    assertValidJs(code);
  });
});

// In a flex="none" (z-stack) parent, children are positioned by plain x/y.
// Setting layoutPositioning='ABSOLUTE' there THROWS (only valid in auto-layout),
// which used to abort before x/y was applied → children piled at 0,0.
describe('flex="none" parent positions children by plain x/y', () => {
  it('frame child gets x/y and does NOT get layoutPositioning ABSOLUTE', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Frame name="C" w={60} h={60} position="absolute" x={130} y={60}/></Frame>');
    assert.ok(/\.x = 130/.test(code), code);
    assert.ok(/\.y = 60/.test(code), code);
    assert.ok(!/layoutPositioning = 'ABSOLUTE'/.test(code), 'must not set ABSOLUTE in a NONE parent:\n' + code);
    assertValidJs(code);
  });

  it('two flex="none" children with no coords overlap at 0,0 (valid z-stack)', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="none"><Ellipse name="A" w={60} h={60} bg="#111"/><Frame name="B" w={60} h={60} bg="#222"/></Frame>');
    assertValidJs(code);
    assert.ok(!/layoutPositioning = 'ABSOLUTE'/.test(code), code);
  });
});
