import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/lib/jsx-render.js';

const client = new FigmaClient();

function assertValidJs(code) {
  assert.doesNotThrow(
    () => new Function(code),
    SyntaxError,
    `Generated code is not valid JS:\n${code}`
  );
}

// Variable and collection names come from user design systems and can
// legally contain quotes, backslashes and backticks (e.g. "Brand's Colors").
// Generated plugin code must stay syntactically valid for all of them.
describe('quoting of user-supplied names in generated code', () => {
  const hostileNames = [
    "Brand's Colors",
    'say "hi"',
    'back\\slash',
    'tick`tick',
    'newline\nname',
  ];

  for (const name of hostileNames) {
    it(`generateFillCode survives var name: ${JSON.stringify(name)}`, () => {
      const { code } = client.generateFillCode(`var:${name}`, 'el');
      assertValidJs(`const el = {}; function boundFill(a){return a;} function lookupVar(n){return n;} ${code}`);
    });

    it(`generateStrokeCode survives var name: ${JSON.stringify(name)}`, () => {
      const { code } = client.generateStrokeCode(`var:${name}`, 'el', 1);
      assertValidJs(`const el = {}; function boundFill(a){return a;} function lookupVar(n){return n;} ${code}`);
    });
  }
});

// ---- Generated-code hardening (render must not become a code channel) ----

describe('numeric props are coerced, never pasted verbatim', () => {
  const client2 = new FigmaClient();

  it('non-numeric w/h fall back instead of emitting raw text', async () => {
    // Note: a payload containing ">" is dropped by the tag regex entirely
    // (safe, but a different mechanism) — this one stays inside one tag.
    const code = await client2.parseJSX(
      '<Frame name="P"><Rectangle w="1);figma.root.remove();(" h="10" /></Frame>'
    );
    assertValidJs(code);
    assert.ok(!code.includes('figma.root.remove()'), 'injected payload must not survive into generated code');
    assert.match(code, /el\d+\.resize\(100, 10\)/, 'falls back to the default width');
  });

  it('non-numeric font size and icon size fall back', async () => {
    const code = await client2.parseJSX(
      '<Frame name="P"><Text size="abc">Hi</Text><Icon name="lucide:x" size="{{oops}}" /></Frame>'
    );
    assertValidJs(code);
    assert.match(code, /fontSize = 14/);
    assert.match(code, /resize\(24, 24\)/);
  });

  it('valid numeric strings still pass through', async () => {
    const code = await client2.parseJSX('<Frame name="P" w="640" h="480"><Rectangle w="12" h="34" /></Frame>');
    assertValidJs(code);
    assert.match(code, /frame\.resize\(640, 480\)/);
    assert.match(code, /el\d+\.resize\(12, 34\)/);
  });
});

describe('text/frame labels survive quotes, newlines and backslashes', () => {
  const client3 = new FigmaClient();

  it('apostrophes, newlines and backslashes in text do not break the code', async () => {
    const code = await client3.parseJSX(
      '<Frame name="It\'s a \\ test"><Text>Line1\nLine2 it\'s \\ ok</Text></Frame>'
    );
    assertValidJs(code);
  });

  it('unparsable colors fall back to grey instead of NaN', async () => {
    const code = await client3.parseJSX('<Frame name="P"><Rectangle bg="red" /></Frame>');
    assertValidJs(code);
    assert.ok(!code.includes('NaN'), 'no NaN may reach the generated code');
  });
});
