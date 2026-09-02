import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkerCode, listPagesCode } from '../src/design-extract.js';

test('walkerCode produces syntactically valid JS', () => {
  const code = walkerCode('123:45');
  // Throws SyntaxError if invalid. Wrap in a function shell because the
  // code is an async IIFE expression.
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('walkerCode embeds page id and options', () => {
  const code = walkerCode('123:45', { maxDepth: 5, textLimit: 40 });
  assert.match(code, /"123:45"/);
  assert.match(code, /MAX_DEPTH = 5/);
  assert.match(code, /TEXT_LIMIT = 40/);
});

test('walkerCode preserves editable native Glass effect parameters', () => {
  const code = walkerCode('123:45');
  for (const field of ['refraction', 'depth', 'dispersion', 'lightIntensity', 'lightAngle']) {
    assert.match(code, new RegExp(`e\\.${field}`), field);
  }
  assert.match(code, /e\.type === 'GLASS'/);
});

test('walkerCode defaults: depth 8, text 80', () => {
  const code = walkerCode('1:1');
  assert.match(code, /MAX_DEPTH = 8/);
  assert.match(code, /TEXT_LIMIT = 80/);
});

test('listPagesCode is valid JS', () => {
  assert.doesNotThrow(() => new Function(`return ${listPagesCode()}`));
});

test('walkerCode loads the page before reading children (dynamic-page mode)', () => {
  const code = walkerCode('1:1');
  assert.match(code, /loadAsync/);
  // loadAsync must appear BEFORE the first children access
  assert.ok(code.indexOf('loadAsync') < code.indexOf('count(page)'));
});

test('walkerCode captures the default-variant reuse handle on a COMPONENT_SET', () => {
  const code = walkerCode('1:1');
  assert.match(code, /defaultVariant/);
  assert.match(code, /o\.id = dv\.id/);
  assert.match(code, /o\.key = dv\.key/);
});

import { buildCensus, assignSemanticNames } from '../src/design-extract.js';

export const FIXTURE_PAGES = [
  {
    id: '1:1', name: 'Buttons', nodeCount: 10,
    frames: [
      { t: 'FRAME', n: 'Row', w: 400, h: 40, lm: 'HORIZONTAL', gap: 8, fills: ['#ffffff'], kids: [
        { t: 'COMPONENT', n: 'Primary', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#1f883d'], r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#ffffff'] },
        ] },
        { t: 'COMPONENT', n: 'Default', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12], fills: ['#f6f8fa'], strokes: ['#d0d7de'], sw: 1, r: 6, kids: [
          { t: 'TEXT', n: 'Button', w: 47, h: 20, txt: { chars: 'Button', font: 'Inter', style: 'Semi Bold', size: 14, lh: 20 }, fills: ['#1f2328'] },
        ] },
      ] },
    ],
  },
];

test('buildCensus counts colors from fills and strokes', () => {
  const census = buildCensus(FIXTURE_PAGES);
  assert.equal(census.colors.get('#ffffff'), 2);   // frame fill + text fill
  assert.equal(census.colors.get('#1f883d'), 1);
  assert.equal(census.colors.get('#d0d7de'), 1);   // stroke
});

test('buildCensus strips opacity suffix from paint strings', () => {
  const census = buildCensus([{ id: 'x', name: 'P', nodeCount: 1, frames: [
    { t: 'FRAME', n: 'F', w: 10, h: 10, fills: ['#000000@50'] },
  ] }]);
  assert.equal(census.colors.get('#000000'), 1);
});

test('buildCensus carries key/id from a COMPONENT_SET walker node', () => {
  const pages = [{ id: '1:1', name: 'P', nodeCount: 1, frames: [
    { t: 'COMPONENT_SET', n: 'Button', vp: { Size: { values: ['S', 'M'] } },
      kidCount: 2, key: 'PLACEHOLDERCOMPONENTKEY', id: '10:5', kids: [{ t: 'COMPONENT', n: 'Size=S' }] },
  ] }];
  const census = buildCensus(pages);
  assert.equal(census.componentSets.length, 1);
  assert.equal(census.componentSets[0].key, 'PLACEHOLDERCOMPONENTKEY');
  assert.equal(census.componentSets[0].id, '10:5');
});

test('buildCensus: setKey/setId carried; standalone components collected; set variants excluded', () => {
  const pages = [{ id: '1:1', name: 'P', nodeCount: 1, frames: [
    { t: 'COMPONENT_SET', n: 'Button', vp: { Size: { values: ['S'] } },
      kidCount: 1, key: 'dvkey', id: '10:5', setKey: 'setkey', setId: '10:4',
      kids: [{ t: 'COMPONENT', n: 'Size=S', key: 'dvkey', id: '10:5' }] },
    { t: 'COMPONENT', n: 'Logo', key: 'logokey', id: '20:1' },
  ] }];
  const census = buildCensus(pages);
  assert.equal(census.componentSets[0].setKey, 'setkey');
  assert.equal(census.componentSets[0].setId, '10:4');
  // The set's sample variant is NOT a standalone; Logo is.
  assert.equal(census.components.length, 1);
  assert.deepEqual(census.components[0], { name: 'Logo', page: 'P', key: 'logokey', id: '20:1' });
});

test('walkerCode captures set identity and standalone component keys', () => {
  const code = walkerCode('1:1');
  assert.match(code, /o\.setId = n\.id/);
  assert.match(code, /o\.setKey = n\.key/);
  assert.match(code, /o\.mainKey = main\.key/);
});

test('assignSemanticNames classifies by lightness and chroma', () => {
  const colors = new Map([
    ['#ffffff', 50],  // near-white → background
    ['#1f2328', 40],  // dark, low sat → text-primary
    ['#0969da', 30],  // chromatic → accent
    ['#d0d7de', 20],  // light gray → border
    ['#59636e', 10],  // mid gray → text-*
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['background'], '#ffffff');
  assert.equal(named['text-primary'], '#1f2328');
  assert.equal(named['accent'], '#0969da');
  assert.ok(Object.values(named).includes('#d0d7de'));
  assert.equal(Object.keys(named).length, 5);
});

test('assignSemanticNames suffixes duplicates with -alt, -3, -4', () => {
  const colors = new Map([
    ['#0969da', 30], ['#d1242f', 20], ['#8250df', 10],
  ]);
  const named = assignSemanticNames(colors);
  assert.equal(named['accent'], '#0969da');
  assert.equal(named['accent-alt'], '#d1242f');
  assert.equal(named['accent-3'], '#8250df');
});

import { buildTypeScale, inferBaseUnit, nameRadii } from '../src/design-extract.js';

test('buildTypeScale names styles by size rank (display > h1 > … > body > caption)', () => {
  const typo = new Map([
    ['Inter|Bold|40|48|', 5],
    ['Inter|Semi Bold|24|32|', 10],
    ['Inter|Regular|14|20|', 100],
    ['Inter|Regular|12|16|', 30],
  ]);
  const scale = buildTypeScale(typo);
  const names = Object.keys(scale);
  assert.ok(names.includes('display'));
  assert.ok(names.includes('body'));
  assert.ok(names.includes('caption'));
  assert.equal(scale['body'].fontSize, 14);
  assert.equal(scale['body'].fontFamily, 'Inter');
  assert.equal(scale['body'].fontWeight, 400);   // 'Regular' → 400
  assert.equal(scale['display'].fontWeight, 700); // 'Bold' → 700
});

test('inferBaseUnit picks the dominant grid from spacing counts', () => {
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [24, 20], [4, 10]])), 4);
  assert.equal(inferBaseUnit(new Map([[8, 50], [16, 40], [32, 10]])), 8);
  assert.equal(inferBaseUnit(new Map()), 8); // sensible default
});

test('nameRadii produces sm/md/lg names sorted by value', () => {
  const named = nameRadii(new Map([[2, 50], [6, 80], [12, 20], [9999, 5]]));
  assert.equal(named['radius-sm'], 2);
  assert.equal(named['radius-md'], 6);
  assert.equal(named['radius-lg'], 12);
  assert.equal(named['radius-full'], 9999);
});

import { formatTree, dedupSiblings, variantMatrixTable } from '../src/design-extract.js';

test('formatTree emits the plugin tree notation', () => {
  const node = {
    t: 'FRAME', n: 'Button', w: 71, h: 32, lm: 'HORIZONTAL', gap: 8, pad: [6, 12, 6, 12],
    kids: [{ t: 'TEXT', n: 'Label', w: 47, h: 20, txt: { chars: 'Button' } }],
  };
  const lines = formatTree(node, 0);
  assert.match(lines[0], /\*\*Button\*\* · `FRAME` · 71×32 · horizontal row, gap 8px, padding 6\/12\/6\/12px · 1 children/);
  assert.match(lines[1], /^ {2}- \*\*Label\*\* · `TEXT` · 47×20 · “Button”/);
});

test('formatTree shows explicit omission counts (never silent)', () => {
  const node = { t: 'FRAME', n: 'Deep', w: 10, h: 10, more: 7 };
  const lines = formatTree(node, 0);
  assert.match(lines.join('\n'), /…and 7 more/);
});

test('dedupSiblings collapses identical siblings to one entry with ×N', () => {
  const btn = (name) => ({ t: 'INSTANCE', n: name, w: 71, h: 32, mc: 'Button' });
  const kids = [btn('Button'), btn('Button'), btn('Button'), btn('Other')];
  const deduped = dedupSiblings(kids);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].repeat, 3);
  assert.equal(deduped[1].n, 'Other');
});

test('variantMatrixTable renders a property/values table', () => {
  const md = variantMatrixTable({ trigger: { values: ['icon-button', 'button'] }, open: { values: ['true', 'false'] } });
  assert.match(md, /\| trigger \| icon-button, button \|/);
  assert.match(md, /\| open \| true, false \|/);
});

import { generateDesignMd, ALL_SECTIONS } from '../src/design-extract.js';
import { parseDesignMd, parseDesignMdText, variableImportCode } from '../src/design-md.js';
import { createWorkspaceIO, DEFAULT_WORKSPACE_LIMITS } from '../src/lib/workspace-io.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const EXTRACTION = {
  fileName: 'Test File',
  date: '2026-06-12',
  pages: FIXTURE_PAGES,
};

test('generateDesignMd emits all 12 sections by default', () => {
  const md = generateDesignMd(EXTRACTION);
  for (const [i, title] of [
    [1, 'Identity'], [2, 'Structure'], [3, 'Color'], [4, 'Variables'],
    [5, 'Typography'], [6, 'Spacing & Layout'], [7, 'Depth & Motion'],
    [8, 'Components'], [9, 'States'], [10, 'Rules'],
    [11, 'Extending this system'], [12, 'Machine-readable tokens'],
  ]) {
    assert.match(md, new RegExp(`^## ${i}\\. ${title.replace(/[&]/g, '\\$&')}`, 'm'), `missing section ${i} ${title}`);
  }
});

test('normal-sized DESIGN.md output remains byte-compatible', () => {
  const md = generateDesignMd(EXTRACTION);
  assert.equal(Buffer.byteLength(md, 'utf8'), 3399);
  assert.equal(
    createHash('sha256').update(md).digest('hex'),
    '910a7b95de985b314794c8d29439ee6c4a1f2e451c1ae3bda407b7e12fd3c9e1',
  );
});

test('Variables section degrades gracefully when the file has no variables', () => {
  const md = generateDesignMd(EXTRACTION); // fixture has no `variables`
  assert.match(md, /^## 4\. Variables/m);
  assert.match(md, /no local variables found/);
});

test('generateDesignMd respects --sections selection and renumbers', () => {
  const md = generateDesignMd(EXTRACTION, { sections: ['color', 'tokens'] });
  assert.match(md, /^## 1\. Color/m);
  assert.match(md, /^## 2\. Machine-readable tokens/m);
  assert.doesNotMatch(md, /## \d+\. Structure/);
});

test('roundtrip: parseDesignMd reads generateDesignMd output', () => {
  const md = generateDesignMd(EXTRACTION);
  const dir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file, { workspaceIO: createWorkspaceIO({ root: dir }) });
  assert.equal(parsed.meta.source, 'Test File');
  // every census color appears in the parsed token map
  const parsedColors = Object.values(parsed.tokens.color);
  assert.ok(parsedColors.includes('#ffffff'));
  assert.ok(parsedColors.includes('#1f883d'));
  // typography roundtrips with family + size
  const tNames = Object.keys(parsed.tokens.typography);
  assert.ok(tNames.length >= 1);
});

test('structure section contains untruncated page trees', () => {
  const md = generateDesignMd(EXTRACTION);
  assert.match(md, /### Page: Buttons/);
  assert.match(md, /\*\*Primary\*\* · `COMPONENT` · 71×32/);
});

import { estimateStructureTokens } from '../src/design-extract.js';

test('estimateStructureTokens returns a positive token estimate', () => {
  const tokens = estimateStructureTokens(FIXTURE_PAGES);
  assert.ok(tokens > 10, `expected >10, got ${tokens}`);
  assert.ok(tokens < 1000, `fixture is small, got ${tokens}`);
});

test('estimateStructureTokens skips errored pages and handles empty input', () => {
  assert.equal(estimateStructureTokens([]), 0);
  assert.equal(estimateStructureTokens([{ id: 'x', name: 'E', error: 'boom' }]), 0);
});

import { reuseHandleLine } from '../src/design-extract.js';

test('reuseHandleLine: key + id', () => {
  assert.equal(reuseHandleLine({ key: 'abc', id: '1:2' }),
    'Reuse: import existing — key `abc` · node `1:2`');
});
test('reuseHandleLine: id only', () => {
  assert.equal(reuseHandleLine({ id: '1:2' }), 'Reuse: import existing — node `1:2`');
});
test('reuseHandleLine: neither → null', () => {
  assert.equal(reuseHandleLine({}), null);
  assert.equal(reuseHandleLine(), null);
});

test('generateDesignMd components section emits the Reuse line', () => {
  const pages = [{ id: '1:1', name: 'P', nodeCount: 1, frames: [
    { t: 'COMPONENT_SET', n: 'Button', vp: { Size: { values: ['S', 'M'] } },
      kidCount: 2, key: 'PLACEHOLDERCOMPONENTKEY', id: '10:5', kids: [{ t: 'COMPONENT', n: 'Size=S' }] },
  ] }];
  const md = generateDesignMd({ fileName: 'F', date: '2026-06-16', pages }, { sections: ['components'] });
  assert.match(md, /Reuse: import existing — key `PLACEHOLDERCOMPONENTKEY` · node `10:5`/);
});

// ============ Variables capture ============

import {
  variablesCode, variableCollectionsCode, variableChunkCode, resolveAliases,
  exactVariableCatalog, exactVariableChunk, stableVariableCatalog,
  formatVarValue, buildVariableTokens,
  buildVariableSnapshotV2, mdCell,
} from '../src/design-extract.js';

const FIXTURE_VARS = [
  {
    id: 'VC:1', name: 'Acme Primitives',
    modes: [{ id: 'm1', name: 'Light' }, { id: 'm2', name: 'Dark' }],
    variables: [
      { id: 'V:1', name: 'fgColor-default', type: 'COLOR', values: { Light: '#1f2328', Dark: '#e6edf3' } },
      { id: 'V:2', name: 'button-primary-bgColor-rest', type: 'COLOR', values: { Light: '#1f883d', Dark: '#238636' } },
      { id: 'V:3', name: 'control-medium-size', type: 'FLOAT', values: { Light: 32, Dark: 32 } },
      // alias to another variable, captured as an id by the walker
      { id: 'V:4', name: 'button-default-fgColor', type: 'COLOR', values: { Light: { alias: 'V:1' }, Dark: { alias: 'V:1' } } },
    ],
  },
];

test('variablesCode is valid JS and uses the dynamic-page variable APIs', () => {
  const code = variablesCode();
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /getLocalVariableCollectionsAsync/);
  assert.match(code, /getVariableByIdAsync/);
  assert.match(code, /VARIABLE_ALIAS/);
});

test('variablesCode resolves alias names in-Figma (handles library/remote refs)', () => {
  const code = variablesCode();
  // Alias targets are looked up to their name via a cache so even imported
  // library variable ids resolve to a readable name, not a raw VariableID.
  assert.match(code, /nameCache/);
  assert.match(code, /aliasName/);
  assert.match(code, /alias: await aliasName\(raw\.id\)/);
});

test('variableCollectionsCode lists collections without reading values', () => {
  const code = variableCollectionsCode();
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /getLocalVariableCollectionsAsync/);
  assert.match(code, /variableIds/);
  // it must NOT pull every value (that's the chunked path's job)
  assert.doesNotMatch(code, /valuesByMode/);
});

test('variableChunkCode embeds the id slice + modes and is valid JS', () => {
  const code = variableChunkCode(['V:1', 'V:2'], [{ id: 'm1', name: 'Light' }]);
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /"V:1"/);
  assert.match(code, /"V:2"/);
  assert.match(code, /"Light"/);
  // shares the same alias-resolution helper as the one-shot path
  assert.match(code, /alias: await aliasName\(raw\.id\)/);
  assert.match(code, /COMPOSE_COLOR/);
});

test('chunk capture requires the exact unique requested Collection membership', () => {
  const collection = {
    id: 'C:1', key: 'collection-key', name: 'Theme', defaultModeId: 'M:1',
    hiddenFromPublishing: false, modes: [{ id: 'M:1', name: 'Mode' }],
    variableIds: ['V:1', 'V:2'],
  };
  const exact = [
    { id: 'V:2', key: 'key-2', name: 'two', type: 'FLOAT', variableCollectionId: 'C:1',
      description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
      values: { Mode: 2 }, exactValues: { 'M:1': 2 } },
    { id: 'V:1', key: 'key-1', name: 'one', type: 'FLOAT', variableCollectionId: 'C:1',
      description: '', hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
      values: { Mode: 1 }, exactValues: { 'M:1': 1 } },
  ];
  assert.equal(exactVariableChunk(['V:1', 'V:2'], collection, exact).variables, exact);
  for (const captured of [
    [{ id: 'V:1', variableCollectionId: 'C:1' }, { id: 'V:1', variableCollectionId: 'C:1' }],
    [{ id: 'V:1', variableCollectionId: 'C:1' }, { id: 'V:3', variableCollectionId: 'C:1' }],
    [{ id: 'V:1', variableCollectionId: 'C:1' }, { id: 'V:2', variableCollectionId: 'C:2' }],
    [{ id: 'V:1', variableCollectionId: 'C:1' }],
  ]) assert.equal(exactVariableChunk(['V:1', 'V:2'], collection, captured), null);
});

test('Variable catalog count bounds fail before any value chunk can be accepted', () => {
  const row = (index, variableIds = []) => ({
    id: `C:${index}`, key: `key-${index}`, name: `Collection ${index}`,
    defaultModeId: `M:${index}`, hiddenFromPublishing: false,
    modes: [{ id: `M:${index}`, name: 'Mode' }], variableIds,
  });
  assert.throws(() => exactVariableCatalog(
    Array.from({ length: 1_001 }, (_value, index) => row(index)),
  ), /at most 1000 Collections/);
  assert.throws(() => exactVariableCatalog([
    row(1, Array.from({ length: 10_001 }, (_value, index) => `V:${index}`)),
  ]), /at most 10000 Variables/);
  const wrongBoolean = row(1);
  wrongBoolean.hiddenFromPublishing = 'false';
  assert.throws(() => exactVariableCatalog([wrongBoolean]),
    (error) => error.code === 'VARIABLE_CAPTURE_LIMIT');
  const wrongDefault = row(1);
  wrongDefault.defaultModeId = 'M:missing';
  assert.throws(() => exactVariableCatalog([wrongDefault]),
    (error) => error.code === 'VARIABLE_CAPTURE_LIMIT');
});

test('Variable chunks reject open and oversized facts before aggregation', () => {
  const collection = {
    id: 'C:1', key: 'collection-key', name: 'Theme', defaultModeId: 'M:1',
    hiddenFromPublishing: false, modes: [{ id: 'M:1', name: 'Mode' }],
    variableIds: ['V:1'],
  };
  const variable = {
    id: 'V:1', key: 'variable-key', name: 'one', type: 'STRING',
    variableCollectionId: 'C:1', description: '', hiddenFromPublishing: false,
    scopes: ['ALL_SCOPES'], codeSyntax: {}, values: { Mode: 'safe' },
    exactValues: { 'M:1': 'safe' },
  };
  const open = { ...variable, surprise: true };
  assert.throws(() => exactVariableChunk(['V:1'], collection, [open]),
    (error) => error.code === 'VARIABLE_CAPTURE_LIMIT' && /not closed/.test(error.message));
  const oversized = structuredClone(variable);
  oversized.values.Mode = 'x'.repeat(16_385);
  oversized.exactValues['M:1'] = oversized.values.Mode;
  assert.throws(() => exactVariableChunk(['V:1'], collection, [oversized]),
    (error) => error.code === 'VARIABLE_CAPTURE_LIMIT');
  for (const mutate of [
    (value) => { value.description = 123; },
    (value) => { value.hiddenFromPublishing = 'false'; },
    (value) => { value.scopes = 'ALL_SCOPES'; },
    (value) => { value.codeSyntax = []; },
    (value) => { value.exactValues = null; },
  ]) {
    const malformed = structuredClone(variable);
    mutate(malformed);
    assert.throws(() => exactVariableChunk(['V:1'], collection, [malformed]),
      (error) => error.code === 'VARIABLE_CAPTURE_LIMIT');
  }
});

test('chunk capture requires stable membership, modes and declared default afterward', () => {
  const before = [{
    id: 'C:1', key: 'key', name: 'Theme', defaultModeId: 'M:1',
    hiddenFromPublishing: false, modes: [{ id: 'M:1', name: 'Light' }],
    variableIds: ['V:1'],
  }];
  assert.equal(stableVariableCatalog(before, structuredClone(before)), true);
  for (const mutate of [
    (value) => { value[0].variableIds.push('V:2'); },
    (value) => { value[0].modes[0].name = 'Changed'; },
    (value) => { value[0].defaultModeId = 'M:2'; },
    (value) => { value.push({ ...value[0], id: 'C:2' }); },
  ]) {
    const after = structuredClone(before);
    mutate(after);
    assert.equal(stableVariableCatalog(before, after), false);
  }
});

test('resolveAliases swaps alias ids for the referenced variable name', () => {
  const resolved = resolveAliases(FIXTURE_VARS);
  const aliasVar = resolved[0].variables.find(v => v.name === 'button-default-fgColor');
  assert.deepEqual(aliasVar.values.Light, { alias: 'fgColor-default' });
  assert.deepEqual(resolved[0].modes, ['Light', 'Dark']);
});

test('resolveAliases leaves unknown alias ids untouched (cross-library refs)', () => {
  const resolved = resolveAliases([{ name: 'C', modes: [{ id: 'm', name: 'M' }], variables: [
    { id: 'V:9', name: 'x', type: 'COLOR', values: { M: { alias: 'EXTERNAL:42' } } },
  ] }]);
  assert.deepEqual(resolved[0].variables[0].values.M, { alias: 'EXTERNAL:42' });
});

test('formatVarValue renders hex, alias, number and string cells', () => {
  assert.equal(formatVarValue('#1f883d'), '`#1f883d`');
  assert.equal(formatVarValue({ alias: 'fgColor-default' }), '→ var:fgColor-default');
  assert.equal(formatVarValue(32), '32');
  assert.equal(formatVarValue('auto'), '"auto"');
  assert.equal(formatVarValue(undefined), '—');
});

test('buildVariableTokens keys by collection name with modes + variable map', () => {
  const tokens = buildVariableTokens(resolveAliases(FIXTURE_VARS));
  assert.deepEqual(tokens['Acme Primitives'].modes, ['Light', 'Dark']);
  assert.equal(tokens['Acme Primitives'].variables['button-primary-bgColor-rest'].values.Light, '#1f883d');
  assert.equal(tokens['Acme Primitives'].variables['button-primary-bgColor-rest'].type, 'COLOR');
});

test('Variable Snapshot v2 preserves duplicate names, exact modes, metadata and all six types', () => {
  const collections = [
    {
      id: 'C:1', key: 'collection-key-1', name: 'Theme', defaultModeId: 'M:dark',
      hiddenFromPublishing: true, expectedVariableCount: 7, captureComplete: true,
      modes: [
        { id: 'M:light', name: 'Same' },
        { id: 'M:dark', name: 'Same' },
      ],
      variables: [
        { id: 'V:color', key: 'variable-key-color', name: 'duplicate', type: 'COLOR',
          description: 'Color', hiddenFromPublishing: true, scopes: ['ALL_FILLS'],
          codeSyntax: { WEB: '--color' }, exactValues: { 'M:light': { r: 1, g: 0, b: 0, a: 1 } } },
        { id: 'V:float', name: 'duplicate', type: 'FLOAT', exactValues: { 'M:light': 8 } },
        { id: 'V:string', name: 'string', type: 'STRING', exactValues: { 'M:light': 'Inter' } },
        { id: 'V:boolean', name: 'boolean', type: 'BOOLEAN', exactValues: { 'M:light': false } },
        { id: 'V:easing', name: 'easing', type: 'EASING', exactValues: {
          'M:light': { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: {
            x1: 0.1, y1: 0.2, x2: 0.3, y2: 1,
          } },
        } },
        { id: 'V:timing', name: 'timing', type: 'TIMING', exactValues: { 'M:light': 200 } },
        { id: 'V:alias', name: 'alias', type: 'COLOR', exactValues: {
          'M:dark': { alias: 'V:target' },
        } },
      ],
    },
    {
      id: 'C:2', name: 'Theme', defaultModeId: 'M:base',
      modes: [{ id: 'M:base', name: 'Base' }], expectedVariableCount: 2,
      captureComplete: true,
      variables: [
        { id: 'V:target', name: 'duplicate', type: 'COLOR', exactValues: {
          'M:base': { r: 0, g: 0, b: 0, a: 1 },
        } },
        { id: 'V:external', name: 'external', type: 'COLOR', exactValues: {
          'M:base': { alias: 'REMOTE:missing' },
        } },
      ],
    },
  ];
  for (const collection of collections) {
    collection.hiddenFromPublishing ??= false;
    for (const variable of collection.variables) {
      variable.description ??= '';
      variable.hiddenFromPublishing ??= false;
      variable.scopes ??= ['ALL_SCOPES'];
      variable.codeSyntax ??= {};
    }
  }
  const snapshot = buildVariableSnapshotV2(collections);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.kind, 'figma-variable-snapshot');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.collections.length, 2);
  assert.deepEqual(snapshot.collections.map((collection) => collection.name), ['Theme', 'Theme']);
  assert.equal(snapshot.collections[0].defaultMode, 'collection:1/mode:2');
  assert.deepEqual(snapshot.collections[0].modes.map((mode) => mode.name), ['Same', 'Same']);
  assert.deepEqual(snapshot.collections[0].variables.map((variable) => variable.type),
    ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN', 'EASING', 'TIMING', 'COLOR']);
  assert.deepEqual(snapshot.collections[0].variables.slice(0, 2).map((variable) => variable.name),
    ['duplicate', 'duplicate']);
  assert.deepEqual(snapshot.collections[0].variables[0], {
    handle: 'collection:1/variable:1', name: 'duplicate', type: 'COLOR',
    sourceKey: 'variable-key-color', description: 'Color', hiddenFromPublishing: true,
    scopes: ['ALL_FILLS'], codeSyntax: { WEB: '--color' },
    values: { 'collection:1/mode:1': { r: 1, g: 0, b: 0, a: 1 } },
  });
  assert.deepEqual(snapshot.collections[0].variables[6].values['collection:1/mode:2'], {
    $alias: {
      status: 'local', collection: 'collection:2', variable: 'collection:2/variable:1',
    },
  });
  assert.deepEqual(snapshot.collections[1].variables[1].values['collection:2/mode:1'], {
    $alias: { status: 'unresolved', sourceId: 'REMOTE:missing' },
  });
});

test('Variable Snapshot v2 projects native composed color expressions without flattening', () => {
  const snapshot = buildVariableSnapshotV2([{
    id: 'C:1', name: 'Theme', hiddenFromPublishing: false,
    defaultModeId: 'M:1', expectedVariableCount: 2, captureComplete: true,
    modes: [{ id: 'M:1', name: 'Mode 1' }],
    variables: [
      {
        id: 'V:base', name: 'color/palette/sand', type: 'COLOR', description: '',
        hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
        exactValues: { 'M:1': { r: 1, g: 0.8, b: 0.4 } },
      },
      {
        id: 'V:surface', name: 'color/role/surface', type: 'COLOR', description: '',
        hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
        exactValues: { 'M:1': {
          type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
          expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'V:base' }, 42],
        } },
      },
    ],
  }]);
  assert.deepEqual(snapshot.collections[0].variables[1].values['collection:1/mode:1'], {
    $alias: {
      status: 'local', collection: 'collection:1', variable: 'collection:1/variable:1',
      opacity: 42,
    },
  });
});

test('Variable Snapshot v2 marks a partial chunk capture incomplete', () => {
  const snapshot = buildVariableSnapshotV2([{
    id: 'C:1', name: 'Partial', defaultModeId: 'M:1',
    modes: [{ id: 'M:1', name: 'Mode' }], expectedVariableCount: 2,
    captureComplete: true,
    variables: [{ id: 'V:1', name: 'only', type: 'FLOAT', exactValues: { 'M:1': 1 } }],
  }]);
  assert.equal(snapshot.complete, false);
});

test('Variable Snapshot v2 refuses colliding native identities before handle projection', () => {
  const base = {
    id: 'C:1', name: 'Theme', defaultModeId: 'M:1', expectedVariableCount: 1,
    captureComplete: true, modes: [{ id: 'M:1', name: 'Mode' }],
    variables: [{ id: 'V:1', name: 'token', type: 'FLOAT', exactValues: { 'M:1': 8 } }],
  };
  assert.throws(() => buildVariableSnapshotV2([base, { ...structuredClone(base) }]),
    /Collection source ids must be unique/);
  const duplicateMode = structuredClone(base);
  duplicateMode.modes.push({ id: 'M:1', name: 'Duplicate' });
  assert.throws(() => buildVariableSnapshotV2([duplicateMode]), /mode source ids must be unique/);
  const duplicateVariable = structuredClone(base);
  duplicateVariable.variables.push({ ...duplicateVariable.variables[0] });
  duplicateVariable.expectedVariableCount = 2;
  assert.throws(() => buildVariableSnapshotV2([duplicateVariable]),
    /Variable source ids must be unique/);
});

test('Variable Snapshot v2 never calls missing exact capture evidence complete', () => {
  const complete = {
    id: 'C:1', name: 'Theme', defaultModeId: 'M:1', expectedVariableCount: 1,
    captureComplete: true, modes: [{ id: 'M:1', name: 'Mode' }],
    variables: [{ id: 'V:1', name: 'token', type: 'FLOAT', exactValues: { 'M:1': 8 } }],
  };
  for (const mutate of [
    (value) => { delete value.expectedVariableCount; },
    (value) => { delete value.captureComplete; },
    (value) => { delete value.defaultModeId; },
    (value) => { delete value.variables[0].exactValues; value.variables[0].values = { Mode: 8 }; },
    (value) => { delete value.variables[0].description; },
    (value) => { delete value.variables[0].hiddenFromPublishing; },
    (value) => { delete value.variables[0].scopes; },
    (value) => { delete value.variables[0].codeSyntax; },
  ]) {
    const value = structuredClone(complete);
    mutate(value);
    const snapshot = buildVariableSnapshotV2([value]);
    assert.equal(snapshot.complete, false);
  }
});

test('Variable Snapshot v2 rejects foreign mode values and open Alias capture facts', () => {
  const complete = {
    id: 'C:1', name: 'Theme', hiddenFromPublishing: false,
    defaultModeId: 'M:1', expectedVariableCount: 1, captureComplete: true,
    modes: [{ id: 'M:1', name: 'Mode' }],
    variables: [{
      id: 'V:1', name: 'token', type: 'FLOAT', description: '',
      hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
      exactValues: { 'M:1': 8 },
    }],
  };
  const foreignMode = structuredClone(complete);
  foreignMode.variables[0].exactValues = { 'M:foreign': 8 };
  assert.throws(() => buildVariableSnapshotV2([foreignMode]), /foreign or missing mode/);

  const openAlias = structuredClone(complete);
  openAlias.variables[0].exactValues = { 'M:1': { alias: 'V:2', extra: true } };
  assert.throws(() => buildVariableSnapshotV2([openAlias]), /not a closed source fact/);
});

test('oversized duplicate Variable projections degrade to complete importable v2', () => {
  const longValue = 'x'.repeat(16_384);
  const variables = Array.from({ length: 170 }, (_value, index) => ({
    id: `V:${index}`, name: `string-${index}`, type: 'STRING', description: '',
    hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { Mode: longValue }, exactValues: { 'M:1': longValue },
  }));
  const extraction = { ...EXTRACTION, variables: [{
    id: 'C:1', name: 'Large', hiddenFromPublishing: false,
    defaultModeId: 'M:1', modes: [{ id: 'M:1', name: 'Mode' }],
    variables, expectedVariableCount: variables.length, captureComplete: true,
  }] };
  const md = generateDesignMd(extraction, {
    sections: ['variables', 'tokens'],
    // A caller may narrow the authority for testing or a stricter host, but
    // may never raise it to retain the unsafe duplicate output.
    workspaceLimits: { textBytes: DEFAULT_WORKSPACE_LIMITS.textBytes * 2 },
  });
  assert.ok(Buffer.byteLength(md, 'utf8') <= DEFAULT_WORKSPACE_LIMITS.textBytes);
  assert.match(md, /Safe size degradation/);
  assert.match(md, /Legacy v1 token data is omitted/);
  assert.match(md, /\[16386 chars\]/, 'formatted display value is explicitly shortened');

  const parsed = parseDesignMdText(md);
  assert.equal(parsed.tokens.variables, undefined);
  assert.equal(parsed.tokens.meta.exportCompatibility.legacyVariables, 'omitted-size-limit');
  assert.equal(parsed.tokens.variableSnapshot.complete, true);
  assert.equal(
    parsed.tokens.variableSnapshot.collections[0].variables[169]
      .values['collection:1/mode:1'],
    longValue,
  );
});

test('DESIGN.md uses normal bytes at the limit and safe v2 one byte over it', () => {
  const longValue = 'y'.repeat(2_048);
  const variables = Array.from({ length: 3 }, (_value, index) => ({
    id: `V:${index}`, name: `copy-${index}`, type: 'STRING', description: '',
    hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
    values: { Mode: longValue }, exactValues: { 'M:1': longValue },
  }));
  const extraction = { ...EXTRACTION, variables: [{
    id: 'C:1', name: 'Boundary', hiddenFromPublishing: false,
    defaultModeId: 'M:1', modes: [{ id: 'M:1', name: 'Mode' }],
    variables, expectedVariableCount: variables.length, captureComplete: true,
  }] };
  const options = { sections: ['variables', 'tokens'] };
  const normal = generateDesignMd(extraction, options);
  const normalBytes = Buffer.byteLength(normal, 'utf8');
  const atLimit = generateDesignMd(extraction, {
    ...options,
    workspaceLimits: { textBytes: normalBytes },
  });
  assert.equal(atLimit, normal);

  const oneByteOver = generateDesignMd(extraction, {
    ...options,
    workspaceLimits: { textBytes: normalBytes - 1 },
  });
  assert.match(oneByteOver, /Safe size degradation/);
  assert.ok(Buffer.byteLength(oneByteOver, 'utf8') <= normalBytes - 1);
  const parsed = parseDesignMdText(oneByteOver, {
    limits: { ...DEFAULT_WORKSPACE_LIMITS, textBytes: normalBytes - 1 },
  });
  assert.equal(parsed.tokens.variableSnapshot.collections[0].variables[2]
    .values['collection:1/mode:1'], longValue);
});

test('generated DESIGN.md carries v2 identity beside the bounded legacy reader', () => {
  const md = generateDesignMd({ ...EXTRACTION, variables: [{
    id: 'C:1', name: 'Theme', defaultModeId: 'M:1', expectedVariableCount: 1,
    captureComplete: true,
    modes: [{ id: 'M:1', name: 'Mode' }],
    variables: [{ id: 'V:1', name: 'token', type: 'FLOAT', exactValues: { 'M:1': 8 }, values: { Mode: 8 } }],
  }] });
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-v2-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file, { workspaceIO: createWorkspaceIO({ root: dir }) });
  assert.equal(parsed.tokens.variableSnapshot.schemaVersion, 2);
  assert.equal(parsed.tokens.variableSnapshot.collections[0].variables[0]
    .values['collection:1/mode:1'], 8);
  assert.equal(parsed.tokens.variables.Theme.variables.token.values.Mode, 8);
});

test('generateDesignMd emits the Variables section with a per-collection table', () => {
  const md = generateDesignMd({ ...EXTRACTION, variables: FIXTURE_VARS });
  assert.match(md, /### Collection: Acme Primitives {2}· {2}4 variables {2}· {2}modes: Light, Dark/);
  assert.match(md, /\| button-primary-bgColor-rest \| COLOR \| `#1f883d` \| `#238636` \|/);
  // alias resolved to a name, not an id
  assert.match(md, /\| button-default-fgColor \| COLOR \| → var:fgColor-default \| → var:fgColor-default \|/);
});

// These guard generality across ARBITRARY design systems, not just one vendor:
// names/modes/values can contain markdown-hostile characters, and collection
// names are not unique in Figma.

test('mdCell escapes pipes and flattens newlines', () => {
  assert.equal(mdCell('a|b'), 'a\\|b');
  assert.equal(mdCell('line1\nline2'), 'line1 line2');
  assert.equal(mdCell('plain'), 'plain');
});

test('generateDesignMd keeps table columns intact when names/values contain pipes', () => {
  const vars = [{
    id: 'C', name: 'Weird System',
    modes: [{ id: 'm1', name: 'Light | HC' }, { id: 'm2', name: 'Dark' }],
    variables: [
      { id: 'V1', name: 'spacing|inset', type: 'STRING', values: { 'Light | HC': 'a|b', Dark: 'x' } },
    ],
  }];
  const md = generateDesignMd({ ...EXTRACTION, variables: vars });
  const row = md.split('\n').find(l => l.startsWith('| spacing'));
  // a literal pipe in content must be escaped so it isn't read as a column break
  assert.ok(row.includes('spacing\\|inset'), row);
  assert.ok(row.includes('"a\\|b"'), row);
  // header carries the escaped mode name
  assert.match(md, /Light \\\| HC/);
  // every body row has the same column count as the header (5 cells → 6 bars)
  const headerBars = (md.split('\n').find(l => l.startsWith('| Variable')).match(/(?<!\\)\|/g) || []).length;
  const rowBars = (row.match(/(?<!\\)\|/g) || []).length;
  assert.equal(rowBars, headerBars);
});

test('buildVariableTokens suffixes duplicate collection names instead of overwriting', () => {
  const dup = [
    { name: 'Theme', modes: ['default'], variables: [{ name: 'a', type: 'COLOR', values: { default: '#111111' } }] },
    { name: 'Theme', modes: ['default'], variables: [{ name: 'b', type: 'COLOR', values: { default: '#222222' } }] },
  ];
  const tokens = buildVariableTokens(dup);
  assert.deepEqual(Object.keys(tokens), ['Theme', 'Theme (2)']);
  assert.ok(tokens['Theme'].variables.a);
  assert.ok(tokens['Theme (2)'].variables.b);
});

test('captures all four Figma variable resolved types (not just colors)', () => {
  const vars = [{
    id: 'C', name: 'Mixed', modes: [{ id: 'm', name: 'default' }],
    variables: [
      { id: '1', name: 'col', type: 'COLOR', values: { default: '#abcdef' } },
      { id: '2', name: 'num', type: 'FLOAT', values: { default: 8 } },
      { id: '3', name: 'str', type: 'STRING', values: { default: 'Inter' } },
      { id: '4', name: 'flag', type: 'BOOLEAN', values: { default: true } },
    ],
  }];
  const md = generateDesignMd({ ...EXTRACTION, variables: vars });
  assert.match(md, /\| col \| COLOR \| `#abcdef` \|/);
  assert.match(md, /\| num \| FLOAT \| 8 \|/);
  assert.match(md, /\| str \| STRING \| "Inter" \|/);
  assert.match(md, /\| flag \| BOOLEAN \| true \|/);
});

// ============ Variables import (DESIGN.md → real Figma collections) ============

test('variableImportCode is valid JS and embeds the collection data', () => {
  const code = variableImportCode(buildVariableTokens(resolveAliases(FIXTURE_VARS)));
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /createVariableCollection/);
  assert.match(code, /createVariableAlias/);
  assert.match(code, /addMode/);
  assert.match(code, /button-primary-bgColor-rest/);
});

test('legacy DESIGN.md Variable import refuses color Alias opacity before generating Plugin code', () => {
  assert.throws(() => variableImportCode({
    Theme: {
      modes: ['Mode 1'],
      variables: {
        'color/base': { type: 'COLOR', values: { 'Mode 1': '#ffffff' } },
        'color/role': {
          type: 'COLOR', values: { 'Mode 1': { alias: 'color/base', opacity: 42 } },
        },
      },
    },
  }), /Variable Snapshot v2.*Alias opacity/);
});

test('variableImportCode is a two-pass build (aliases resolved after creation)', () => {
  const code = variableImportCode(buildVariableTokens(resolveAliases(FIXTURE_VARS)));
  assert.match(code, /PASS 1/);
  assert.match(code, /PASS 2/);
  // pass 1 explicitly defers alias values
  assert.match(code, /'alias' in val\) continue; \/\/ pass 2/);
  // existing composed (Alias opacity) values are preserved in both passes, never overwritten
  assert.equal((code.match(/__isComposedValue\(v\.valuesByMode && v\.valuesByMode\[modeId\]\)\) \{ preserved\+\+; continue; \}/g) || []).length, 2);
  assert.match(code, /unresolved, preserved, scopeQuestions/);
  // colors parse 8-digit hex (alpha) too
  assert.match(code, /\(\[a-f.*\]\{2\}\)\?/);
  assert.match(code, /__scopeTokenVariable\(v, vName, type\)/);
  assert.match(code, /__variableScopeQuestion\(vName, type, collName\)/);
  assert.match(code, /scopeQuestions/);
});

test('variableImportCode handles a full extract→import roundtrip shape', () => {
  // The data the importer receives is exactly what parseDesignMd returns.
  const md = generateDesignMd({ ...EXTRACTION, variables: FIXTURE_VARS });
  const dir = mkdtempSync(join(tmpdir(), 'vimp-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file, { workspaceIO: createWorkspaceIO({ root: dir }) });
  const code = variableImportCode(parsed.tokens.variables);
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.match(code, /Acme Primitives/);
  assert.match(code, /button-primary-bgColor-rest/);
});

test('Variables roundtrip: parseDesignMd reads the JSON variables block back', () => {
  const md = generateDesignMd({ ...EXTRACTION, variables: FIXTURE_VARS });
  const dir = mkdtempSync(join(tmpdir(), 'extract-vars-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, md);
  const parsed = parseDesignMd(file, { workspaceIO: createWorkspaceIO({ root: dir }) });
  const pp = parsed.tokens.variables['Acme Primitives'];
  assert.deepEqual(pp.modes, ['Light', 'Dark']);
  assert.equal(pp.variables['fgColor-default'].values.Dark, '#e6edf3');
  // existing color/typography parsing still works alongside the new block
  assert.ok(Object.values(parsed.tokens.color).includes('#ffffff'));
});
