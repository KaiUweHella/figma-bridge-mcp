/**
 * CSS custom-property formatter for `export css` — pure, unit-testable.
 * Input: [{ name, type, value }] where value is already alias-resolved
 * (hex string for COLOR, number for FLOAT, raw for STRING/BOOLEAN,
 * null when the alias points outside the file).
 *
 * Fixes the three output bugs from the test run (IMPROVEMENTS #7):
 * names with spaces ("--color-on primary"), word font-weights ("regular"),
 * and float noise ("1.1699999570846558px").
 */

/** Figma variable name → valid CSS custom-property name. */
export function cssName(name) {
  return '--' + String(name)
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
}

const WEIGHT_MAP = {
  thin: 100, hairline: 100,
  extralight: 200, 'extra-light': 200, ultralight: 200,
  light: 300,
  regular: 400, normal: 400, book: 400,
  medium: 500,
  semibold: 600, 'semi-bold': 600, demibold: 600,
  bold: 700,
  extrabold: 800, 'extra-bold': 800, ultrabold: 800,
  black: 900, heavy: 900,
};

/** "Semibold" → 600; unknown strings pass through unchanged. */
export function mapFontWeight(value) {
  const key = String(value).trim().toLowerCase().replace(/\s+/g, '-');
  return WEIGHT_MAP[key] ?? value;
}

/**
 * Where to get a font. Agents guessed replacement fonts without this
 * (Space Grotesk instead of Clash Grotesk); the comment points them at
 * the real source instead.
 */
const FONT_SOURCES = [
  [/^(clash|satoshi|general sans|cabinet|switzer|author|sentient)/i, 'Fontshare'],
  [/^geist/i, 'Vercel (vercel.com/font)'],
  [/^(sf pro|sf mono|new york)/i, 'Apple (developer.apple.com/fonts)'],
  [/^(inter|roboto|open sans|lato|montserrat|poppins|source|noto|work sans|dm |ibm plex|space grotesk|manrope|outfit|figtree|karla|rubik|nunito|raleway|playfair|merriweather|lora|crimson)/i, 'Google Fonts'],
];

export function fontSource(family) {
  for (const [re, src] of FONT_SOURCES) {
    if (re.test(String(family).trim())) return src;
  }
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;

const isWeightName = (name) => /weight/i.test(name);
// Two signals mark a font-family token: the NAME mentions font, or the VALUE
// is a known family ("subheading: Clash Grotesk" has a font-less name).
const isFontFamilyName = (name, value) => {
  if (isWeightName(name) || typeof value !== 'string' || value.toLowerCase() in WEIGHT_MAP) return false;
  return (/font/i.test(name) && /[a-zA-Z]{2}/.test(value)) || fontSource(value) !== null;
};

/**
 * Scoped variables → W3C DTCG token tree (the node-scoped `export dtcg` path).
 * Input: [{ name, type, value, ref }] from usedVariablesCode — value is
 * alias-resolved, ref names the alias target when the variable is an alias
 * (the target is part of the same list, so `{a.b.c}` references resolve).
 * Pure, unit-testable.
 */
export function buildDtcgTree(vars) {
  const tree = {};
  const dot = (n) => String(n).replace(/\//g, '.');
  const setPath = (path, token) => {
    const p = String(path).split('/');
    let cur = tree;
    for (let i = 0; i < p.length - 1; i++) {
      if (!cur[p[i]] || cur[p[i]].$value !== undefined) cur[p[i]] = {};
      cur = cur[p[i]];
    }
    cur[p[p.length - 1]] = token;
  };
  for (const v of vars) {
    const dtype = v.type === 'COLOR' ? 'color' : v.type === 'FLOAT' ? 'dimension' : v.type === 'BOOLEAN' ? 'boolean' : 'string';
    let token;
    if (v.ref) token = { $type: dtype, $value: '{' + dot(v.ref) + '}' };
    else if (v.value === null || v.value === undefined) token = { $type: dtype, $value: null };
    else if (v.type === 'COLOR') token = { $type: 'color', $value: v.value };
    else if (v.type === 'FLOAT') token = { $type: 'dimension', $value: v.value + 'px' };
    else if (v.type === 'BOOLEAN') token = { $type: 'boolean', $value: v.value };
    else token = { $type: 'string', $value: String(v.value) };
    setPath(v.name, token);
  }
  return tree;
}

/**
 * Variables → the full `:root { … }` block.
 * Ordering: colors/floats/misc as given, font-family tokens grouped last
 * under a comment (they need a loading strategy, not just a value).
 */
export function formatCssTokens(vars) {
  const rules = [];
  const fontFamilies = [];
  // Same-named variables across collections (a primitive and a semantic
  // `spacing/2xs`) collapse to one CSS custom property: identical values
  // dedupe silently, conflicting values keep the first and flag the clash.
  const seenProps = new Map(); // prop → first value

  for (const v of vars) {
    const prop = cssName(v.name);
    if (seenProps.has(prop)) {
      const prior = seenProps.get(prop);
      if (prior !== v.value) rules.push(`  /* ${prop}: ${v.value} — name collision across collections; kept ${prior} above */`);
      continue;
    }
    seenProps.set(prop, v.value);
    if (v.value === null || v.value === undefined) {
      rules.push(`  /* ${prop}: unresolved alias (target outside this file) */`);
      continue;
    }
    if (v.type === 'COLOR') {
      rules.push(`  ${prop}: ${v.value};`);
    } else if (v.type === 'FLOAT') {
      rules.push(`  ${prop}: ${round2(Number(v.value))}px;`);
    } else if (isWeightName(v.name)) {
      rules.push(`  ${prop}: ${mapFontWeight(v.value)};`);
    } else if (isFontFamilyName(v.name, v.value)) {
      // Group under --font-family-*; keep the tail of the original name.
      const tail = cssName(v.name).replace(/^--/, '').replace(/^(fonts?-)+/, '').replace(/^(font-)?family-?/, '') || 'default';
      const src = fontSource(v.value);
      fontFamilies.push(`  --font-family-${tail}: "${v.value}";${src ? ` /* source: ${src} */` : ' /* source: unknown — verify before substituting */'}`);
    } else {
      rules.push(`  ${prop}: ${v.value};`);
    }
  }

  const parts = [':root {', ...rules];
  if (fontFamilies.length) {
    parts.push('', '  /* Font families — load these, do not substitute look-alikes */', ...fontFamilies);
  }
  parts.push('}');
  return parts.join('\n');
}
