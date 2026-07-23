import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}

// lineHeight, letterSpacing and align were in the known-prop list but never
// applied (silent footguns). truncate/maxLines are new. All now emit real
// Plugin API calls in nested text.
describe('text typography props', () => {
  const client = new FigmaClient();

  it('applies numeric lineHeight as PIXELS', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} lineHeight={20}>Hi</Text></Frame>');
    assert.ok(/lineHeight = \{ value: 20, unit: 'PIXELS' \}/.test(code), 'numeric lineHeight -> PIXELS');
    assertValidJs(code);
  });

  it('applies percentage lineHeight as PERCENT', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} lineHeight="150%">Hi</Text></Frame>');
    assert.ok(/lineHeight = \{ value: 150, unit: 'PERCENT' \}/.test(code), 'percent lineHeight -> PERCENT');
  });

  it('applies letterSpacing', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} letterSpacing={0.5}>Hi</Text></Frame>');
    assert.ok(/letterSpacing = \{ value: 0\.5, unit: 'PIXELS' \}/.test(code), 'letterSpacing applied');
  });

  it('maps align to textAlignHorizontal', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} align="center">Hi</Text></Frame>');
    assert.ok(/textAlignHorizontal = 'CENTER'/.test(code), 'align=center -> CENTER');
  });

  it('truncate sets textTruncation ENDING', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} truncate={true} w="fill">Long</Text></Frame>');
    assert.ok(/textTruncation = 'ENDING'/.test(code), 'truncate -> ENDING');
  });

  it('maxLines is set AFTER textTruncation (order matters — ENDING resets maxLines)', async () => {
    const code = await client.parseJSX('<Frame name="P" flex="col"><Text size={14} maxLines={2} w="fill">Long</Text></Frame>');
    const truncIdx = code.indexOf("textTruncation = 'ENDING'");
    const maxIdx = code.indexOf('maxLines = 2');
    assert.ok(truncIdx >= 0 && maxIdx >= 0, 'both emitted');
    assert.ok(truncIdx < maxIdx, 'textTruncation must come before maxLines or maxLines gets reset to 1');
    assertValidJs(code);
  });
});
