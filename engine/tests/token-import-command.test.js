import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenImport,
  executeTokenImportPlan,
  prepareTokenImportItems,
  prepareTokenImportPlan,
  tokenImportPlanRoute,
} from '../src/application/token-import-command.js';
import {
  acceptsTokenImportArgv,
  parseTokenImportRequest,
  tokenImportArgvFromRequest,
} from '../src/application/token-import-request.js';
import {
  normalizeTokenImportItems,
  normalizeTokenImportSource,
} from '../src/application/token-import-source.js';
import { toSingleCollectionTokenItems } from '../src/design-md.js';

function fixture({ existing = [], failOn = null, duplicateCollection = false,
  throwOnMissing = false, undefinedOnMissing = false, staleMembershipOnRemove = false,
  retainRemovedReadback = false, longVariableIds = false, trackGetterConcurrency = false } = {}) {
  let next = 1;
  const collections = new Map();
  const variables = new Map();
  const getterReads = new Map();
  let getterInFlight = 0;
  let maxGetterConcurrency = 0;
  const makeCollection = (name, id = `c${next++}`) => {
    const collection = {
      id, name, remote: false, defaultModeId: `${id}-default`,
      modes: [{ modeId: `${id}-other`, name: 'Other' }, { modeId: `${id}-default`, name: 'Default' }],
      variableIds: [],
      remove() {
        collections.delete(id);
        for (const variableId of [...this.variableIds]) variables.get(variableId)?.remove();
      },
    };
    collections.set(id, collection); return collection;
  };
  const target = existing.length || duplicateCollection ? makeCollection('Imported Tokens', 'existing') : null;
  if (duplicateCollection) makeCollection('Imported Tokens', 'duplicate');
  const makeVariable = (name, collection, type, value, id = longVariableIds
    ? `v${String(next++).padStart(511, '0')}` : `v${next++}`) => {
    const variable = {
      id, name, resolvedType: type, remote: false, variableCollectionId: collection.id,
      description: '', scopes: ['ALL_SCOPES'], codeSyntax: {}, valuesByMode: {},
      setValueForMode(modeId, nextValue) {
        const namedSprings = {
          GENTLE: 0.25,
          QUICK: 0.42264973081037427,
          BOUNCY: 0.6938137821521027,
          SLOW: 0,
        };
        this.valuesByMode[modeId] = this.resolvedType === 'EASING'
          && nextValue?.type === 'LINEAR' && Object.keys(nextValue).length === 1
          ? { type: 'LINEAR', easingFunctionCubicBezier: { x1: 0, y1: 0, x2: 1, y2: 1 } }
          : this.resolvedType === 'EASING' && Object.hasOwn(namedSprings, nextValue?.type)
            ? { type: nextValue.type, easingFunctionSpring: { bounce: namedSprings[nextValue.type] } }
            : nextValue;
        if (failOn === name) throw new Error('injected setter failure after mutation');
      },
      setVariableCodeSyntax(platform, value) { this.codeSyntax[platform] = value; },
      remove() {
        if (!retainRemovedReadback) variables.delete(id);
        if (!staleMembershipOnRemove) {
          collection.variableIds = collection.variableIds.filter((candidate) => candidate !== id);
        }
      },
    };
    variables.set(id, variable); collection.variableIds.push(id);
    if (value !== undefined) variable.valuesByMode[collection.defaultModeId] = value;
    return variable;
  };
  for (const item of existing) {
    const variable = makeVariable(item.name, target, item.type, item.value, item.id);
    if (item.description !== undefined) variable.description = item.description;
    if (item.codeSyntax) variable.codeSyntax = { ...item.codeSyntax };
    if (item.scopes) variable.scopes = [...item.scopes];
  }
  const figma = { variables: {
    getLocalVariableCollectionsAsync: async () => [...collections.values()],
    getVariableCollectionByIdAsync: async (id) => {
      const value = collections.get(id);
      if (!value && throwOnMissing) throw new Error('removed collection identity');
      return value || null;
    },
    getVariableByIdAsync: async (id) => {
      getterReads.set(id, (getterReads.get(id) || 0) + 1);
      getterInFlight++;
      maxGetterConcurrency = Math.max(maxGetterConcurrency, getterInFlight);
      try {
        if (trackGetterConcurrency) await Promise.resolve();
        const value = variables.get(id);
        if (!value && throwOnMissing) throw new Error('removed variable identity');
        if (!value && undefinedOnMissing) return undefined;
        return value || null;
      } finally { getterInFlight--; }
    },
    createVariableCollection: (name) => makeCollection(name),
    createVariable: (name, collection, type) => makeVariable(name, collection, type),
    createVariableAlias: (variable) => ({ type: 'VARIABLE_ALIAS', id: variable.id }),
  } };
  return { figma, collections, variables, target, getterReads,
    maxGetterConcurrency: () => maxGetterConcurrency };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

function prepared(document, collection = 'Imported Tokens') {
  return { request: { file: '/workspace/tokens.json', collection, forceSlash: false },
    items: normalizeTokenImportSource(document) };
}

test('closed request canonicalizes options and rejects slash mistakes and option injection', () => {
  assert.deepEqual(parseTokenImportRequest(['tokens', 'import', '-c', 'Tokens', '--', '-tokens.json']), {
    file: '-tokens.json', collection: 'Tokens', forceSlash: false,
  });
  assert.equal(Object.isFrozen(
    parseTokenImportRequest(['tokens', 'import', '-c', 'Tokens', '--', '-tokens.json']),
  ), true);
  assert.throws(
    () => tokenImportArgvFromRequest({ file: 'tokens.json', collection: 123 }),
    /declared types/,
  );
  assert.deepEqual(tokenImportArgvFromRequest({ file: '-tokens.json', collection: 'A/B', forceSlash: true }),
    ['tokens', 'import', '--collection=A/B', '--force-slash', '--', '-tokens.json']);
  for (const argv of [
    ['tokens', 'import'],
    ['tokens', 'import', '--collection=A/B', 'tokens.json'],
    ['tokens', 'import', '--collection', '--force-slash', 'tokens.json'],
    ['tokens', 'import', '-c', '--', 'tokens.json'],
    ['tokens', 'import', '--wat', 'tokens.json'],
    ['tokens', 'import', 'one.json', 'two.json'],
  ]) assert.equal(acceptsTokenImportArgv(argv), false, argv.join(' '));
});

test('source preflight preserves false and zero, DTCG inheritance, alpha, metadata and aliases', () => {
  const items = normalizeTokenImportSource({
    enabled: { value: false, type: 'boolean' },
    zero: { value: 0, type: 'number' },
    color: { $type: 'color', base: { $value: { colorSpace: 'srgb', components: [1, 0.5, 0], alpha: 0.25 } },
      alias: { $value: '{color.base}' } },
    spacing: { $type: 'dimension', sm: { $value: '12px', scopes: ['GAP'], codeSyntax: { WEB: '--space-sm' } } },
    empty: { value: '', type: 'string' },
  });
  assert.equal(items.find((item) => item.name === 'enabled').value, false);
  assert.equal(items.find((item) => item.name === 'zero').value, 0);
  assert.deepEqual(items.find((item) => item.name === 'color/base').value,
    { r: 1, g: 0.5, b: 0, a: 0.25 });
  assert.equal(items.find((item) => item.name === 'color/alias').alias, 'color/base');
  assert.deepEqual(items.find((item) => item.name === 'spacing/sm'), {
    name: 'spacing/sm', type: 'FLOAT', value: 12, scopes: ['GAP'], codeSyntax: { WEB: '--space-sm' },
  });
  assert.equal(items.find((item) => item.name === 'empty').value, '');
});

test('untyped DTCG aliases inherit every supported target type after complete graph resolution', () => {
  const pairs = [
    ['boolean', true],
    ['color', '#336699'],
    ['easing', 'linear'],
    ['float', 12],
    ['string', 'Bridge'],
    ['timing', 120],
  ];
  const source = {};
  for (const [type, value] of pairs) {
    source[`${type}Base`] = { $type: type, $value: value };
    source[`${type}Alias`] = { $value: `{${type}Base}` };
  }
  const items = normalizeTokenImportSource(source);
  for (const [type] of pairs) {
    const base = items.find((item) => item.name === `${type}Base`);
    const alias = items.find((item) => item.name === `${type}Alias`);
    assert.equal(alias.type, base.type);
    assert.equal(alias.alias, base.name);
  }
});

test('DTCG $root maps to its group identity and preserves bounded descriptions', () => {
  const items = normalizeTokenImportSource({
    space: {
      $type: 'dimension',
      $root: { $value: '8px', $description: 'Base spacing\nfor layouts' },
      lg: { $value: '16px' },
    },
  });
  assert.deepEqual(items.map((item) => item.name), ['space', 'space/lg']);
  assert.equal(items[0].description, 'Base spacing\nfor layouts');
  assert.equal(items[0].value, 8);
});

test('DTCG $root collisions and Bridge multi-mode topology fail before readiness', () => {
  assert.throws(() => normalizeTokenImportSource({
    a: { b: { $root: { $type: 'number', $value: 1 } } },
    'a/b': { $type: 'number', $value: 2 },
  }), /duplicate token name a\/b/);
  assert.throws(() => normalizeTokenImportSource({ token: {
    $type: 'number', $value: 1,
    $extensions: { 'figma-bridge-mcp': {
      collection: 'Source', defaultModeId: 'm1',
      modes: [{ modeId: 'm1', name: 'Default' }],
      valuesByMode: { m1: { modeName: 'Default', value: 1 } },
    } },
  } }), /Portable Variable Snapshot import/);
});

test('source preflight round-trips Bridge metadata and DTCG 2025 values without inventing gamut conversion', () => {
  const items = normalizeTokenImportSource({
    brand: { $type: 'color', primary: { $value: {
      colorSpace: 'display-p3', components: [1, 0, 0], alpha: 1, hex: '#ff0000',
    }, $extensions: { 'figma-bridge-mcp': {
      scopes: ['FRAME_FILL'], codeSyntax: { WEB: '--brand-primary' },
    } } } },
    space: { $type: 'dimension', md: { $value: { value: 12, unit: 'px' } },
      lg: { $value: { value: 1, unit: 'rem' } } },
  });
  assert.deepEqual(items.find((item) => item.name === 'brand/primary'), {
    name: 'brand/primary', type: 'COLOR', value: { r: 1, g: 0, b: 0 },
    scopes: ['FRAME_FILL'], codeSyntax: { WEB: '--brand-primary' },
  });
  assert.equal(items.find((item) => item.name === 'space/md').value, 12);
  assert.equal(items.find((item) => item.name === 'space/lg').value, 16);
  assert.throws(() => normalizeTokenImportSource({ brand: { $type: 'color', bad: {
    $value: { colorSpace: 'display-p3', components: [1, 0, 0] },
  } } }), /hex fallback/);
});

test('source preflight fails aliases, cycles, duplicate identities and unsupported composites', () => {
  for (const source of [
    { a: { $value: '{missing}', $type: 'color' } },
    { a: { $value: '{b}', $type: 'string' }, b: { $value: '{a}', $type: 'string' } },
    { composite: { value: { x: 1 } } },
  ]) assert.throws(() => normalizeTokenImportSource(source), /Invalid token import source/);
  for (const control of ['\u061c', '\u200e', '\u200f']) {
    assert.throws(
      () => normalizeTokenImportSource({ [`safe${control}spoof`]: { value: '#ffffff' } }),
      /token name is empty, unsafe, or too long/,
    );
  }
});

test('alias graph validation remains linear enough at the declared 10k bound', () => {
  const items = Array.from({ length: 10_000 }, (_value, index) => ({
    name: `chain/${index}`, type: 'STRING',
    ...(index === 9_999 ? { value: 'end' } : { alias: `chain/${index + 1}` }),
  }));
  const normalized = normalizeTokenImportItems(items);
  assert.equal(normalized.length, 10_000);
  assert.equal(normalized[0].alias, 'chain/1');
});

test('Workspace source is read exactly once while preparing the Command Plan', () => {
  const workspaceDir = resolve('/workspace');
  const tokenPath = join(workspaceDir, 'tokens.json');
  const plan = planFigmaCommand(['tokens', 'import', 'tokens.json'], { adapter: 'mcp', workspaceDir });
  let reads = 0;
  const ready = prepareTokenImportPlan(plan, { workspaceIO: {
    limits: { jsonBytes: 1024, nestingDepth: 16, collectionEntries: 100 },
    readText(path, options) {
      reads++; assert.equal(path, tokenPath); assert.deepEqual(options, { role: 'token-file' });
      return '{"space":{"sm":{"value":8,"type":"float"}}}';
    },
  } });
  assert.equal(reads, 1);
  assert.equal(ready.items[0].name, 'space/sm');
  assert.equal(tokenImportPlanRoute(plan), 'command-application');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(plan.execution.timeout, 'long');
  assert.equal(plan.effects.workspace, 'read');
  assert.equal(plan.effects.figma, 'write');
});

test('converted design facts reuse prepared Token Import without an intermediate file', () => {
  const plan = planFigmaCommand([
    'tokens', 'import', '--collection=Converted', '/workspace/source.css',
  ], { adapter: 'cli' });
  const items = toSingleCollectionTokenItems({ tokens: {
    color: { brand: '#336699' },
    radius: { card: 12 },
    spacing: { stack: 8 },
    typography: { body: { fontFamily: 'Inter', fontSize: 16 } },
    shadow: { raised: { x: 0, y: 2, blur: 4 } },
  } });
  assert.deepEqual(items, [
    { name: 'brand', type: 'COLOR', value: '#336699' },
    { name: 'card', type: 'FLOAT', value: 12, scopes: ['CORNER_RADIUS'] },
    { name: 'stack', type: 'FLOAT', value: 8, scopes: ['GAP'] },
  ]);
  const prepared = prepareTokenImportItems(plan, items);
  assert.equal(prepared.request.file, '/workspace/source.css');
  assert.equal(prepared.request.collection, 'Converted');
  assert.deepEqual(prepared.items[0].value, {
    r: 0.2, g: 0.4, b: 0.6,
  });
  assert.equal(Object.isFrozen(prepared.items), true);
});

test('converted token families fail closed when their projected names collide', () => {
  const plan = planFigmaCommand([
    'tokens', 'import', '--collection=Converted', '/workspace/source.css',
  ], { adapter: 'cli' });
  const items = toSingleCollectionTokenItems({ tokens: {
    color: { shared: '#ffffff' },
    radius: { shared: 8 },
  } });
  assert.throws(() => prepareTokenImportItems(plan, items), /duplicate token name shared/);
});

test('new import uses declared default mode, all six native types, metadata and aliases', async () => {
  const live = fixture();
  const source = prepared({
    color: { base: { value: '#336699', type: 'color' }, alias: { $value: '{color.base}', $type: 'color' } },
    count: { value: 0, type: 'float' }, enabled: { value: false, type: 'boolean' },
    text: { value: '', type: 'string' }, ease: { value: 'linear', type: 'easing' },
    time: { value: 120, type: 'timing' },
  });
  const result = await executeTokenImport(source, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'complete');
  assert.equal(result.result.created.total, 7);
  const collection = [...live.collections.values()][0];
  assert.equal(collection.modes[0].modeId.endsWith('-other'), true);
  for (const variable of live.variables.values()) {
    assert.equal(Object.hasOwn(variable.valuesByMode, collection.defaultModeId), true);
    assert.equal(Object.hasOwn(variable.valuesByMode, collection.modes[0].modeId), false);
  }
  const alias = [...live.variables.values()].find((item) => item.name === 'color/alias');
  const base = [...live.variables.values()].find((item) => item.name === 'color/base');
  assert.deepEqual(alias.valuesByMode[collection.defaultModeId], { type: 'VARIABLE_ALIAS', id: base.id });
});

test('named EASING springs verify against Figma native float readback', async () => {
  const live = fixture();
  const source = prepared({ motion: { quick: {
    $type: 'string',
    $value: 'QUICK',
    $extensions: {
      'figma-bridge-mcp': {
        resolvedType: 'EASING',
        easing: {
          schemaVersion: 1,
          value: { type: 'QUICK', easingFunctionSpring: { bounce: 0.42265 } },
        },
      },
    },
  } } });
  const result = await executeTokenImport(source, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'complete');
  assert.equal(result.result.created.total, 1);
  assert.equal([...live.variables.values()][0].resolvedType, 'EASING');
});

test('explicit DTCG descriptions are created, verified and exact on existing Variables', async () => {
  const live = fixture();
  const source = prepared({ count: {
    $type: 'number', $value: 1, $description: 'Visible counter token',
  } });
  const result = await executeTokenImport(source, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.created.total, 1);
  assert.equal([...live.variables.values()][0].description, 'Visible counter token');

  const conflict = fixture({ existing: [{ name: 'count', type: 'FLOAT', value: 1,
    id: 'fixed', description: 'Different description' }] });
  await assert.rejects(() => executeTokenImport(source, { evaluate: evaluate(conflict.figma) }),
    /existing value or metadata differs/);
  assert.equal(conflict.variables.size, 1);
});

test('matching existing tokens are no-ops and differing values fail before writes', async () => {
  const same = fixture({ existing: [{ name: 'count', type: 'FLOAT', value: 0, id: 'fixed' }] });
  const matched = await executeTokenImport(prepared({ count: { value: 0, type: 'float' } }),
    { evaluate: evaluate(same.figma) });
  assert.equal(matched.result.matching.total, 1);
  assert.equal(same.variables.size, 1);
  assert.ok(same.getterReads.get('fixed') >= 2, 'matching identities must be freshly re-read');

  const conflict = fixture({ existing: [{ name: 'count', type: 'FLOAT', value: 1, id: 'fixed' }] });
  await assert.rejects(() => executeTokenImport(prepared({
    count: { value: 0, type: 'float' }, added: { value: 2, type: 'float' },
  }), { evaluate: evaluate(conflict.figma) }), /existing value or metadata differs/);
  assert.equal(conflict.variables.size, 1);
  assert.equal([...conflict.variables.values()][0].name, 'count');
});

test('explicit empty codeSyntax is exact while absent codeSyntax leaves metadata unmanaged', async () => {
  const absent = fixture({ existing: [{ name: 'count', type: 'FLOAT', value: 0,
    id: 'fixed', codeSyntax: { WEB: '--count' } }] });
  const matched = await executeTokenImport(prepared({ count: { value: 0, type: 'float' } }),
    { evaluate: evaluate(absent.figma) });
  assert.equal(matched.result.matching.total, 1);

  const explicit = fixture({ existing: [{ name: 'count', type: 'FLOAT', value: 0,
    id: 'fixed', codeSyntax: { WEB: '--count' } }] });
  await assert.rejects(() => executeTokenImport(prepared({ count: {
    value: 0, type: 'float', codeSyntax: {},
  } }), { evaluate: evaluate(explicit.figma) }), /metadata differs/);
  assert.equal(explicit.variables.size, 1);
});

test('ambiguous Collection fails before writes and injected setter failure cleans all resources', async () => {
  const ambiguous = fixture({ duplicateCollection: true });
  await assert.rejects(() => executeTokenImport(prepared({ a: 1 }),
    { evaluate: evaluate(ambiguous.figma) }), /ambiguous/);
  assert.equal(ambiguous.variables.size, 0);

  const live = fixture({ failOn: 'b' });
  await assert.rejects(() => executeTokenImport(prepared({ a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(live.variables.size, 0);
  assert.equal(live.collections.size, 0);
});

test('cleanup proves absence when Figma rejects fresh reads for removed identities', async () => {
  const live = fixture({ failOn: 'b', throwOnMissing: true });
  await assert.rejects(() => executeTokenImport(prepared({ a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(live.variables.size, 0);
  assert.equal(live.collections.size, 0);
});

test('cleanup treats undefined removed identities as absent', async () => {
  const live = fixture({ failOn: 'b', undefinedOnMissing: true });
  await assert.rejects(() => executeTokenImport(prepared({ a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
});

test('cleanup trusts fresh membership when removed ids still return tombstoned Variables', async () => {
  const live = fixture({
    existing: [{ name: 'kept', type: 'FLOAT', value: 1, id: 'kept' }],
    failOn: 'b', retainRemovedReadback: true,
  });
  await assert.rejects(() => executeTokenImport(prepared({ kept: 1, a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.deepEqual(live.target.variableIds, ['kept']);
});

test('cleanup refuses a rolled-back claim when fresh Collection membership is stale', async () => {
  const live = fixture({
    existing: [{ name: 'kept', type: 'FLOAT', value: 1, id: 'kept' }],
    failOn: 'b', staleMembershipOnRemove: true,
  });
  await assert.rejects(() => executeTokenImport(prepared({ kept: 1, a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
});

test('prepared items are deeply canonical and forged success partitions are rejected', async () => {
  const source = prepared({ a: { value: '#fff', type: 'color' }, b: 2 });
  assert.equal(Object.isFrozen(source.items), true);
  assert.equal(Object.isFrozen(source.items[0].value), true);
  await assert.rejects(() => executeTokenImport({ request: source.request,
    items: [{ name: 'a', type: 'FLOAT', value: 1, future: true }] },
  { evaluate: async () => { throw new Error('must not evaluate'); } }), /closed shape/);

  await assert.rejects(() => executeTokenImport(source, { evaluate: async () => JSON.stringify({
    schemaVersion: 1, status: 'complete',
    collection: { id: 'c1', name: 'Imported Tokens', created: true, modeId: 'm1' },
    created: { total: 2, indexes: [0, 0] }, matching: { total: 0, indexes: [] },
    residue: { total: 0, items: [], omitted: 0 },
  }) }), /invalid bounded result/);
  for (const collection of [
    { id: 'bad\u001bidentity', name: 'Imported Tokens', created: false, modeId: 'm1' },
    { id: 'c1', name: 'Imported Tokens', created: false, modeId: 'bad/value' },
    { id: `c${'0'.repeat(512)}`, name: 'Imported Tokens', created: false, modeId: 'm1' },
  ]) await assert.rejects(() => executeTokenImport(source, { evaluate: async () => JSON.stringify({
    schemaVersion: 1, status: 'complete', collection,
    created: { total: 0, indexes: [] }, matching: { total: 2, indexes: [0, 1] },
    residue: { total: 0, items: [], omitted: 0 },
  }) }), /invalid bounded result/);
  await assert.rejects(() => executeTokenImport(source, { evaluate: async () => JSON.stringify({
    schemaVersion: 1, status: 'complete',
    collection: { id: 'c1', name: 'Imported Tokens', created: true, modeId: 'm1' },
    created: { total: 1, indexes: [0] }, matching: { total: 1, indexes: [1] },
    residue: { total: 0, items: [], omitted: 0 },
  }) }), /invalid bounded result/);
});

test('failure result requires an exact unique exhaustive journal partition', async () => {
  const source = prepared({ a: 1, b: 2 });
  const base = {
    schemaVersion: 1, status: 'failed', outcome: 'rolled-back',
    attempted: { total: 2, collectionAttempted: false },
    removed: { total: 2, indexes: [0, 1] },
    residue: { total: 0, indexes: [], items: [], omitted: 0 }, failure: 'injected',
  };
  for (const payload of [
    { ...base, removed: { total: 2, indexes: [0, 0] } },
    { ...base, outcome: 'verification-unavailable' },
    { ...base, attempted: { total: 3, collectionAttempted: false },
      removed: { total: 3, indexes: [0, 1, 2] } },
    { ...base, removed: { total: 1, indexes: [0] },
      residue: { total: 1, indexes: [1], items: [{ journalIndex: 1, kind: 'variable',
        id: 'foreign', name: 'foreign' }], omitted: 0 } },
    { ...base, removed: { total: 1, indexes: [0] },
      residue: { total: 1, indexes: [1], items: [{ journalIndex: 1, kind: 'variable',
        id: 'bad\u001bidentity', name: 'b' }], omitted: 0 }, outcome: 'partial-residue' },
  ]) await assert.rejects(() => executeTokenImport(source, {
    evaluate: async () => JSON.stringify(payload),
  }), /invalid bounded result/);
});

test('bounded failure facts survive worst-case supported residue projection', async () => {
  const names = Array.from({ length: 64 }, (_value, index) =>
    `${'"'.repeat(500)}${String(index).padStart(2, '0')}`);
  const source = { request: { file: '/workspace/tokens.json', collection: 'Imported Tokens', forceSlash: false },
    items: names.map((name) => ({ name, type: 'FLOAT', value: 1 })) };
  const payload = {
    schemaVersion: 1, status: 'failed', outcome: 'partial-residue',
    attempted: { total: 64, collectionAttempted: false },
    removed: { total: 0, indexes: [] },
    residue: { total: 64, indexes: names.map((_name, index) => index),
      items: names.map((name, index) => ({ journalIndex: index, kind: 'variable',
        id: `VariableID:${String(index).padStart(500, '0')}`, name })), omitted: 0 },
    failure: 'injected',
  };
  const serialized = JSON.stringify(payload);
  assert.ok(serialized.length < 262_144);
  await assert.rejects(() => executeTokenImport(source, { evaluate: async () => serialized }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 64);
});

test('near-bound native ids still preserve a typed rollback outcome', async () => {
  const live = fixture({ failOn: 'b', longVariableIds: true });
  await assert.rejects(() => executeTokenImport(prepared({ a: 1, b: 2 }),
    { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
});

test('rollback verification uses Collection membership instead of per-Variable reads', async () => {
  const live = fixture({
    existing: [{ name: 'kept', type: 'FLOAT', value: 1, id: 'kept' }],
    failOn: 'created/129', trackGetterConcurrency: true,
  });
  const source = { kept: 1 };
  for (let index = 0; index < 130; index++) source[`created/${index}`] = index;
  await assert.rejects(() => executeTokenImport(prepared(source),
    { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.equal(live.maxGetterConcurrency(), 1);
  assert.equal([...live.getterReads.values()].reduce((sum, count) => sum + count, 0), 1);
});

test('prepared source must match the authentic Command Plan', async () => {
  const plan = planFigmaCommand(['tokens', 'import', '/workspace/tokens.json'], { adapter: 'cli' });
  const live = fixture();
  await assert.rejects(() => executeTokenImportPlan(plan,
    prepared({ a: 1 }, 'Different'), { evaluate: evaluate(live.figma) }), /does not match/);
});
