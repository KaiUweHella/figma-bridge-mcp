import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/figma-client.js';

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
