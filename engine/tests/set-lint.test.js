// `node set` and `analyze lint` — the two capabilities rebuilt from section B
// of the deletion notes. Both generate an eval string, so every snippet is
// parsed here: a syntax error inside a template literal is invisible to
// `node --check` and only surfaces once Figma runs it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetRequest, setCode } from '../src/commands/node-ops.js';
import { lintCode } from '../src/commands/analyze.js';
import { isWrite } from '../../src/server.js';

// A parser, not an executor: the body is compiled and never called.
const parses = (code, what) =>
  assert.doesNotThrow(() => new Function(code), SyntaxError, `${what} is not valid JS`);

describe('parseSetRequest', () => {
  test('accepts the spellings an LLM reaches for', () => {
    const a = parseSetRequest({ node: '1:2', width: 10, height: 20, name: 'Card' });
    const b = parseSetRequest({ id: '1:2', w: 10, h: 20, newName: 'Card' });
    assert.deepEqual(a, b);
  });

  test('coerces numbers and booleans out of CLI strings', () => {
    const r = parseSetRequest({ node: '1:2', radius: '8', visible: 'false' });
    assert.deepEqual(r.props, { radius: 8, visible: false });
  });

  test('a non-numeric number is refused, naming the property', () => {
    assert.throws(() => parseSetRequest({ node: '1:2', radius: 'abc' }), /radius must be a number/);
  });

  // Figma resizes in one call, so half a size is not a thing that can be sent.
  test('width without height is refused before the round-trip', () => {
    assert.throws(() => parseSetRequest({ node: '1:2', width: 10 }), /must be set together/);
    assert.throws(() => parseSetRequest({ node: '1:2', height: 10 }), /must be set together/);
  });

  test('an empty request is refused rather than sent as a no-op', () => {
    assert.throws(() => parseSetRequest({ node: '1:2' }), /no properties to set/);
  });

  test('unknown properties name the real ones', () => {
    assert.throws(() => parseSetRequest({ node: '1:2', colour: 'red' }), /unknown property "colour".*fill/s);
  });
});

describe('setCode', () => {
  test('generated eval parses for hex, var: and scalar properties', () => {
    parses(setCode([
      { nodeId: '1:2', props: { fill: 'var:sage/50', radius: 8, name: 'Card' } },
      { nodeId: '3:4', props: { stroke: '#ff8800', width: 10, height: 20, visible: false } },
    ], 'TARGET_COLLECTION'), 'setCode');
  });

  test('works without a collection pin', () => {
    parses(setCode([{ nodeId: '1:2', props: { fill: '#fff' } }], null), 'setCode unscoped');
  });

  // The reason var: exists at all: a frozen hex cannot be re-themed later.
  test('a var: fill is BOUND, a hex is not', () => {
    const code = setCode([{ nodeId: '1:2', props: { fill: 'var:x' } }], null);
    assert.ok(code.includes('setBoundVariableForPaint'), 'var: goes through the binding API');
    assert.ok(code.includes("input.startsWith('var:')"), 'and only var: does');
  });

  test('colour lookup reports ambiguity instead of taking the first match', () => {
    const code = setCode([{ nodeId: '1:2', props: { fill: 'var:radius/lg' } }], null);
    assert.ok(code.includes('__resolveVar'), 'shares the resolver with node bind');
    assert.ok(code.includes('narrow with --collection'));
  });

  test('a FLOAT variable is refused for a colour before the plugin call', () => {
    const code = setCode([{ nodeId: '1:2', props: { fill: 'var:space/4' } }], null);
    assert.ok(code.includes("resolvedType !== 'COLOR'"), 'the type is checked');
  });

  test('a quoted payload cannot break out of the eval', () => {
    const code = setCode([{ nodeId: '1:2', props: { name: 'a"); figma.root.remove(); //' } }], null);
    parses(code, 'setCode with a quoted name');
    assert.ok(!code.includes('a"); figma.root.remove()'), 'payload must not land unescaped');
  });
});

describe('lintCode', () => {
  test('node-rooted and page-wide forms both parse', () => {
    parses(lintCode({ rootId: '1:2', generic: ['frame', 'rect'] }), 'lint --node');
    parses(lintCode({ rootId: null, generic: ['frame'] }), 'lint page');
  });

  // The whole reason this was worth rebuilding. The deleted version reported
  // every solid fill as "Hardcoded fill color" — thousands of lines on a real
  // file. A colour is only actionable when a variable already holds it.
  test('an unbound colour is only reported when a variable holds that value', () => {
    const code = lintCode({ rootId: null, generic: [] });
    assert.ok(code.includes('byColor'), 'a value → variable index is built');
    assert.ok(/const match = byColor\.get\(key\(p\.color\)\);\s*\n\s*if \(!match\) continue;/.test(code),
      'no matching variable → no finding');
    assert.ok(code.includes('p.boundVariables && p.boundVariables.color'), 'already-bound paints are skipped');
  });

  test('each bindable finding carries the command that fixes it', () => {
    const code = lintCode({ rootId: null, generic: [] });
    assert.ok(code.includes("'node bind '"), 'the fix is a runnable node bind call');
    assert.ok(code.includes("' --collection '"), 'and it is collection-qualified, so it is unambiguous');
  });

  // "Frame 12" is Figma's auto-numbering; "Frame Header" is a decision. The
  // original used startsWith and flagged both.
  test('generic-name matching strips auto-numbering but is not a prefix test', () => {
    const code = lintCode({ rootId: null, generic: ['frame'] });
    assert.ok(code.includes('GENERIC.has(bare)'), 'exact match against the known type names');
    assert.ok(!code.includes('startsWith(\'Frame\')'), 'never a prefix test');
    // The trailing-number strip must survive template escaping into the eval.
    const stripper = code.match(/\.replace\((\/[^/]+\/), ''\)/);
    assert.ok(stripper, 'a trailing-number stripper is emitted');
    assert.equal('Frame 12'.trim().replace(new RegExp(stripper[1].slice(1, -1)), '').toLowerCase(), 'frame');
    assert.equal('Frame Header'.trim().replace(new RegExp(stripper[1].slice(1, -1)), '').toLowerCase(), 'frame header');
  });

  test('alias variables are skipped when indexing colours', () => {
    const code = lintCode({ rootId: null, generic: [] });
    assert.ok(code.includes("typeof val.r !== 'number'"), 'an alias has no rgb of its own');
  });
});

describe('the write gate sees both commands', () => {
  test('node set writes; the node reads stay reads', () => {
    assert.equal(isWrite(['node', 'set', '1:2', '--name', 'Card']), true);
    assert.equal(isWrite(['node', 'tree', '1:2']), false);
    assert.equal(isWrite(['node', 'bindings', '1:2']), false);
  });

  test('analyze lint is a read — it never writes to the document', () => {
    assert.equal(isWrite(['analyze', 'lint']), false);
    assert.equal(isWrite(['analyze', 'lint', '--fail-on-issues']), false);
  });
});
