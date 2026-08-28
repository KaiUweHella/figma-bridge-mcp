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

const cleanNumber = (n) => Math.round(Number(n) * 1_000_000) / 1_000_000;

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
    if (!variable || chain.has(variable.id)) return { value: null, ref: null, refId: null };
    const nextChain = new Set(chain).add(variable.id);
    let value = variable.valuesByMode?.[mode.modeId];
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      const target = byId.get(value.id);
      if (!target) return { value: null, ref: null, refId: null };
      const targetCollection = collectionsById.get(target.variableCollectionId);
      const targetModes = targetCollection?.modes || [];
      const targetMode = Object.prototype.hasOwnProperty.call(target.valuesByMode || {}, mode.modeId)
        ? mode
        : targetModes.find((candidate) => candidate.name === mode.name)
          || targetModes.find((candidate) => candidate.modeId === targetCollection?.defaultModeId)
          || targetModes[0];
      const resolved = resolve(target, targetMode || mode, nextChain);
      return { value: resolved.value, ref: target.name, refId: target.id };
    }
    if (variable.resolvedType === 'COLOR' && value && typeof value === 'object' && 'r' in value) {
      value = figmaColorToHex(value);
    }
    if (value && typeof value === 'object') value = null;
    return { value: value === undefined ? null : value, ref: null, refId: null };
  };

  return (variables || []).map((variable) => {
    const collection = collectionsById.get(variable.variableCollectionId);
    const modes = collection?.modes?.length
      ? collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
      : Object.keys(variable.valuesByMode || {}).map((modeId) => ({ modeId, name: modeId }));
    const defaultModeId = collection?.defaultModeId || modes[0]?.modeId;
    const valuesByMode = Object.fromEntries(modes.map((mode) => [mode.modeId, resolve(variable, mode)]));
    const selected = valuesByMode[defaultModeId] || valuesByMode[modes[0]?.modeId]
      || { value: null, ref: null, refId: null };
    return {
      id: variable.id,
      name: variable.name,
      type: variable.resolvedType,
      value: selected.value,
      ref: selected.ref,
      refId: selected.refId,
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
    return [{
      modeId: null,
      modeName: null,
      value: variable.value,
      ref: variable.ref || null,
      refId: variable.refId || null,
      isDefault: true,
    }];
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
      refId: record.refId || null,
      isDefault: mode.modeId === defaultModeId,
    };
  });
}

function dtcgValue(variable, value, ref, refId, dialect, resolveReference = null) {
  const dot = (name) => String(name).replace(/\//g, '.');
  if (ref) {
    const resolved = resolveReference ? resolveReference(ref, refId) : ref;
    return '{' + dot(resolved) + '}';
  }
  if (value === null || value === undefined) return null;
  if (variable.type === 'COLOR') return dialect === '2025' ? color2025(value) : value;
  if (variable.type === 'FLOAT') return dialect === '2025'
    ? { value: cleanNumber(value), unit: 'px' }
    : cleanNumber(value) + 'px';
  if (variable.type === 'TIMING') return dialect === '2025'
    ? { value: cleanNumber(value), unit: 's' }
    : cleanNumber(value) + 's';
  if (variable.type === 'BOOLEAN') return value;
  return String(value);
}

function bridgeExtension(variable, dialect, { outputPath = variable.name, resolveReference = null } = {}) {
  const metadata = {
    ...(variable.id ? { variableId: variable.id } : {}),
    ...(variable.collection ? { collection: variable.collection } : {}),
    ...(outputPath !== variable.name ? { sourceName: variable.name } : {}),
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
      value: dtcgValue(
        variable,
        entry.value,
        entry.ref,
        entry.refId,
        dialect,
        resolveReference,
      ),
    }]));
  }
  return Object.keys(metadata).length ? { [DTCG_BRIDGE_EXTENSION]: metadata } : null;
}

function stableIdentitySuffix(variable) {
  const input = `${variable.id || ''}\u0000${variable.collection || ''}\u0000${variable.name || ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function collisionAwareDtcgPaths(vars) {
  const nameCounts = new Map();
  for (const variable of vars) {
    nameCounts.set(variable.name, (nameCounts.get(variable.name) || 0) + 1);
  }
  const candidates = vars.map((variable) => nameCounts.get(variable.name) > 1
    ? `figma-collections/${variable.collection || 'Uncollected'}/${variable.name}`
    : variable.name);
  const candidateCounts = new Map();
  for (const path of candidates) candidateCounts.set(path, (candidateCounts.get(path) || 0) + 1);
  const paths = candidates.map((path, index) => candidateCounts.get(path) > 1
    ? `${path}~${stableIdentitySuffix(vars[index])}`
    : path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('DTCG token identities cannot be disambiguated without losing data.');
  }
  return paths;
}

function collisionAwareCssProperties(vars) {
  const base = vars.map((variable) => cssName(variable.name));
  const baseCounts = new Map();
  for (const property of base) baseCounts.set(property, (baseCounts.get(property) || 0) + 1);
  const candidates = vars.map((variable, index) => baseCounts.get(base[index]) > 1
    ? cssName(`figma/${variable.collection || 'uncollected'}/${variable.name}`)
    : base[index]);
  const candidateCounts = new Map();
  for (const property of candidates) {
    candidateCounts.set(property, (candidateCounts.get(property) || 0) + 1);
  }
  const properties = candidates.map((property, index) => candidateCounts.get(property) > 1
    ? `${property}-${stableIdentitySuffix(vars[index])}`
    : property);
  if (new Set(properties).size !== properties.length) {
    throw new Error('CSS token identities cannot be disambiguated without losing data.');
  }
  return properties;
}

export function buildDtcgTree(vars, { dialect = 'legacy' } = {}) {
  if (!DTCG_DIALECTS.has(dialect)) throw new Error(`Unsupported DTCG dialect "${dialect}". Use legacy or 2025.`);
  const tree = {};
  const paths = collisionAwareDtcgPaths(vars);
  const pathById = new Map();
  const pathsByName = new Map();
  vars.forEach((variable, index) => {
    if (variable.id) pathById.set(variable.id, paths[index]);
    if (!pathsByName.has(variable.name)) pathsByName.set(variable.name, []);
    pathsByName.get(variable.name).push(paths[index]);
  });
  const resolveReference = (name, id) => {
    if (id && pathById.has(id)) return pathById.get(id);
    const matches = pathsByName.get(name) || [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous DTCG alias target ${name}; exact Variable identity is required.`);
    }
    return name;
  };
  const setPath = (path, token) => {
    const p = String(path).split('/');
    let cur = tree;
    for (let i = 0; i < p.length - 1; i++) {
      const segment = p[i];
      if (segment === '$root') throw new Error('DTCG token paths cannot use the reserved $root segment.');
      const existing = cur[segment];
      if (!existing) cur[segment] = {};
      else if (existing && typeof existing === 'object' && !Array.isArray(existing)
        && Object.hasOwn(existing, '$value')) cur[segment] = { $root: existing };
      else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error(`DTCG token path collides at ${p.slice(0, i + 1).join('/')}.`);
      }
      cur = cur[segment];
    }
    const leaf = p[p.length - 1];
    if (leaf === '$root') throw new Error('DTCG token paths cannot use the reserved $root segment.');
    const existing = cur[leaf];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)
      && !Object.hasOwn(existing, '$value')) {
      if (Object.hasOwn(existing, '$root')) throw new Error(`Duplicate DTCG token path ${path}.`);
      existing.$root = token;
    } else if (existing !== undefined) throw new Error(`Duplicate DTCG token path ${path}.`);
    else cur[leaf] = token;
  };
  for (let index = 0; index < vars.length; index += 1) {
    const v = vars[index];
    const outputPath = paths[index];
    const dtype = v.type === 'COLOR' ? 'color'
      : v.type === 'FLOAT' ? 'dimension'
        : v.type === 'TIMING' ? 'duration'
          : v.type === 'BOOLEAN' ? 'boolean' : 'string';
    const entries = modeEntries(v);
    const selected = entries.find((entry) => entry.isDefault) || entries[0];
    const token = {
      $type: dtype,
      $value: dtcgValue(
        v,
        selected?.value,
        selected?.ref,
        selected?.refId,
        dialect,
        resolveReference,
      ),
    };
    if (v.description) token.$description = v.description;
    const extension = bridgeExtension(v, dialect, { outputPath, resolveReference });
    if (extension) token.$extensions = extension;
    setPath(outputPath, token);
  }
  return tree;
}

/**
 * Variables → the full `:root { … }` block.
 * Ordering: colors/floats/misc as given, font-family tokens grouped last
 * under a comment (they need a loading strategy, not just a value).
 */
export function formatCssTokens(vars) {
  const properties = collisionAwareCssProperties(vars);
  const defaultVars = [];
  const modeVars = new Map();
  for (let index = 0; index < vars.length; index += 1) {
    const variable = vars[index];
    const entries = modeEntries(variable);
    const selected = entries.find((entry) => entry.isDefault) || entries[0];
    defaultVars.push({
      ...variable,
      value: selected?.value,
      ref: selected?.ref,
      refId: selected?.refId,
      exportProperty: properties[index],
    });
    for (const entry of entries) {
      if (entry === selected || !entry.modeName) continue;
      if (!modeVars.has(entry.modeName)) modeVars.set(entry.modeName, []);
      modeVars.get(entry.modeName).push({
        ...variable,
        value: entry.value,
        ref: entry.ref,
        refId: entry.refId,
        exportProperty: properties[index],
      });
    }
  }

  const renderScope = (scopeVars, selector, includeFontGuide) => {
  const rules = [];
  const fontFamilies = [];
  for (const v of scopeVars) {
    const prop = v.exportProperty;
    if (includeFontGuide && prop !== cssName(v.name)) {
      const sourceName = String(v.name).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');
      const sourceCollection = String(v.collection || 'Uncollected')
        .replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');
      rules.push(`  /* Figma token "${sourceName}" in collection "${sourceCollection}" */`);
    }
    if (v.value === null || v.value === undefined) {
      rules.push(`  /* ${prop}: unresolved alias (target outside this file) */`);
      continue;
    }
    if (v.type === 'COLOR') {
      rules.push(`  ${prop}: ${v.value};`);
    } else if (v.type === 'FLOAT') {
      rules.push(`  ${prop}: ${cleanNumber(v.value)}px;`);
    } else if (v.type === 'TIMING') {
      rules.push(`  ${prop}: ${cleanNumber(v.value)}s;`);
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
