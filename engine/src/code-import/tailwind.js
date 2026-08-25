/**
 * Tailwind CSS config loader.
 * Reads tailwind.config.{js,cjs,mjs,ts} as data through a bounded static parser.
 * No selected configuration, import, plugin or expression is executed. The
 * resulting object merges theme.extend into theme per top-level key, then
 * extracts color, borderRadius, spacing, fontFamily, fontSize and boxShadow tokens.
 */

import { resolve, basename, dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { workspaceIO } from '../lib/workspace-io.js';

export const TAILWIND_STATIC_POLICY = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 64,
  maxEntries: 20_000,
  timeoutMs: 1_000,
  maxOldGenerationSizeMb: 32,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 2,
});

const STATIC_WORKER_URL = new URL('./tailwind-static-worker.js', import.meta.url);

function staticConfigError(reason) {
  return new Error(
    `Cannot parse Tailwind configuration as static data: ${reason}. ` +
      'Dynamic token-bearing theme expressions are not executed. Import a Tailwind v4 CSS file with @theme ' +
      '(figma_run ["import", "styles.css"]), or export the resolved tokens as W3C JSON.'
  );
}

/** Parse source text in a resource-bounded worker without evaluating it. */
export async function parseStaticTailwindSource(source) {
  if (typeof source !== 'string') throw staticConfigError('source must be text');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > TAILWIND_STATIC_POLICY.maxBytes) {
    throw staticConfigError(`source exceeds ${TAILWIND_STATIC_POLICY.maxBytes} bytes`);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(STATIC_WORKER_URL, {
      argv: [],
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: TAILWIND_STATIC_POLICY.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: TAILWIND_STATIC_POLICY.maxYoungGenerationSizeMb,
        codeRangeSizeMb: TAILWIND_STATIC_POLICY.codeRangeSizeMb,
        stackSizeMb: TAILWIND_STATIC_POLICY.stackSizeMb,
      },
      workerData: {
        source,
        limits: {
          maxDepth: TAILWIND_STATIC_POLICY.maxDepth,
          maxEntries: TAILWIND_STATIC_POLICY.maxEntries,
        },
      },
    });

    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => rejectPromise(staticConfigError(`parsing exceeds ${TAILWIND_STATIC_POLICY.timeoutMs} milliseconds`)));
    }, TAILWIND_STATIC_POLICY.timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok === true) {
        finish(() => resolvePromise(message.config));
      } else {
        const reason = typeof message?.error?.message === 'string' ? message.error.message : 'the static parser rejected the module';
        finish(() => rejectPromise(staticConfigError(reason)));
      }
    });
    worker.once('error', () => {
      finish(() => rejectPromise(staticConfigError('the isolated parser stopped unexpectedly')));
    });
    worker.once('exit', (code) => {
      if (!settled) {
        finish(() =>
          rejectPromise(
            staticConfigError(code === 0 ? 'the isolated parser returned no result' : 'the isolated parser exceeded its resource policy')
          )
        );
      }
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const toPx = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v).match(/^([\d.]+)(px|rem)?$/);
  if (!m) return null;
  return m[2] === 'rem' ? Math.round(parseFloat(m[1]) * 16) : parseFloat(m[1]);
};

const isColorValue = (v) => typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|rgb|hsl)/.test(v.trim());

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
 * @param {{workspaceIO?: object}} [options]
 * @returns {Promise<{tokens, meta}>}
 */
export async function parseTailwindConfig(configPath, {
  workspaceIO: sourceIO = workspaceIO(),
} = {}) {
  const requested = resolve(configPath);
  let abs;
  let source;
  try {
    abs = sourceIO.authorizePath(requested, {
      access: 'read',
      role: 'tailwind-config',
      kind: 'file',
    }).canonical;
    source = sourceIO.readText(abs, {
      role: 'tailwind-config',
      maxBytes: TAILWIND_STATIC_POLICY.maxBytes,
    });
  } catch (err) {
    throw new Error(`Cannot load Tailwind configuration: ${err.message}`);
  }
  const config = await parseStaticTailwindSource(source);
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

  const tokens = {
    color: {},
    typography: {},
    radius: {},
    spacing: {},
    shadow: {},
    fonts: [],
  };
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
      if (typeof v === 'function') {
        functionCount++;
        continue;
      }
      const px = toPx(v);
      if (px != null) {
        tokens.radius[`radius-${k}`] = px;
        totalValues++;
      }
    }
  } else {
    functionCount++;
  }

  // ── spacing ──────────────────────────────────────────────────────────────
  const rawSpacing = merged.spacing ?? {};
  if (typeof rawSpacing !== 'function') {
    for (const [k, v] of Object.entries(rawSpacing)) {
      if (typeof v === 'function') {
        functionCount++;
        continue;
      }
      const px = toPx(v);
      if (px != null) {
        tokens.spacing[`spacing-${k}`] = px;
        totalValues++;
      }
    }
  } else {
    functionCount++;
  }

  // ── fontFamily ────────────────────────────────────────────────────────────
  const rawFontFamily = merged.fontFamily ?? {};
  if (typeof rawFontFamily !== 'function') {
    for (const [, v] of Object.entries(rawFontFamily)) {
      if (typeof v === 'function') {
        functionCount++;
        continue;
      }
      // value is array like ['Inter', 'sans-serif'] or just a string
      const first = Array.isArray(v) ? v[0] : v;
      if (typeof first === 'string' && first && !/^(sans-serif|serif|monospace|cursive|fantasy|system-ui)$/.test(first)) {
        // Strip quotes in case the font name is "'Inter'" or '"Inter"'
        const clean = first.replace(/^['"]|['"]$/g, '');
        if (clean) {
          fontsSet.add(clean);
          totalValues++;
        }
      }
    }
  } else {
    functionCount++;
  }

  // ── fontSize ─────────────────────────────────────────────────────────────
  // Derive first sans family for fontFamily fallback in typography
  const sansFamilies = merged.fontFamily?.sans ?? merged.fontFamily?.['sans'] ?? [];
  const firstSans = Array.isArray(sansFamilies)
    ? (sansFamilies[0] ?? '').replace(/^['"]|['"]$/g, '')
    : typeof sansFamilies === 'string'
      ? sansFamilies.replace(/^['"]|['"]$/g, '')
      : '';
  const defaultFontFamily = firstSans || null;

  const rawFontSize = merged.fontSize ?? {};
  if (typeof rawFontSize !== 'function') {
    for (const [k, v] of Object.entries(rawFontSize)) {
      if (typeof v === 'function') {
        functionCount++;
        continue;
      }
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
      const entry = {
        fontFamily: defaultFontFamily,
        fontSize,
        fontWeight: 400,
      };
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

  // ── boxShadow ────────────────────────────────────────────────────────────
  const rawShadow = merged.boxShadow ?? {};
  if (typeof rawShadow !== 'function') {
    for (const [key, value] of Object.entries(rawShadow)) {
      if (typeof value === 'function') { functionCount++; continue; }
      if (typeof value === 'string' || Array.isArray(value)
        || (value && typeof value === 'object')) {
        tokens.shadow[`shadow-${key}`] = value;
        totalValues++;
      }
    }
  } else {
    functionCount++;
  }

  // If everything was functions (typical in some complex configs) warn helpfully
  if (totalValues === 0 && functionCount > 0) {
    throw new Error(
      'Cannot parse Tailwind configuration as static data: all theme values are dynamic functions. ' +
        `If this is a Tailwind v4 project, import the CSS file with @theme instead ` +
        `(figma_run ["import", "styles.css"]), or export your tokens as JSON.`
    );
  }

  tokens.fonts = [...fontsSet];

  // meta: "<project-folder-name> tailwind"
  const projectDir = basename(dirname(abs));
  return { tokens, meta: { source: `${projectDir} tailwind` } };
}
