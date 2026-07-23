/**
 * Code-import dispatcher.
 * Detects source type from filename / content and dispatches to the
 * appropriate parser (Tasks 1-4). Renders output as a Format-B DESIGN.md
 * string that parseDesignMd (src/design-md.js) can round-trip through.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseW3cTokens } from './w3c-tokens.js';
import { parseCss } from './css.js';
import { parseTailwindConfig } from './tailwind.js';
import { parseStorybookIndex, fetchStorybookIndex } from './storybook.js';

/**
 * Detect which parser to use from the source path + optional content sample.
 * Sync — at most one statSync for directory detection.
 *
 * @param {string} source
 * @param {string} [contentSample='']
 * @returns {'tailwind'|'css'|'tokens'|'storybook'|'designmd'|null}
 */
export function detectSourceType(source, contentSample = '') {
  // URLs → storybook
  if (/^https?:\/\//.test(source)) return 'storybook';

  const base = basename(source);

  // tailwind.config.<ext> (any extension: js, cjs, mjs, ts)
  if (/^tailwind\.config\.[a-z]+$/i.test(base)) return 'tailwind';

  // CSS files
  if (/\.css$/i.test(base)) return 'css';

  // Markdown
  if (/\.md$/i.test(base)) return 'designmd';

  // JSON — sniff content first, then filename fallbacks
  if (/\.json$/i.test(base)) {
    // Storybook: top-level "entries" or "stories" key
    if (/"entries"\s*:/.test(contentSample) || /"stories"\s*:/.test(contentSample)) return 'storybook';
    // W3C / Style Dictionary: "$value" key or nested value string
    if (/"\$value"\s*:/.test(contentSample) || /"value"\s*:\s*"/.test(contentSample)) return 'tokens';
    // filename fallback
    if (/^(index|stories)\.json$/i.test(base)) return 'storybook';
    return 'tokens';
  }

  // Directory → storybook
  try {
    if (statSync(source).isDirectory()) return 'storybook';
  } catch { /* not found or not a directory */ }

  return null;
}

/**
 * Render a normalized { tokens, meta } result into a Format-B DESIGN.md string
 * that parseDesignMd (src/design-md.js) can round-trip through.
 *
 * Format B requires:
 *   # DESIGN.md -- <name>       ← h1 title
 *   **In one line:** <…>        ← identity (matched by identityMatch regex)
 *   source: <…>                 ← in a comment or plain line (matched by sourceMatch regex)
 *   ## N. Machine-readable tokens
 *   ```json design-tokens
 *   { … }
 *   ```
 *
 * Radius values are written as "<n>px" strings (stripPx in the importer handles them).
 */
function renderDesignMd(tokens, meta, type) {
  const name = meta.source || 'imported';
  const colorCount = Object.keys(tokens.color || {}).length;
  const componentCount = meta.components?.length ?? 0;
  const generated = new Date().toISOString();

  // Build the JSON token block.
  // Radius values as "<n>px" strings per convention.
  const radiusOut = {};
  for (const [k, v] of Object.entries(tokens.radius || {})) {
    radiusOut[k] = typeof v === 'number' ? `${v}px` : v;
  }

  const jsonBlock = {
    $schema: 'https://design-tokens.figma.com/v1/schema.json',
    meta: {
      source: name,
      generated,
    },
    color: tokens.color || {},
    typography: tokens.typography || {},
    spacing: tokens.spacing || {},
    radius: radiusOut,
    shadow: tokens.shadow || {},
    fonts: tokens.fonts || [],
  };

  const lines = [];

  // H1 title — required by Format B (parseDesignMd doesn't actually check this
  // but we emit it for completeness and human readability)
  lines.push(`# DESIGN.md -- ${name}`);
  lines.push('');

  // Extraction-meta comment block (source: line matched by sourceMatch regex)
  lines.push('<!--');
  lines.push(`source: ${name}`);
  lines.push(`generator: figma-cli import (${type})`);
  lines.push(`generated: ${generated}`);
  lines.push('-->');
  lines.push('');

  // ## 1. Identity — required: **In one line:** matched by identityMatch regex
  lines.push('## 1. Identity');
  lines.push('');
  lines.push(
    `**In one line:** Design tokens imported from ${type} (${colorCount} color${colorCount !== 1 ? 's' : ''}` +
    (componentCount > 0 ? `, ${componentCount} component${componentCount !== 1 ? 's' : ''}` : '') +
    ').'
  );
  lines.push('');

  // ## 2. Components — optional, only when components are present
  let sectionN = 2;
  if (componentCount > 0) {
    lines.push('## 2. Components');
    lines.push('');
    for (const comp of meta.components) {
      // Use "### Page: <name>" so parseDesignMd (Format B componentSections
      // regex /^### Page:\s+(.+)$/gm) picks these up on re-parse.
      lines.push(`### Page: ${comp.name}`);
      if (comp.variants?.length) {
        lines.push(`Variants: ${comp.variants.join(', ')}`);
      }
      if (comp.category) {
        lines.push(`Category: ${comp.category}`);
      }
      lines.push('');
    }
    sectionN = 3;
  }

  // ## N. Machine-readable tokens — required block
  lines.push(`## ${sectionN}. Machine-readable tokens`);
  lines.push('');
  lines.push('```json design-tokens');
  lines.push(JSON.stringify(jsonBlock, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/**
 * Convert a source file/URL to { tokens, meta, designMd }.
 *
 * @param {string} source  - file path or URL
 * @param {{ type?: string }} [opts]
 * @returns {Promise<{ tokens: object, meta: object, designMd: string }>}
 */
export async function convert(source, { type } = {}) {
  // Resolve type: explicit param wins, else detect from name + first 2 KB
  let resolvedType = type;
  if (!resolvedType) {
    let sample = '';
    if (!/^https?:\/\//.test(source)) {
      try {
        sample = readFileSync(source, 'utf8').slice(0, 2048);
      } catch { /* file not readable — detectSourceType will figure it out */ }
    }
    resolvedType = detectSourceType(source, sample);
  }

  let tokens, meta;

  switch (resolvedType) {
    case 'tokens': {
      const content = readFileSync(source, 'utf8');
      ({ tokens, meta } = parseW3cTokens(content));
      break;
    }
    case 'css': {
      const content = readFileSync(source, 'utf8');
      ({ tokens, meta } = parseCss(content));
      break;
    }
    case 'tailwind': {
      ({ tokens, meta } = await parseTailwindConfig(source));
      break;
    }
    case 'storybook': {
      let content;
      if (/^https?:\/\//.test(source)) {
        content = await fetchStorybookIndex(source);
      } else {
        // Check if it's a directory
        let isDir = false;
        try { isDir = statSync(source).isDirectory(); } catch { /* file */ }
        if (isDir) {
          content = await fetchStorybookIndex(source);
        } else {
          content = readFileSync(source, 'utf8');
        }
      }
      ({ tokens, meta } = parseStorybookIndex(content));
      break;
    }
    default:
      throw new Error(
        `Cannot convert "${source}": unknown or unsupported type "${resolvedType}". ` +
        'Supported: tailwind, css, tokens (W3C JSON), storybook.'
      );
  }

  const designMd = renderDesignMd(tokens, meta, resolvedType);
  return { tokens, meta, designMd };
}
