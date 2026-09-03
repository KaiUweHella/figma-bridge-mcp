// `export css` output hygiene (IMPROVEMENTS #7). Fixtures are the literal
// broken outputs found during acceptance testing — each one must now come out valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDtcgTree,
  cssName,
  mapFontWeight,
  fontSource,
  formatCssTokens,
  projectVariableModes,
} from '../src/lib/css-tokens.js';

test('cssName kebab-cases spaces and slashes, lowercases', () => {
  assert.equal(cssName('color/on primary'), '--color-on-primary');
  assert.equal(cssName('color/surface container high'), '--color-surface-container-high');
  assert.equal(cssName('Headline Font'), '--headline-font');
});

test('mapFontWeight maps the word scale to numbers, passes unknowns through', () => {
  assert.equal(mapFontWeight('regular'), 400);
  assert.equal(mapFontWeight('Semibold'), 600);
  assert.equal(mapFontWeight('Semi Bold'), 600);
  assert.equal(mapFontWeight('black'), 900);
  assert.equal(mapFontWeight('condensed'), 'condensed');
});

test('fontSource knows the acceptance-fixture fonts', () => {
  assert.equal(fontSource('Clash Grotesk'), 'Fontshare');
  assert.match(fontSource('Geist'), /Vercel/);
  assert.equal(fontSource('Inter'), 'Google Fonts');
  assert.equal(fontSource('Obscure Corp Font'), null);
});

test('formatCssTokens: every acceptance failure case produces valid CSS', () => {
  const out = formatCssTokens([
    { name: 'color/on primary', type: 'COLOR', value: '#080713' },
    { name: 'fonts/fontweight/default', type: 'STRING', value: 'regular' },
    { name: 'icon/strokewidth/xs', type: 'FLOAT', value: 1.1699999570846558 },
    { name: 'headline font', type: 'STRING', value: 'Freight' },
  ]);
  assert.match(out, /--color-on-primary: #080713;/);
  assert.match(out, /--fonts-fontweight-default: 400;/);
  assert.match(out, /--icon-strokewidth-xs: 1\.17px;/);
  // Font-family detection may group the rule, but it must preserve the
  // canonical Figma variable name used by native CSS references.
  assert.match(out, /--headline-font: "Freight";/);
  // The comment is a workflow STEP (load the family, never a look-alike or
  // system fallback), not just a label — a prior acceptance run shipped system fonts.
  assert.match(out, /Font families — REQUIRED STEP/);
  assert.match(out, /system-font fallback distorts metrics/);
  // no property name may contain a space
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(--[^:]+):/);
    if (m) assert.doesNotMatch(m[1], /\s/, `space in property name: ${line}`);
  }
});

test('formatCssTokens: known font gets its source, unknown gets a warning', () => {
  const out = formatCssTokens([
    { name: 'font/display', type: 'STRING', value: 'Clash Grotesk' },
    { name: 'font/body', type: 'STRING', value: 'Obscure Corp Font' },
  ]);
  assert.match(out, /"Clash Grotesk"; \/\* source: Fontshare \*\//);
  assert.match(out, /"Obscure Corp Font"; \/\* source: unknown — verify before substituting \*\//);
});

test('formatCssTokens: font-less NAME with a known family VALUE still groups as font', () => {
  const out = formatCssTokens([{ name: 'subheading', type: 'STRING', value: 'Clash Grotesk' }]);
  assert.match(out, /--subheading: "Clash Grotesk"; \/\* source: Fontshare \*\//);
  assert.doesNotMatch(out, /--subheading: Clash Grotesk;/);
});

test('formatCssTokens: unresolved aliases become comments, not NaN', () => {
  const out = formatCssTokens([{ name: 'color/brand', type: 'COLOR', value: null }]);
  assert.match(out, /\/\* --color-brand: unresolved alias/);
  assert.doesNotMatch(out, /NaN/);
});

test('formatCssTokens: floats round to 2 decimals, integers stay clean', () => {
  const out = formatCssTokens([
    { name: 'space/4', type: 'FLOAT', value: 16 },
    { name: 'radius/odd', type: 'FLOAT', value: 12.339999999 },
  ]);
  assert.match(out, /--space-4: 16px;/);
  assert.match(out, /--radius-odd: 12\.34px;/);
});

test('composed color Alias opacity resolves visually and remains explicit in DTCG', () => {
  const projected = projectVariableModes([
    {
      id: 'Variable:base', name: 'color/palette/sand', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': { r: 1, g: 0.8, b: 0.4 } },
    },
    {
      id: 'Variable:surface', name: 'color/role/surface', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'Variable:base' }, 42],
      } },
    },
  ], [{
    id: 'Collection:theme', name: 'Theme', defaultModeId: 'Mode:1',
    modes: [{ modeId: 'Mode:1', name: 'Mode 1' }],
  }]);

  assert.deepEqual(projected[1].valuesByMode['Mode:1'], {
    value: '#ffcc666b', ref: 'color/palette/sand', refId: 'Variable:base', opacity: 42,
  });
  assert.match(formatCssTokens(projected), /--color-role-surface: #ffcc666b;/);
  const dtcg = buildDtcgTree(projected);
  assert.equal(dtcg.color.role.surface.$value, '#ffcc666b');
  assert.deepEqual(
    dtcg.color.role.surface.$extensions['figma-bridge-mcp'].valuesByMode['Mode:1'],
    {
      modeName: 'Mode 1', value: '#ffcc666b',
      alias: 'color/palette/sand', aliasVariableId: 'Variable:base', opacity: 42,
    },
  );
});

test('file-wide projection rounds nested composed opacity to an alpha byte per layer', () => {
  const projected = projectVariableModes([
    {
      id: 'Variable:base', name: 'color/palette/red', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': { r: 1, g: 0, b: 0 } },
    },
    {
      id: 'Variable:mid', name: 'color/role/mid', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'Variable:base' }, 50],
      } },
    },
    {
      id: 'Variable:top', name: 'color/role/top', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'Variable:mid' }, 70],
      } },
    },
    {
      id: 'Variable:plain', name: 'color/role/plain', resolvedType: 'COLOR',
      variableCollectionId: 'Collection:theme',
      valuesByMode: { 'Mode:1': { type: 'VARIABLE_ALIAS', id: 'Variable:mid' } },
    },
  ], [{
    id: 'Collection:theme', name: 'Theme', defaultModeId: 'Mode:1',
    modes: [{ modeId: 'Mode:1', name: 'Mode 1' }],
  }]);
  const byName = new Map(projected.map((variable) => [variable.name, variable.valuesByMode['Mode:1']]));
  assert.deepEqual(byName.get('color/role/mid'), {
    value: '#ff000080', ref: 'color/palette/red', refId: 'Variable:base', opacity: 50,
  });
  /* 0x80/255 × 0.7 × 255 = 89.6 → 0x5a: the intermediate byte is reused, not re-derived. */
  assert.deepEqual(byName.get('color/role/top'), {
    value: '#ff00005a', ref: 'color/role/mid', refId: 'Variable:mid', opacity: 70,
  });
  /* A plain alias inherits the composed visual value but never the authored opacity. */
  assert.deepEqual(byName.get('color/role/plain'), {
    value: '#ff000080', ref: 'color/role/mid', refId: 'Variable:mid',
  });
});
