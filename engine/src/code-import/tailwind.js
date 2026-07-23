/**
 * Tailwind CSS config loader.
 * Loads a tailwind.config.{js,cjs,mjs,ts} via dynamic import (in-process, no
 * child process — configs are trusted local files the user wrote themselves).
 * Merges theme.extend into theme per top-level key, then extracts color,
 * borderRadius, spacing, fontFamily and fontSize tokens.
 */

import { pathToFileURL } from 'node:url';
import { resolve, basename, dirname } from 'node:path';

// ── helpers ──────────────────────────────────────────────────────────────────

const toPx = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^([\d.]+)(px|rem)?$/);
  if (!m) return null;
  return m[2] === 'rem' ? Math.round(parseFloat(m[1]) * 16) : parseFloat(m[1]);
};

const isColorValue = (v) =>
  typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|rgb|hsl)/.test(v.trim());

const SKIP_COLORS = new Set(['inherit', 'currentColor', 'currentcolor', 'transparent']);

/** Recursively flatten a color map {blue: {500: '#hex'}, white: '#hex'} → {'blue-500':'#hex', white:'#hex'} */
function flattenColors(obj, prefix = '') {
  const out = {};
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}-${k}` : k;
    if (typeof v === 'function') continue; // skip functions silently
    if (typeof v === 'string') {
      if (!SKIP_COLORS.has(v) && isColorValue(v)) out[key] = v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      Object.assign(out, flattenColors(v, key));
    }
  }
  return out;
}

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Parse a Tailwind config file and return normalised tokens.
 * @param {string} configPath  Absolute or relative path to the config file.
 * @returns {Promise<{tokens, meta}>}
 */
export async function parseTailwindConfig(configPath) {
  const abs = resolve(configPath);
  const url = pathToFileURL(abs).href;

  let mod;
  try {
    mod = await import(url);
  } catch (err) {
    throw new Error(
      `Cannot load ${abs}: ${err.message}. ` +
      `If this is a Tailwind v4 project, import the CSS file with @theme instead ` +
      `(figma-cli import styles.css), or export your tokens as JSON.`
    );
  }

  const config = mod.default ?? mod;
  const theme = config?.theme ?? {};
  const ext = theme.extend ?? {};

  // Merge extend into theme per top-level key
  const merged = {};
  const allKeys = new Set([...Object.keys(theme), ...Object.keys(ext)]);
  allKeys.delete('extend');
  for (const k of allKeys) {
    if (k === 'extend') continue;
    if (theme[k] && ext[k]) {
      merged[k] = { ...theme[k], ...ext[k] };
    } else {
      merged[k] = theme[k] ?? ext[k];
    }
  }

  const tokens = { color: {}, typography: {}, radius: {}, spacing: {}, shadow: {}, fonts: [] };
  const fontsSet = new Set();
  let functionCount = 0;
  let totalValues = 0;

  // ── colors ────────────────────────────────────────────────────────────────
  const rawColors = merged.colors ?? merged.color ?? {};
  if (typeof rawColors === 'function') {
    functionCount++;
  } else {
    const flat = flattenColors(rawColors);
    Object.assign(tokens.color, flat);
    totalValues += Object.keys(flat).length;
  }

  // ── borderRadius ─────────────────────────────────────────────────────────
  const rawRadius = merged.borderRadius ?? {};
  if (typeof rawRadius !== 'function') {
    for (const [k, v] of Object.entries(rawRadius)) {
      if (typeof v === 'function') { functionCount++; continue; }
      const px = toPx(v);
      if (px != null) { tokens.radius[`radius-${k}`] = px; totalValues++; }
    }
  } else {
    functionCount++;
  }

  // ── spacing ──────────────────────────────────────────────────────────────
  const rawSpacing = merged.spacing ?? {};
  if (typeof rawSpacing !== 'function') {
    for (const [k, v] of Object.entries(rawSpacing)) {
      if (typeof v === 'function') { functionCount++; continue; }
      const px = toPx(v);
      if (px != null) { tokens.spacing[`spacing-${k}`] = px; totalValues++; }
    }
  } else {
    functionCount++;
  }

  // ── fontFamily ────────────────────────────────────────────────────────────
  const rawFontFamily = merged.fontFamily ?? {};
  if (typeof rawFontFamily !== 'function') {
    for (const [, v] of Object.entries(rawFontFamily)) {
      if (typeof v === 'function') { functionCount++; continue; }
      // value is array like ['Inter', 'sans-serif'] or just a string
      const first = Array.isArray(v) ? v[0] : v;
      if (typeof first === 'string' && first && !/^(sans-serif|serif|monospace|cursive|fantasy|system-ui)$/.test(first)) {
        // Strip quotes in case the font name is "'Inter'" or '"Inter"'
        const clean = first.replace(/^['"]|['"]$/g, '');
        if (clean) { fontsSet.add(clean); totalValues++; }
      }
    }
  } else {
    functionCount++;
  }

  // ── fontSize ─────────────────────────────────────────────────────────────
  // Derive first sans family for fontFamily fallback in typography
  const sansFamilies = merged.fontFamily?.sans ?? merged.fontFamily?.['sans'] ?? [];
  const firstSans = Array.isArray(sansFamilies)
    ? (sansFamilies[0] ?? 'Inter').replace(/^['"]|['"]$/g, '')
    : (typeof sansFamilies === 'string' ? sansFamilies.replace(/^['"]|['"]$/g, '') : 'Inter');
  const defaultFontFamily = firstSans || 'Inter';

  const rawFontSize = merged.fontSize ?? {};
  if (typeof rawFontSize !== 'function') {
    for (const [k, v] of Object.entries(rawFontSize)) {
      if (typeof v === 'function') { functionCount++; continue; }
      let sizeStr, lineHeightStr;
      if (Array.isArray(v)) {
        // tuple form: [size, optionsOrLineHeight]
        sizeStr = v[0];
        const opts = v[1];
        if (typeof opts === 'string') {
          lineHeightStr = opts;
        } else if (opts && typeof opts === 'object') {
          lineHeightStr = opts.lineHeight;
        }
      } else {
        sizeStr = v;
      }
      const fontSize = toPx(sizeStr);
      if (fontSize == null) continue;
      const entry = { fontFamily: defaultFontFamily, fontSize, fontWeight: 400 };
      if (lineHeightStr) {
        const lh = toPx(lineHeightStr);
        if (lh != null) entry.lineHeight = lh;
      }
      tokens.typography[`text-${k}`] = entry;
      totalValues++;
    }
  } else {
    functionCount++;
  }

  // If everything was functions (typical in some complex configs) warn helpfully
  if (totalValues === 0 && functionCount > 0) {
    throw new Error(
      `Cannot load ${abs}: all theme values are dynamic functions. ` +
      `If this is a Tailwind v4 project, import the CSS file with @theme instead ` +
      `(figma-cli import styles.css), or export your tokens as JSON.`
    );
  }

  tokens.fonts = [...fontsSet];

  // meta: "<project-folder-name> tailwind"
  const projectDir = basename(dirname(abs));
  return { tokens, meta: { source: `${projectDir} tailwind` } };
}
