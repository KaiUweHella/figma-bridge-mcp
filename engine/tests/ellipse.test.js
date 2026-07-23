import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `bad JS:\n${code}`);
}

// <Ellipse>/<Circle> primitive: rings, spinners, donut/pie via arc + innerRadius.
describe('Ellipse / Circle primitive', () => {
  const client = new FigmaClient();

  it('creates an ellipse with a fill', async () => {
    const code = await client.parseJSX('<Frame name="P"><Ellipse name="Dot" w={20} h={20} bg="#f00"/></Frame>');
    assert.ok(/createEllipse\(\)/.test(code));
    assert.ok(/el\d+\.resize\(20, 20\)/.test(code));
    assertValidJs(code);
  });

  it('Circle is an alias of Ellipse', async () => {
    const code = await client.parseJSX('<Frame name="P"><Circle name="C" w={16} h={16} bg="#0a0"/></Frame>');
    assert.ok(/createEllipse\(\)/.test(code));
  });

  it('innerRadius makes a ring (full arcData)', async () => {
    const code = await client.parseJSX('<Frame name="P"><Ellipse name="Ring" w={32} h={32} innerRadius={0.8} bg="#ddd"/></Frame>');
    assert.ok(/arcData = \{ startingAngle: 0, endingAngle: 6\.283\d*, innerRadius: 0\.8 \}/.test(code), code);
    assertValidJs(code);
  });

  it('arc + arcStart make a swept slice in radians', async () => {
    const code = await client.parseJSX('<Frame name="P"><Ellipse name="Arc" w={32} h={32} arc={90} arcStart={-90} innerRadius={0.8} bg="#00f"/></Frame>');
    // -90deg = -PI/2, +90 sweep -> end 0
    assert.ok(/startingAngle: -1\.570\d*/.test(code), code);
    assert.ok(/endingAngle: 0,/.test(code), code);
    assertValidJs(code);
  });

  it('supports stroke and var: fills', async () => {
    const code = await client.parseJSX('<Frame name="P"><Ellipse name="E" w={24} h={24} bg="var:accent" stroke="var:border" strokeWidth={2}/></Frame>');
    assertValidJs(code);
  });

  it('parity through parseJSXBatch', async () => {
    const code = await client.parseJSXBatch(['<Frame name="P"><Ellipse name="Ring" w={32} h={32} innerRadius={0.85} bg="#ddd"/></Frame>']);
    assert.ok(/createEllipse\(\)/.test(code));
    assertValidJs(code);
  });
});
