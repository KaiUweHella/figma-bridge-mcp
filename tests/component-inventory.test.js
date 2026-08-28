import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMPONENT_INVENTORY_SCHEMA_VERSION,
  MAX_COMPONENT_INVENTORY_SERIALIZED_BYTES,
  cachedInventoryCode,
  componentInventoryCode,
  projectComponentInventory,
} from '../engine/src/lib/component-inventory.js';

function component(id, name, key = '') {
  return { type: 'COMPONENT', id, name, key, children: [] };
}

function fixture() {
  const first = component('1:2', 'State=On', 'variant-on');
  const second = component('1:3', 'State=Off', 'variant-off');
  const set = {
    type: 'COMPONENT_SET', id: '1:1', name: 'Control', key: 'control-key',
    children: [first, second], defaultVariant: first,
    variantGroupProperties: { State: { values: ['On', 'Off'] } },
  };
  const single = component('2:1', 'Logo', 'logo-key');
  const page = { type: 'PAGE', id: '0:1', name: 'Library', children: [set, single] };
  return {
    root: { type: 'DOCUMENT', name: 'Example', children: [page] },
    currentPage: page,
    async loadAllPagesAsync() {},
  };
}

async function evaluateWithFigma(code, figma) {
  const previous = globalThis.figma;
  globalThis.figma = figma;
  try {
    // The production seam deliberately produces Plugin-sandbox JavaScript.
    return await (0, eval)(code);
  } finally {
    if (previous === undefined) delete globalThis.figma;
    else globalThis.figma = previous;
  }
}

test('component inventory returns complete bounded identity and variant facts', async () => {
  const result = await evaluateWithFigma(componentInventoryCode(false), fixture());
  const projected = projectComponentInventory(result);

  assert.equal(projected.schemaVersion, COMPONENT_INVENTORY_SCHEMA_VERSION);
  assert.equal(projected.scope, 'CURRENT_PAGE');
  assert.equal(projected.pagesScanned, 1);
  assert.equal(projected.visited, 4);
  assert.equal(projected.fileName, 'Example');
  assert.deepEqual(projected.componentSets[0], {
    id: '1:1', name: 'Control', page: 'Library', key: 'control-key',
    defaultVariantId: '1:2',
    variantAxes: { State: { values: ['On', 'Off'] } },
    variants: [
      { id: '1:2', name: 'State=On', key: 'variant-on' },
      { id: '1:3', name: 'State=Off', key: 'variant-off' },
    ],
  });
  assert.deepEqual(projected.standaloneComponents, [
    { id: '2:1', name: 'Logo', page: 'Library', key: 'logo-key' },
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') < MAX_COMPONENT_INVENTORY_SERIALIZED_BYTES);
});

test('all-page inventory loads pages explicitly and reports its scope', async () => {
  const figma = fixture();
  let loads = 0;
  figma.loadAllPagesAsync = async () => { loads++; };
  const result = projectComponentInventory(
    await evaluateWithFigma(componentInventoryCode(true), figma),
  );
  assert.equal(loads, 1);
  assert.equal(result.scope, 'ALL_PAGES');
});

test('Plugin-side traversal excess fails truthfully with a recovery action', async () => {
  const figma = fixture();
  figma.currentPage.children = [
    { type: 'RECTANGLE', id: '3:1', name: 'A' },
    { type: 'RECTANGLE', id: '3:2', name: 'B' },
    { type: 'RECTANGLE', id: '3:3', name: 'C' },
  ];
  const constrained = componentInventoryCode(false)
    .replaceAll('visited > 250000', 'visited > 2');
  await assert.rejects(
    evaluateWithFigma(constrained, figma),
    /visit limit exceeded.*without --all-pages/i,
  );
});

test('Plugin-side collection and axis limits fail instead of truncating', async () => {
  const figma = fixture();
  figma.currentPage.children.push({
    type: 'COMPONENT_SET', id: '4:1', name: 'Second', key: '', children: [],
    defaultVariant: null, variantGroupProperties: {},
  });
  const constrainedSets = componentInventoryCode(false)
    .replace('if (sets.length >= 5000)', 'if (sets.length >= 1)');
  await assert.rejects(evaluateWithFigma(constrainedSets, figma), /component-set limit exceeded/i);

  const axisFixture = fixture();
  axisFixture.currentPage.children[0].variantGroupProperties = {
    State: { values: ['On', 'Off'] },
  };
  const constrainedAxes = componentInventoryCode(false)
    .replace('entries.length > 64', 'entries.length > 0');
  await assert.rejects(evaluateWithFigma(constrainedAxes, axisFixture), /variant-axis limit exceeded/i);
});

test('Plugin and host both reject control and Bidi injection', async () => {
  const figma = fixture();
  figma.currentPage.name = 'Library\u202eexe';
  await assert.rejects(
    evaluateWithFigma(componentInventoryCode(false), figma),
    /page name contains unsupported control or Bidi/i,
  );

  const valid = await evaluateWithFigma(componentInventoryCode(false), fixture());
  valid.componentSets[0].name = 'Control\nspoof';
  assert.throws(
    () => projectComponentInventory(valid),
    /invalid or oversized component facts/i,
  );
});

test('host projection rejects duplicate identities and malformed nested axes', async () => {
  const duplicate = await evaluateWithFigma(componentInventoryCode(false), fixture());
  duplicate.standaloneComponents[0].id = duplicate.componentSets[0].variants[0].id;
  assert.throws(() => projectComponentInventory(duplicate), /duplicate component identities/i);

  const malformed = await evaluateWithFigma(componentInventoryCode(false), fixture());
  malformed.componentSets[0].variantAxes.State.extra = true;
  assert.throws(() => projectComponentInventory(malformed), /invalid or oversized component facts/i);
});

test('cache and every inventory consumer use the bounded projection seam', () => {
  const cached = cachedInventoryCode(true, 1_000);
  assert.match(cached, /schemaVersion === 1/);
  assert.match(cached, /allPages === true/);
  assert.throws(() => cachedInventoryCode(true, 600_001), /cache TTL/i);

  const misc = readFileSync(new URL('../engine/src/commands/misc.js', import.meta.url), 'utf8');
  const listStart = misc.indexOf("componentCmd\n  .command('list')");
  const listEnd = misc.indexOf("componentCmd\n  .command('main", listStart);
  assert.ok(listStart >= 0 && listEnd > listStart);
  assert.match(
    misc.slice(listStart, listEnd),
    /executeComponentInventoryPlan\(plan/,
    'component list must delegate to the bounded Command Application',
  );
  assert.doesNotMatch(misc.slice(listStart, listEnd), /checkConnection\(|componentInventoryCode\(/);

  for (const file of [
    'engine/src/commands/map.js',
    'engine/src/commands/render.js',
    'engine/src/application/semantic-render-command.js',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /projectComponentInventory\(/, `${file} must validate the Plugin response`);
  }
});
