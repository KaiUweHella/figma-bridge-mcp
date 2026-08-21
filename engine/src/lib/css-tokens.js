/**
 * CSS custom-property formatter for `export css` — pure, unit-testable.
 * Input: [{ name, type, value }] where value is already alias-resolved
 * (hex string for COLOR, number for FLOAT, raw for STRING/BOOLEAN,
 * null when the alias points outside the file).
 *
 * Fixes three output bugs found during acceptance testing (IMPROVEMENTS #7):
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

const figmaColorToHex = (color) => {
  const byte = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
  const base = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  return color.a != null && color.a < 1 ? base + byte(color.a) : base;
};

/** Raw Figma variables/collections → lossless formatter interface. */
export function projectVariableModes(variables, collections) {
  const byId = new Map((variables || []).map((variable) => [variable.id, variable]));
  const collectionsById = new Map((collections || []).map((collection) => [collection.id, collection]));
  const resolve = (variable, mode, chain = new Set()) => {
    if (!variable || chain.has(variable.id)) return { value: null, ref: null };
    const nextChain = new Set(chain).add(variable.id);
    let value = variable.valuesByMode?.[mode.modeId];
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      const target = byId.get(value.id);
      if (!target) return { value: null, ref: null };
      const targetCollection = collectionsById.get(target.variableCollectionId);
      const targetModes = targetCollection?.modes || [];
      const targetMode = Object.prototype.hasOwnProperty.call(target.valuesByMode || {}, mode.modeId)
        ? mode
        : targetModes.find((candidate) => candidate.name === mode.name)
          || targetModes.find((candidate) => candidate.modeId === targetCollection?.defaultModeId)
          || targetModes[0];
      const resolved = resolve(target, targetMode || mode, nextChain);
      return { value: resolved.value, ref: target.name };
    }
    if (variable.resolvedType === 'COLOR' && value && typeof value === 'object' && 'r' in value) {
      value = figmaColorToHex(value);
    }
    if (value && typeof value === 'object') value = null;
    return { value: value === undefined ? null : value, ref: null };
  };

  return (variables || []).map((variable) => {
    const collection = collectionsById.get(variable.variableCollectionId);
    const modes = collection?.modes?.length
      ? collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
      : Object.keys(variable.valuesByMode || {}).map((modeId) => ({ modeId, name: modeId }));
    const defaultModeId = collection?.defaultModeId || modes[0]?.modeId;
    const valuesByMode = Object.fromEntries(modes.map((mode) => [mode.modeId, resolve(variable, mode)]));
    const selected = valuesByMode[defaultModeId] || valuesByMode[modes[0]?.modeId] || { value: null, ref: null };
    return {
      id: variable.id,
      name: variable.name,
      type: variable.resolvedType,
      value: selected.value,
      ref: selected.ref,
      valuesByMode,
      modes,
      defaultModeId,
      collection: collection?.name,
      description: variable.description || undefined,
      scopes: Array.isArray(variable.scopes) ? Array.from(variable.scopes) : undefined,
      codeSyntax: variable.codeSyntax && typeof variable.codeSyntax === 'object' ? variable.codeSyntax : undefined,
    };
  });
}

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
export const DTCG_DIALECTS = new Set(['legacy', '2025']);
export const DTCG_BRIDGE_EXTENSION = 'figma-bridge-mcp';

function color2025(value) {
  const hex = String(value || '').toLowerCase();
  const match = hex.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) return value;
  const part = (index) => Math.round((parseInt(match[1].slice(index, index + 2), 16) / 255) * 100000) / 100000;
  const alpha = match[2] ? Math.round((parseInt(match[2], 16) / 255) * 100000) / 100000 : 1;
  return { colorSpace: 'srgb', components: [part(0), part(2), part(4)], alpha, hex };
}

function modeEntries(variable) {
  const modes = Array.isArray(variable.modes) ? variable.modes : [];
  if (!variable.valuesByMode || !modes.length) {
    return [{ modeId: null, modeName: null, value: variable.value, ref: variable.ref || null, isDefault: true }];
  }
  const defaultModeId = variable.defaultModeId || modes[0]?.modeId;
  return modes.map((mode) => {
    const stored = variable.valuesByMode[mode.modeId];
    const record = stored && typeof stored === 'object' && ('value' in stored || 'ref' in stored)
      ? stored
      : { value: stored, ref: null };
    return {
      modeId: mode.modeId,
      modeName: mode.name,
      value: record.value,
      ref: record.ref || null,
      isDefault: mode.modeId === defaultModeId,
    };
  });
}

function dtcgValue(variable, value, ref, dialect) {
  const dot = (name) => String(name).replace(/\//g, '.');
  if (ref) return '{' + dot(ref) + '}';
  if (value === null || value === undefined) return null;
  if (variable.type === 'COLOR') return dialect === '2025' ? color2025(value) : value;
  if (variable.type === 'FLOAT') return dialect === '2025'
    ? { value: Number(value), unit: 'px' }
    : value + 'px';
  if (variable.type === 'BOOLEAN') return value;
  return String(value);
}

function bridgeExtension(variable, dialect) {
  const metadata = {
    ...(variable.id ? { variableId: variable.id } : {}),
    ...(variable.collection ? { collection: variable.collection } : {}),
    ...(Array.isArray(variable.scopes) ? { scopes: [...new Set(variable.scopes.map(String))].sort() } : {}),
    ...(variable.codeSyntax && typeof variable.codeSyntax === 'object'
      ? { codeSyntax: Object.fromEntries(Object.entries(variable.codeSyntax).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  };
  const entries = modeEntries(variable);
  if (variable.valuesByMode && entries.some((entry) => entry.modeId)) {
    metadata.defaultModeId = variable.defaultModeId || entries[0]?.modeId;
    metadata.modes = entries.map((entry) => ({ modeId: entry.modeId, name: entry.modeName }));
    metadata.valuesByMode = Object.fromEntries(entries.map((entry) => [entry.modeId, {
      modeName: entry.modeName,
      value: dtcgValue(variable, entry.value, entry.ref, dialect),
    }]));
  }
  return Object.keys(metadata).length ? { [DTCG_BRIDGE_EXTENSION]: metadata } : null;
}

export function buildDtcgTree(vars, { dialect = 'legacy' } = {}) {
  if (!DTCG_DIALECTS.has(dialect)) throw new Error(`Unsupported DTCG dialect "${dialect}". Use legacy or 2025.`);
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
    const entries = modeEntries(v);
    const selected = entries.find((entry) => entry.isDefault) || entries[0];
    const token = { $type: dtype, $value: dtcgValue(v, selected?.value, selected?.ref, dialect) };
    if (v.description) token.$description = v.description;
    const extension = bridgeExtension(v, dialect);
    if (extension) token.$extensions = extension;
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
  const defaultVars = [];
  const modeVars = new Map();
  for (const variable of vars) {
    const entries = modeEntries(variable);
    const selected = entries.find((entry) => entry.isDefault) || entries[0];
    defaultVars.push({ ...variable, value: selected?.value, ref: selected?.ref });
    for (const entry of entries) {
      if (entry === selected || !entry.modeName) continue;
      if (!modeVars.has(entry.modeName)) modeVars.set(entry.modeName, []);
      modeVars.get(entry.modeName).push({ ...variable, value: entry.value, ref: entry.ref });
    }
  }

  const renderScope = (scopeVars, selector, includeFontGuide) => {
  const rules = [];
  const fontFamilies = [];
  // Same-named variables across collections (a primitive and a semantic
  // `spacing/2xs`) collapse to one CSS custom property: identical values
  // dedupe silently, conflicting values keep the first and flag the clash.
  const seenProps = new Map(); // prop → first value

  for (const v of scopeVars) {
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
      // Preserve the canonical Figma variable name. Native Inspect CSS refers
      // to that exact custom property, so a friendly rename breaks var(...).
      const src = fontSource(v.value);
      fontFamilies.push(`  ${prop}: "${v.value}";${src ? ` /* source: ${src} */` : ' /* source: unknown — verify before substituting */'}`);
    } else {
      rules.push(`  ${prop}: ${v.value};`);
    }
  }

  const parts = [`${selector} {`, ...rules];
  if (fontFamilies.length) {
    // The workflow step, not just the value: a prior acceptance run shipped system-font
    // fallbacks because nothing SAID to go load the families.
    parts.push(
      ...(includeFontGuide ? [
        '',
        '  /* Font families — REQUIRED STEP before building: load each family',
        '     from the source named next to it (@font-face or <link>), or ask',
        '     the user for the font files. Do not substitute look-alikes; a',
        '     system-font fallback distorts metrics and does not count as done. */',
      ] : []),
      ...fontFamilies,
    );
  }
  parts.push('}');
  return parts.join('\n');
  };

  const parts = [renderScope(defaultVars, ':root', true)];
  for (const [modeName, scoped] of modeVars) {
    const escaped = String(modeName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    parts.push(renderScope(scoped, `[data-figma-mode="${escaped}"]`, false));
  }
  return parts.join('\n\n');
}
