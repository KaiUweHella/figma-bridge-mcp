import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeVariableSnapshotV2 } from '../src/lib/variable-snapshot.js';

function fixture() {
  return {
    schemaVersion: 2,
    kind: 'figma-variable-snapshot',
    complete: true,
    collections: [
      {
        handle: 'c:one', name: 'Theme', sourceKey: 'source-collection-key',
        hiddenFromPublishing: false, defaultMode: 'c:one/m:dark',
        modes: [
          { handle: 'c:one/m:light', name: 'Same' },
          { handle: 'c:one/m:dark', name: 'Same' },
        ],
        variables: [
          {
            handle: 'c:one/v:color', name: 'duplicate', type: 'COLOR',
            description: 'Color', hiddenFromPublishing: false, scopes: ['ALL_FILLS'],
            codeSyntax: { WEB: '--color' },
            values: { 'c:one/m:light': { r: 1, g: 0, b: 0, a: 1 } },
          },
          {
            handle: 'c:one/v:alias', name: 'duplicate', type: 'COLOR',
            description: '', hiddenFromPublishing: true, scopes: ['ALL_SCOPES'], codeSyntax: {},
            values: { 'c:one/m:dark': { $alias: {
              status: 'local', collection: 'c:two', variable: 'c:two/v:target',
            } } },
          },
        ],
      },
      {
        handle: 'c:two', name: 'Theme', hiddenFromPublishing: true,
        defaultMode: 'c:two/m:base', modes: [{ handle: 'c:two/m:base', name: 'Base' }],
        variables: [
          {
            handle: 'c:two/v:target', name: 'duplicate', type: 'COLOR',
            description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
            values: { 'c:two/m:base': '#000000' },
          },
          {
            handle: 'c:two/v:external', name: 'external', type: 'COLOR',
            description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
            values: { 'c:two/m:base': { $alias: {
              status: 'unresolved', sourceId: 'VariableID:remote',
            } } },
          },
        ],
      },
    ],
  };
}

test('v2 source preflight is closed, typed, identity-safe and deeply immutable', () => {
  const snapshot = normalizeVariableSnapshotV2(fixture());
  assert.equal(snapshot.collections.length, 2);
  assert.equal(snapshot.collections[0].defaultMode, 'c:one/m:dark');
  assert.deepEqual(snapshot.collections.map((collection) => collection.name), ['Theme', 'Theme']);
  assert.deepEqual(snapshot.collections[0].variables.map((variable) => variable.name),
    ['duplicate', 'duplicate']);
  assert.deepEqual(snapshot.collections[0].variables[1].values['c:one/m:dark'], {
    $alias: { status: 'local', collection: 'c:two', variable: 'c:two/v:target' },
  });
  assert.deepEqual(snapshot.collections[1].variables[0].values['c:two/m:base'],
    { r: 0, g: 0, b: 0 });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.collections[0].variables[0].values), true);
});

test('v2 source preflight preserves composed color Alias opacity exactly', () => {
  const value = fixture();
  value.collections[0].variables[1].values['c:one/m:dark'].$alias.opacity = 42;
  const snapshot = normalizeVariableSnapshotV2(value);
  assert.deepEqual(snapshot.collections[0].variables[1].values['c:one/m:dark'], {
    $alias: {
      status: 'local', collection: 'c:two', variable: 'c:two/v:target', opacity: 42,
    },
  });

  for (const opacity of [-1, 101, Infinity]) {
    const malformed = fixture();
    malformed.collections[0].variables[1].values['c:one/m:dark'].$alias.opacity = opacity;
    assert.throws(() => normalizeVariableSnapshotV2(malformed), /Invalid Variable Snapshot v2/);
  }
});

test('v2 source preflight rejects identity, topology, metadata and value drift', () => {
  const cases = [
    (value) => { value.schemaVersion = 3; },
    (value) => { value.collections[1].handle = 'c:one'; },
    (value) => { value.collections[0].defaultMode = 'c:two/m:base'; },
    (value) => { value.collections[0].variables[0].name = 'unsafe\u200fspoof'; },
    (value) => { value.collections[0].variables[0].scopes = ['GAP']; },
    (value) => { value.collections[0].variables[0].codeSyntax = { CSS: '--color' }; },
    (value) => { value.collections[0].variables[0].values = { 'c:two/m:base': '#fff' }; },
    (value) => { value.collections[0].variables[0].values['c:one/m:light'] = Infinity; },
    (value) => { value.collections[0].variables[0].values['c:one/m:light'] = 'x'.repeat(20_000); },
    (value) => { value.collections[0].variables[1].values['c:one/m:dark']
      .$alias.variable = 'missing'; },
    (value) => { value.collections[0].variables[1].values['c:one/m:dark']
      .$alias.collection = 'c:one'; },
    (value) => { value.collections[1].variables[1].values['c:two/m:base']
      .$alias.sourceId = 'unsafe\u061cspoof'; },
    (value) => { value.collections[0].surprise = true; },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => normalizeVariableSnapshotV2(value), /Invalid Variable Snapshot v2/);
  }
});

test('v2 source preflight preserves all six native Variable families', () => {
  const value = fixture();
  value.collections[0].variables = [
    ['COLOR', { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }],
    ['FLOAT', 12],
    ['STRING', 'Inter'],
    ['BOOLEAN', false],
    ['EASING', { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: {
      x1: 0.1, y1: 0.2, x2: 0.3, y2: 1,
    } }],
    ['TIMING', 180],
  ].map(([type, literal], index) => ({
    handle: `c:one/v:${index + 1}`, name: `value-${index + 1}`, type,
    description: '', hiddenFromPublishing: false,
    scopes: ['ALL_SCOPES'], codeSyntax: {}, values: { 'c:one/m:light': literal },
  }));
  const normalized = normalizeVariableSnapshotV2(value);
  assert.deepEqual(normalized.collections[0].variables.map((variable) => variable.type),
    ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN', 'EASING', 'TIMING']);
});

test('v2 source preflight requires Figma-native canonical EASING facts', () => {
  const value = fixture();
  Object.assign(value.collections[0].variables[0], {
    type: 'EASING', scopes: ['ALL_SCOPES'], values: {
      'c:one/m:light': { type: 'LINEAR' },
    },
  });
  assert.throws(() => normalizeVariableSnapshotV2(value), /native canonical form/);
  value.collections[0].variables[0].values['c:one/m:light'] = {
    type: 'LINEAR',
    easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 1, y2: 1 },
  };
  assert.doesNotThrow(() => normalizeVariableSnapshotV2(value));
  value.collections[0].variables[0].values['c:one/m:light'] = {
    type: 'LINEAR',
    easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 1, y2: 1 },
  };
  assert.throws(() => normalizeVariableSnapshotV2(value), /native canonical form/);

  value.collections[0].variables[0].values['c:one/m:light'] = {
    type: 'GENTLE', easingFunctionSpring: { bounce: 0.5 },
  };
  assert.throws(() => normalizeVariableSnapshotV2(value), /native canonical form/);
  value.collections[0].variables[0].values['c:one/m:light'] = {
    type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 },
  };
  assert.doesNotThrow(() => normalizeVariableSnapshotV2(value));
});

test('v2 source preflight requires native EASING and TIMING scopes', () => {
  for (const [type, literal] of [
    ['EASING', { type: 'HOLD' }], ['TIMING', 120],
  ]) {
    const value = fixture();
    Object.assign(value.collections[0].variables[0], {
      type, scopes: [], values: { 'c:one/m:light': literal },
    });
    assert.throws(() => normalizeVariableSnapshotV2(value), /native ALL_SCOPES form/);
    value.collections[0].variables[0].scopes = ['ALL_SCOPES'];
    assert.doesNotThrow(() => normalizeVariableSnapshotV2(value));
  }
});

test('v2 source preflight enforces per-field and serialized importable bounds', () => {
  const oversizedString = fixture();
  Object.assign(oversizedString.collections[0].variables[0], {
    type: 'STRING', scopes: ['ALL_SCOPES'], values: {
      'c:one/m:light': 'x'.repeat(16_385),
    },
  });
  assert.throws(() => normalizeVariableSnapshotV2(oversizedString), /STRING value is too long/);

  const oversizedDocument = fixture();
  oversizedDocument.collections[0].variables = Array.from({ length: 600 }, (_value, index) => ({
    handle: `c:one/v:large-${index}`, name: `large-${index}`, type: 'STRING',
    description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { 'c:one/m:light': 'x'.repeat(16_384) },
  }));
  assert.throws(() => normalizeVariableSnapshotV2(oversizedDocument), /serialized contract exceeds/);
});

test('v2 source preflight rejects local Alias cycles without recursion', () => {
  const value = fixture();
  value.collections[0].variables[0].values = {
    'c:one/m:light': { $alias: {
      status: 'local', collection: 'c:one', variable: 'c:one/v:alias',
    } },
  };
  value.collections[0].variables[1].values = {
    'c:one/m:dark': { $alias: {
      status: 'local', collection: 'c:one', variable: 'c:one/v:color',
    } },
  };
  assert.throws(() => normalizeVariableSnapshotV2(value), /Alias graph contains a cycle/);
});

test('v2 source errors never reflect unsafe or unbounded mode/value discriminators', () => {
  for (const unsafeKey of ['bad\nmode', 'bad\u200fmode', 'x'.repeat(513)]) {
    const value = fixture();
    value.collections[0].variables[0].values = { [unsafeKey]: '#fff' };
    assert.throws(() => normalizeVariableSnapshotV2(value), (error) => {
      assert.doesNotMatch(error.message, /bad|x{64}|\n|\u200f/u);
      return true;
    });
  }
  const malformedEasing = fixture();
  Object.assign(malformedEasing.collections[0].variables[0], {
    type: 'EASING', scopes: ['ALL_SCOPES'], values: {
      'c:one/m:light': { type: `unsafe\n${'z'.repeat(16_384)}` },
    },
  });
  assert.throws(() => normalizeVariableSnapshotV2(malformedEasing), (error) => {
    assert.doesNotMatch(error.message, /unsafe|z{64}|\n/);
    assert.match(error.message, /incompatible literal value/);
    return true;
  });
  const malformedType = fixture();
  malformedType.collections[0].variables[0].type = `unsafe\n${'t'.repeat(16_384)}`;
  assert.throws(() => normalizeVariableSnapshotV2(malformedType), (error) => {
    assert.doesNotMatch(error.message, /unsafe|t{64}|\n/);
    assert.match(error.message, /type is unsupported/);
    return true;
  });
});

test('v2 source preflight aligns with the workspace JSON structure budget', () => {
  const value = fixture();
  value.collections[0].variables = Array.from({ length: 6_000 }, (_entry, index) => ({
    handle: `c:one/v:bounded-${index}`, name: `bounded-${index}`, type: 'FLOAT',
    description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { 'c:one/m:light': index },
  }));
  assert.throws(() => normalizeVariableSnapshotV2(value), /workspace structure limits/);
});
