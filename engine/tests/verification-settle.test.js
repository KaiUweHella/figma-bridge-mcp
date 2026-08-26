import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verificationLayoutSettleCode, verificationPngExportCode } from '../src/application/verification-settle.js';

describe('coupled verification layout settle contract', () => {
  it('waits for two stable bounded geometry samples without inspecting content', () => {
    const code = verificationLayoutSettleCode('node');

    assert.match(code, /figmaBridgeSettleAttempt < 5/);
    assert.match(code, /figmaBridgeStableLayoutSamples >= 2/);
    assert.match(code, /setTimeout\(resolve, 20\)/);
    assert.match(code, /child\.width, child\.height/);
    assert.doesNotMatch(code, /fills|characters|imageHash/);
  });

  it('accepts only a closed identifier interpolation', () => {
    assert.throws(() => verificationLayoutSettleCode('node; figma.closePlugin()'), /must be an identifier/);
    assert.throws(() => verificationPngExportCode('node', 'scale; figma.closePlugin()'), /scale must be an identifier/);
  });

  it('retains the richest same-node PNG and stops after a stable repeat', async () => {
    const lengths = [12, 240, 240, 8];
    let exports = 0;
    const node = {
      width: 100, height: 80, children: [],
      async exportAsync() { exports++; return Uint8Array.from({ length: lengths.shift() }, () => 1); },
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction(
      'node', 'scale', 'setTimeout',
      `${verificationPngExportCode('node', 'scale')}\nreturn bytes.length;`,
    );

    const result = await run(node, 1, (resolve) => { resolve(); return 0; });

    assert.equal(result, 240);
    assert.equal(exports, 3);
  });
});
