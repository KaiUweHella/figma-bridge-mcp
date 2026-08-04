// `node bind` and `tokens rebind` — the two capabilities rebuilt from the
// deleted selection-driven commands. Both build an eval string, so every
// generated snippet is parsed here: a syntax error inside a template literal
// is invisible to `node --check` and only surfaces in Figma.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBindRequest, bindCode } from '../src/commands/node-ops.js';
import { rebindCode } from '../src/commands/tokens.js';
import { isWrite } from '../../src/server.js';

// `new Function(code)` here is a PARSER, not an executor: it compiles the body
// and is never called, so nothing in the snippet runs. Same use as
// assertValidJs in render-batch-parity.test.js. The inputs are strings this
// repo generated, never user data.
const parses = (code, what) =>
  assert.doesNotThrow(() => new Function(code), SyntaxError, `${what} is not valid JS`);

describe('parseBindRequest', () => {
  test('accepts the short and the long key spelling', () => {
    const a = parseBindRequest({ node: '1:2', property: 'fill', variable: 'brand' });
    const b = parseBindRequest({ nodeId: '1:2', prop: 'fill', var: 'brand' });
    assert.deepEqual(a, b);
  });

  test('normalizes a dashed node id (the form Figma URLs carry)', () => {
    assert.equal(parseBindRequest({ node: '12-34', property: 'radius', variable: 'r' }).nodeId, '12:34');
  });

  test('an unknown property is refused, and the message lists the real ones', () => {
    assert.throws(
      () => parseBindRequest({ node: '1:2', property: 'colour', variable: 'x' }),
      /unknown property "colour".*fill/s,
    );
  });

  test('each missing field names itself', () => {
    assert.throws(() => parseBindRequest({ property: 'fill', variable: 'x' }), /missing node id/);
    assert.throws(() => parseBindRequest({ node: '1:2', variable: 'x' }), /missing property/);
    assert.throws(() => parseBindRequest({ node: '1:2', property: 'fill' }), /missing variable name/);
  });
});

describe('bindCode', () => {
  test('generated eval parses, for paint and scalar properties alike', () => {
    const code = bindCode([
      { nodeId: '1:2', property: 'fill', varName: 'sage/50', collection: 'Sprout Primitives' },
      { nodeId: '3:4', property: 'padding', varName: 'space/6', collection: null },
    ]);
    parses(code, 'bindCode');
  });

  test('a quote in a variable name cannot break out of the eval', () => {
    const code = bindCode([{ nodeId: '1:2', property: 'fill', varName: 'a"); figma.root.remove(); //', collection: null }]);
    parses(code, 'bindCode with a quoted name');
    // The name must survive as DATA — JSON.stringify escapes it, so the raw
    // sequence never appears unescaped in the source.
    assert.ok(!code.includes('a"); figma.root.remove()'), 'payload must not land unescaped');
  });

  // The reason this command exists in this shape: the deleted `bind` group did
  // `vars.find(v => v.name === name || v.name.endsWith('/'+name))` and used
  // whatever came first. This file has radius/lg in two collections.
  test('the resolver reports every match rather than picking one', () => {
    const code = bindCode([{ nodeId: '1:2', property: 'radius', varName: 'radius/lg', collection: null }]);
    assert.ok(code.includes('variables match'), 'ambiguity is reported to the caller');
    assert.ok(code.includes('narrow with --collection'), 'and it says how to settle it');
  });

  test('type mismatch is caught before the plugin call', () => {
    const code = bindCode([{ nodeId: '1:2', property: 'radius', varName: 'x', collection: null }]);
    assert.ok(/resolvedType !== spec\.type/.test(code), 'the variable type is checked against the property');
  });
});

describe('rebindCode', () => {
  test('node-rooted and page-wide forms both parse', () => {
    parses(rebindCode({ target: 'TARGET_COLLECTION', rootId: '1:2', wholePage: false, apply: false }), 'rebind --node');
    parses(rebindCode({ target: 'SOURCE_COLLECTION', rootId: null, wholePage: true, apply: true }), 'rebind --page');
  });

  test('a collection name with a quote stays inert', () => {
    parses(rebindCode({ target: 'He said "hi"', rootId: '1:2', wholePage: false, apply: false }), 'quoted collection');
  });

  test('without --apply the eval never writes', () => {
    const plan = rebindCode({ target: 'TARGET_COLLECTION', rootId: '1:2', wholePage: false, apply: false });
    assert.ok(plan.includes('const apply = false;'), 'plan mode is compiled in, not decided at runtime');
    // Both write paths are guarded by that flag.
    assert.ok(/if \(changed && apply\)/.test(plan), 'paint writes are guarded');
    assert.ok(/if \(apply\) \{\s*try \{ n\.setBoundVariable/.test(plan), 'scalar writes are guarded');
  });

  test('bindings already in the target collection are skipped', () => {
    const code = rebindCode({ target: 'TARGET_COLLECTION', rootId: '1:2', wholePage: false, apply: true });
    assert.ok(
      (code.match(/variableCollectionId === targetCol\.id/g) || []).length >= 2,
      'both the paint and the scalar branch skip already-correct bindings',
    );
  });
});

describe('the write gate sees both commands', () => {
  test('node bind writes; node bindings still reads', () => {
    assert.equal(isWrite(['node', 'bind', '1:2', 'fill', 'brand']), true);
    assert.equal(isWrite(['node', 'bindings', '1:2']), false);
  });

  // Same rule as `tokens sync`: the plan is a read, --apply is the write.
  // Gating the plan would make an agent ask permission to look.
  test('tokens rebind is gated on --apply, not on the subcommand', () => {
    assert.equal(isWrite(['tokens', 'rebind', 'TARGET_COLLECTION', '--node', '1:2']), false);
    assert.equal(isWrite(['tokens', 'rebind', 'TARGET_COLLECTION', '--node', '1:2', '--apply']), true);
  });
});
