import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseW3cTokens } from '../src/code-import/w3c-tokens.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'code-import');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');

test('w3c: extracts colors with $value and legacy value, drops group prefix', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.color['brand-primary'], '#0969da');
  assert.equal(tokens.color['brand-secondary'], '#6639ba');
});

test('w3c: resolves {alias} references', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.color['text-default'], '#0969da');
});

test('w3c: dimensions become numbers (px direct, rem ×16)', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.radius['radius-lg'], 12);
  assert.equal(tokens.spacing['spacing-sm'], 8);
});

test('w3c: typography tokens keep the full shape', () => {
  const { tokens } = parseW3cTokens(fixture('tokens-style-dictionary.json'));
  assert.deepEqual(tokens.typography['font-body'], { fontFamily: 'Inter', fontSize: 14, fontWeight: 400, lineHeight: 20 });
  assert.ok(tokens.fonts.includes('Inter'));
});

test('w3c: cyclic aliases throw a clear error', () => {
  const cyclic = JSON.stringify({ a: { $value: '{b}' }, b: { $value: '{a}' } });
  assert.throws(() => parseW3cTokens(cyclic), /cycl|circular/i);
});

test('w3c: invalid JSON throws with context', () => {
  assert.throws(() => parseW3cTokens('not json'), /JSON/);
});

import { parseCss } from '../src/code-import/css.js';

test('css: shadcn bare HSL triples become hex colors', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['background'], '#ffffff');
  assert.match(tokens.color['primary'], /^#[0-9a-f]{6}$/);
});

test('css: hex passthrough and var() reference resolution', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['brand'], '#0969da');
  assert.equal(tokens.color['ref'], '#0969da');
});

test('css: radius-named rem values become px radius tokens', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.radius['radius'], 8);
});

test('css: .dark block values are skipped in v1 (first definition wins)', () => {
  const { tokens } = parseCss(fixture('shadcn-globals.css'));
  assert.equal(tokens.color['background'], '#ffffff'); // not the .dark value
});

test('css: tailwind v4 @theme — color-/radius-/spacing-/font- prefixes', () => {
  const { tokens } = parseCss(fixture('tailwind-v4-theme.css'));
  assert.match(tokens.color['primary'], /^#[0-9a-f]{6}$/);   // oklch converted
  assert.equal(tokens.color['surface'], '#f6f8fa');           // rgb() converted
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.spacing['spacing-gutter'], 24);
  assert.deepEqual(tokens.fonts, ['Inter']);
});

import { parseTailwindConfig } from '../src/code-import/tailwind.js';

test('tailwind: flattens nested color scales, skips non-colors, merges extend', async () => {
  const { tokens } = await parseTailwindConfig(join(FIX, 'tailwind.config.cjs'));
  assert.equal(tokens.color['blue-500'], '#3b82f6');
  assert.equal(tokens.color['white'], '#ffffff');
  assert.equal(tokens.color['brand'], '#0969da');       // from extend
  assert.equal(tokens.color['transparent'], undefined); // skipped
});

test('tailwind: borderRadius/spacing rem→px, fontFamily, fontSize tuples', async () => {
  const { tokens } = await parseTailwindConfig(join(FIX, 'tailwind.config.cjs'));
  assert.equal(tokens.radius['radius-md'], 6);
  assert.equal(tokens.radius['radius-full'], 9999);
  assert.equal(tokens.spacing['spacing-4'], 16);
  assert.deepEqual(tokens.fonts.sort(), ['Inter', 'SF Mono']);
  assert.equal(tokens.typography['text-sm'].fontSize, 14);
  assert.equal(tokens.typography['text-sm'].lineHeight, 20);
  assert.equal(tokens.typography['text-base'].fontSize, 16);
});

test('tailwind: unloadable config throws a helpful error', async () => {
  await assert.rejects(() => parseTailwindConfig('/nonexistent/tailwind.config.js'), /load|find/i);
});

import { parseStorybookIndex, fetchStorybookIndex } from '../src/code-import/storybook.js';

test('storybook: groups stories by component, skips docs entries', () => {
  const { meta } = parseStorybookIndex(fixture('storybook-index.json'));
  assert.equal(meta.components.length, 2);
  const button = meta.components.find(c => c.name === 'Button');
  assert.deepEqual(button.variants, ['Primary', 'Secondary']);
  assert.equal(button.category, 'Components');
});

test('storybook: produces empty tokens (index.json has none)', () => {
  const { tokens } = parseStorybookIndex(fixture('storybook-index.json'));
  assert.equal(Object.keys(tokens.color).length, 0);
});

test('storybook: v6 stories.json shape also parses', () => {
  const v6 = JSON.stringify({ v: 3, stories: {
    'button--primary': { id: 'button--primary', title: 'Button', name: 'Primary', kind: 'Button' },
  } });
  const { meta } = parseStorybookIndex(v6);
  assert.equal(meta.components[0].name, 'Button');
});

import { convert, detectSourceType } from '../src/code-import/index.js';
import { parseDesignMd } from '../src/design-md.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('detect: filenames and content sniffing', () => {
  assert.equal(detectSourceType('tailwind.config.js', ''), 'tailwind');
  assert.equal(detectSourceType('a/b/tailwind.config.ts', ''), 'tailwind');
  assert.equal(detectSourceType('globals.css', ''), 'css');
  assert.equal(detectSourceType('tokens.json', '{"color":{"a":{"$value":"#fff"}}}'), 'tokens');
  assert.equal(detectSourceType('index.json', '{"v":5,"entries":{}}'), 'storybook');
  assert.equal(detectSourceType('http://localhost:6006', ''), 'storybook');
});

test('convert: every converter designMd output roundtrips through parseDesignMd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-import-'));
  for (const [src, type] of [
    [join(FIX, 'tokens-style-dictionary.json'), 'tokens'],
    [join(FIX, 'shadcn-globals.css'), 'css'],
    [join(FIX, 'tailwind.config.cjs'), 'tailwind'],
  ]) {
    const result = await convert(src, { type });
    const f = join(dir, `out-${type}.md`);
    writeFileSync(f, result.designMd);
    const parsed = parseDesignMd(f);
    assert.ok(Object.keys(parsed.tokens.color).length > 0, `${type}: colors survive roundtrip`);
  }
});

test('convert: storybook produces components in designMd and zero tokens', async () => {
  const result = await convert(join(FIX, 'storybook-index.json'), { type: 'storybook' });
  assert.match(result.designMd, /### Page: Button/);
  assert.match(result.designMd, /Primary, Secondary/);
  assert.equal(Object.keys(result.tokens.color).length, 0);
});

test('convert: storybook components survive designMd file roundtrip', async () => {
  const result = await convert(join(FIX, 'storybook-index.json'), { type: 'storybook' });
  const dir = mkdtempSync(join(tmpdir(), 'code-import-storybook-'));
  const f = join(dir, 'storybook-design.md');
  writeFileSync(f, result.designMd);
  const parsed = parseDesignMd(f);
  assert.ok(
    parsed.meta.components.includes('Button'),
    `Expected 'Button' in parsed components: ${JSON.stringify(parsed.meta.components)}`
  );
});
