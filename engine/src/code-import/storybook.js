/**
 * Storybook index parser.
 * Accepts Storybook v6 stories.json (field: `stories`) and v7-9 index.json
 * (field: `entries`). Groups by `title`, skips docs entries, derives component
 * name from the last `/` segment and category from the rest.
 */

/**
 * parseStorybookIndex(jsonText) → { tokens, meta }
 * tokens: all-empty normalized shape
 * meta.components: [{name, category, title, importPath, variants,
 *                    stories: [{id, name, importPath}]}]
 * `variants` stays a plain string array (existing consumers depend on it);
 * `stories` carries the stable story ids (`component-name--story-name`) and
 * import paths the Figma↔Storybook mapping needs.
 */
export function parseStorybookIndex(jsonText) {
  let doc;
  try {
    doc = parseBoundedJson(jsonText, { role: 'storybook-index', limits: workspaceIO().limits });
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }

  // Support v7-9 `entries` and v6 `stories`
  const entries = doc.entries ?? doc.stories ?? {};

  // Group by title, preserving insertion order
  const groups = new Map(); // title → { name, category, title, importPath, variants[], stories[] }
  for (const entry of Object.values(entries)) {
    // Skip docs entries
    if (entry.type === 'docs') continue;

    const title = entry.title ?? entry.kind ?? '';
    if (!groups.has(title)) {
      const segments = title.split('/');
      const name = segments[segments.length - 1].trim();
      const category = segments.length > 1 ? segments.slice(0, -1).join('/').trim() : undefined;
      groups.set(title, { name, category, title, importPath: entry.importPath, variants: [], stories: [] });
    }
    const group = groups.get(title);
    if (!group.importPath && entry.importPath) group.importPath = entry.importPath;
    if (entry.name) {
      group.variants.push(entry.name);
      group.stories.push({ id: entry.id, name: entry.name, importPath: entry.importPath });
    }
  }

  const components = [...groups.values()];

  return {
    tokens: {
      color: {},
      typography: {},
      radius: {},
      spacing: {},
      shadow: {},
      fonts: [],
    },
    meta: {
      source: 'Storybook',
      components,
    },
  };
}

/**
 * fetchStorybookIndex(urlOrDir) → Promise<string>
 * URL: fetches /index.json (5s timeout), falls back to /stories.json on 404.
 * Directory: reads <dir>/index.json or <dir>/storybook-static/index.json.
 * Returns raw JSON text.
 */
export async function fetchStorybookIndex(urlOrDir) {
  if (/^https?:\/\//.test(urlOrDir)) {
    return fetchFromUrl(urlOrDir);
  }
  return readFromDir(urlOrDir);
}

async function fetchFromUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');

  const tryFetch = async (url) => {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw new Error(`Could not reach Storybook at ${baseUrl} — is it running? (${err.message})`);
    }
    return res;
  };

  let res = await tryFetch(`${base}/index.json`);
  if (res.status === 404) {
    res = await tryFetch(`${base}/stories.json`);
  }
  if (!res.ok) {
    throw new Error(`Could not reach Storybook at ${baseUrl} — server returned ${res.status}`);
  }
  return readBoundedResponseText(res, workspaceIO().limits.jsonBytes);
}

export async function readBoundedResponseText(res, limit) {
  const advertised = Number(res.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    throw new Error(`Storybook index exceeds ${limit} bytes.`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error(`Storybook index exceeds ${limit} bytes.`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function readFromDir(dir) {
  const { join } = await import('node:path');

  const candidates = [
    join(dir, 'index.json'),
    join(dir, 'storybook-static', 'index.json'),
  ];

  for (const candidate of candidates) {
    try { return workspaceIO().readText(candidate, { role: 'storybook-index' }); }
    catch { /* try the next conventional index location */ }
  }

  throw new Error(
    `Could not find Storybook index in directory "${dir}". Tried:\n` +
    candidates.map(c => `  ${c}`).join('\n')
  );
}
import { parseBoundedJson, workspaceIO } from '../lib/workspace-io.js';
