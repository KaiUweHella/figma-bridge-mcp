// `export css` output hygiene (IMPROVEMENTS #7). Fixtures are the literal
// broken outputs from the test run — each one must now come out valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssName, mapFontWeight, fontSource, formatCssTokens } from '../src/lib/css-tokens.js';

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

test('fontSource knows the test fonts', () => {
  assert.equal(fontSource('Clash Grotesk'), 'Fontshare');
  assert.match(fontSource('Geist'), /Vercel/);
  assert.equal(fontSource('Inter'), 'Google Fonts');
  assert.equal(fontSource('Obscure Corp Font'), null);
});

test('formatCssTokens: every test failure case produces valid CSS', () => {
  const out = formatCssTokens([
    { name: 'color/on primary', type: 'COLOR', value: '#080713' },
    { name: 'fonts/fontweight/default', type: 'STRING', value: 'regular' },
    { name: 'icon/strokewidth/xs', type: 'FLOAT', value: 1.1699999570846558 },
    { name: 'headline font', type: 'STRING', value: 'Freight' },
  ]);
  assert.match(out, /--color-on-primary: #080713;/);
  assert.match(out, /--fonts-fontweight-default: 400;/);
  assert.match(out, /--icon-strokewidth-xs: 1\.17px;/);
  // font family: grouped, quoted, with a source comment
  assert.match(out, /--font-family-headline-font: "Freight";/);
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
  assert.match(out, /--font-family-subheading: "Clash Grotesk"; \/\* source: Fontshare \*\//);
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
