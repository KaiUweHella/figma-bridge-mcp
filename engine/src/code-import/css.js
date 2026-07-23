/**
 * CSS custom-properties parser.
 * Handles shadcn-style bare HSL triples, Tailwind v4 @theme, oklch(), rgb(), hex.
 * No dependencies — pure regex + math.
 */

// ---------------------------------------------------------------------------
// Colour conversion helpers
// ---------------------------------------------------------------------------

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function toHexCh(n) {
  return Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  // r/g/b are 0-255
  return '#' + [r, g, b].map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
}

/** HSL (h 0-360, s 0-100, l 0-100) → #rrggbb */
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return '#' + [r + m, g + m, b + m].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** oklch(L C H) → #rrggbb via OKLab → LMS → linear sRGB → sRGB */
function oklchToHex(L, C, H) {
  // oklch → OKLab
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  // OKLab → LMS (cube)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const lLMS = l_ * l_ * l_;
  const mLMS = m_ * m_ * m_;
  const sLMS = s_ * s_ * s_;

  // LMS → linear sRGB
  const linR =  4.0767416621 * lLMS - 3.3077115913 * mLMS + 0.2309699292 * sLMS;
  const linG = -1.2684380046 * lLMS + 2.6097574011 * mLMS - 0.3413193965 * sLMS;
  const linB = -0.0041960863 * lLMS - 0.7034186147 * mLMS + 1.7076147010 * sLMS;

  // linear sRGB → sRGB (gamma, with gamut clamp)
  const gamma = (c) => {
    const cClamped = clamp01(c);
    return cClamped <= 0.0031308
      ? 12.92 * cClamped
      : 1.055 * Math.pow(cClamped, 1 / 2.4) - 0.055;
  };

  return '#' + [linR, linG, linB].map(v => toHexCh(gamma(v))).join('');
}

/** Expand 3-digit hex to 6-digit */
function expand3hex(hex) {
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex.toLowerCase();
}

// ---------------------------------------------------------------------------
// Value classifiers
// ---------------------------------------------------------------------------

/** Parse rgb(r, g, b) or rgb(r g b) → #hex or null */
function parseRgb(val) {
  const m = val.match(/^rgba?\(\s*([\d.]+)[,\s]\s*([\d.]+)[,\s]\s*([\d.]+)/);
  if (!m) return null;
  return rgbToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

/** Parse hsl(h, s%, l%) or hsl(h s% l%) → #hex or null */
function parseHsl(val) {
  const m = val.match(/^hsla?\(\s*([\d.]+)[,\s]\s*([\d.]+)%[,\s]\s*([\d.]+)%/);
  if (!m) return null;
  return hslToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

/** Parse bare HSL triple: "0 0% 100%" → #hex or null */
function parseBareHsl(val) {
  const m = val.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return null;
  return hslToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

/** Parse oklch(L C H) → #hex or null */
function parseOklch(val) {
  const m = val.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) return null;
  return oklchToHex(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

/** Convert dimension string to number (px direct, rem ×16) or null */
function parseDimension(val) {
  const m = val.match(/^([\d.]+)(px|rem)$/);
  if (!m) return null;
  return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

/** Extract first font family name from a CSS font-family value */
function extractFirstFont(val) {
  // e.g. '"Inter", sans-serif' or 'Inter, sans-serif'
  const quoted = val.match(/^["']([^"']+)["']/);
  if (quoted) return quoted[1];
  const unquoted = val.match(/^([^,]+)/);
  if (unquoted) {
    const name = unquoted[1].trim();
    // Skip generic families
    if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui)$/.test(name)) return null;
    return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block-context scanner
// ---------------------------------------------------------------------------

/**
 * Scan through the CSS text and find every custom-property declaration,
 * along with whether it's inside a "dark" block.
 * Returns an array of { name, value, isDark, isTheme }.
 */
function extractDeclarations(css) {
  const results = [];

  // We'll walk through the text character by character tracking nesting.
  // For each declaration, we record its enclosing block stack.

  // Build a list of blocks: { start, end, selector, isTheme, isDark }
  // Then for each declaration, check which block it's in.

  // Strategy: tokenise into blocks and declarations in one pass.
  // We track a stack of { selector, isTheme, isDark }.

  const blockStack = []; // stack of { selector, isTheme, isDark }
  let i = 0;
  const len = css.length;

  // Helper: get text before the previous '{' to extract selector
  function getSelectorBefore(pos) {
    // Walk backwards from pos to find the selector text
    let j = pos - 1;
    // skip whitespace
    while (j >= 0 && /\s/.test(css[j])) j--;
    // collect until previous ';' or '{' or '}'
    let end = j;
    while (j >= 0 && css[j] !== '{' && css[j] !== '}' && css[j] !== ';') j--;
    return css.slice(j + 1, end + 1).trim();
  }

  // We need to find:
  // 1. Opening braces '{' → push block with selector
  // 2. Closing braces '}' → pop block
  // 3. Custom property declarations '--name: value;'

  // To avoid false matches inside strings or comments, do a simple pass
  // that skips /* ... */ comments.

  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));

  // Collect block open positions and selector text
  // We'll use a different approach: split by '{' and '}', tracking selector context

  // Reset and do a character-level pass
  const stack = []; // each entry: { selector, isTheme, isDark }
  let pos = 0;

  while (pos < stripped.length) {
    const ch = stripped[pos];

    if (ch === '{') {
      // Find the selector text between previous block-ending char and here
      let sel = getSelectorBefore(pos);
      // Remove @layer wrappers from selector (they don't affect dark detection)
      const isTheme = /^@theme\b/.test(sel);
      const isDark = /\.dark\b|\.dark$|\[data-theme=["']dark["']\]|\[data-mode=["']dark["']\]/.test(sel);
      stack.push({ selector: sel, isTheme, isDark });
      pos++;
      continue;
    }

    if (ch === '}') {
      stack.pop();
      pos++;
      continue;
    }

    // Look for --name: value;
    if (ch === '-' && stripped[pos + 1] === '-') {
      const declStart = pos;
      // Find the end of this declaration (next ';' or '}')
      let colonPos = stripped.indexOf(':', pos);
      if (colonPos === -1) { pos++; continue; }
      const name = stripped.slice(pos + 2, colonPos).trim();

      // Find value end: next ';' not inside parens, or '}'
      let valStart = colonPos + 1;
      let valEnd = valStart;
      let depth = 0;
      while (valEnd < stripped.length) {
        const c = stripped[valEnd];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if ((c === ';' || c === '}') && depth === 0) break;
        valEnd++;
      }
      const value = stripped.slice(valStart, valEnd).trim();

      // Determine context from stack
      const isTheme = stack.some(b => b.isTheme);
      const isDark = stack.some(b => b.isDark);

      if (name && value) {
        results.push({ name, value, isDark, isTheme });
      }

      pos = valEnd;
      continue;
    }

    pos++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse CSS custom properties from a CSS file.
 * @param {string} cssText
 * @returns {{ tokens: object, meta: object }}
 */
export function parseCss(cssText) {
  const tokens = {
    color: {},
    typography: {},
    radius: {},
    spacing: {},
    shadow: {},
    fonts: [],
  };

  const declarations = extractDeclarations(cssText);

  // First pass: collect all non-dark declarations, first-definition-wins
  const defined = new Map(); // name → value (raw CSS value string)

  for (const decl of declarations) {
    if (decl.isDark) continue;
    if (!defined.has(decl.name)) {
      defined.set(decl.name, { value: decl.value, isTheme: decl.isTheme });
    }
  }

  // Second pass: classify values
  // We need to handle var() references, so resolve them in order of definition
  // (declarations appear in source order in `defined`)
  const resolved = new Map(); // name → final hex/number value
  const fonts = [];

  for (const [name, { value, isTheme }] of defined) {
    // --- Resolve var() references ---
    let val = value;
    const varMatch = val.match(/^var\(--([^)]+)\)$/);
    if (varMatch) {
      const refName = varMatch[1].trim();
      const refVal = resolved.get(refName);
      if (refVal !== undefined) {
        val = typeof refVal === 'string' && refVal.startsWith('#') ? refVal : value;
        // Store resolved color directly
        if (typeof refVal === 'string' && refVal.startsWith('#')) {
          resolved.set(name, refVal);
          tokens.color[name] = refVal;
          continue;
        }
      }
      // Can't resolve — skip
      continue;
    }

    // --- @theme block: handle Tailwind v4 prefixes ---
    if (isTheme) {
      if (name.startsWith('color-')) {
        const tokenName = name.slice('color-'.length);
        const hex = valueToHex(val);
        if (hex) {
          resolved.set(name, hex);
          tokens.color[tokenName] = hex;
        }
        continue;
      }
      if (name.startsWith('radius-')) {
        const tokenName = name; // keep "radius-md" as-is
        const px = parseDimension(val);
        if (px !== null) {
          tokens.radius[tokenName] = px;
        }
        continue;
      }
      if (name.startsWith('spacing-')) {
        const tokenName = name; // keep "spacing-gutter" as-is
        const px = parseDimension(val);
        if (px !== null) {
          tokens.spacing[tokenName] = px;
        }
        continue;
      }
      if (name.startsWith('font-')) {
        const family = extractFirstFont(val);
        if (family && !fonts.includes(family)) fonts.push(family);
        continue;
      }
      // Other @theme values: try as color or dimension
      const hex = valueToHex(val);
      if (hex) {
        resolved.set(name, hex);
        tokens.color[name] = hex;
        continue;
      }
      continue;
    }

    // --- Regular (non-@theme) declarations ---

    // Radius bucket: name contains "radius"
    if (/radius|radii|rounded/i.test(name)) {
      // Try dimension
      const px = parseDimension(val);
      if (px !== null) {
        tokens.radius[name] = px;
        resolved.set(name, px);
        continue;
      }
    }

    // Spacing bucket
    if (/spacing|space|gap/i.test(name) && !/background|foreground/i.test(name)) {
      const px = parseDimension(val);
      if (px !== null) {
        tokens.spacing[name] = px;
        resolved.set(name, px);
        continue;
      }
    }

    // Color values
    const hex = valueToHex(val);
    if (hex) {
      resolved.set(name, hex);
      tokens.color[name] = hex;
      continue;
    }
  }

  tokens.fonts = fonts;
  return { tokens, meta: { source: 'css variables' } };
}

/**
 * Try to convert a CSS value string to a hex color.
 * Returns #rrggbb string or null.
 */
function valueToHex(val) {
  const v = val.trim();

  // Hex color
  if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) {
    return expand3hex(v);
  }

  // rgb() / rgba()
  if (/^rgba?\(/.test(v)) {
    return parseRgb(v);
  }

  // hsl() / hsla()
  if (/^hsla?\(/.test(v)) {
    return parseHsl(v);
  }

  // oklch()
  if (/^oklch\(/.test(v)) {
    return parseOklch(v);
  }

  // Bare HSL triple: "222.2 84% 4.9%"
  if (/^[\d.]/.test(v)) {
    return parseBareHsl(v);
  }

  return null;
}
