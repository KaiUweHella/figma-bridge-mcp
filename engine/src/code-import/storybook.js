/**
 * Storybook index parser.
 * Accepts Storybook v6 stories.json (field: `stories`) and v7-9 index.json
 * (field: `entries`). Groups by `title`, skips docs entries, derives component
 * name from the last `/` segment and category from the rest.
 */
import { fetchRemoteStorybookIndex, STORYBOOK_REMOTE_LIMITS } from './storybook-remote.js';
import { parseBoundedJson, workspaceIO } from '../lib/workspace-io.js';

/**
 * parseStorybookIndex(jsonText) → { tokens, meta }
 * tokens: all-empty normalized shape
 * meta.components: [{name, category, title, importPath, variants,
 *                    stories: [{id, name, importPath}]}]
 * `variants` stays a plain string array (existing consumers depend on it);
 * `stories` carries the stable story ids (`component-name--story-name`) and
 * import paths the Figma↔Storybook mapping needs.
 */
export function parseStorybookIndex(jsonText, { limits = workspaceIO().limits } = {}) {
  let doc;
  try {
    doc = parseBoundedJson(jsonText, { role: 'storybook-index', limits });
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
 * URL: applies the Remote Storybook Policy, fetches /index.json, and falls
 * back to /stories.json on 404.
 * Directory: reads <dir>/index.json or <dir>/storybook-static/index.json.
 * Returns raw JSON text.
 * @param {string} urlOrDir
 * @param {{workspaceIO?: object}} [options]
 */
export async function fetchStorybookIndex(urlOrDir, {
  workspaceIO: sourceIO = workspaceIO(),
} = {}) {
  if (/^https?:\/\//i.test(urlOrDir)) {
    return fetchRemoteStorybookIndex(urlOrDir, {
      limits: {
        ...STORYBOOK_REMOTE_LIMITS,
        maxBytes: sourceIO.limits.jsonBytes,
      },
    });
  }
  return readFromDir(urlOrDir, sourceIO);
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

async function readFromDir(dir, sourceIO) {
  const { join } = await import('node:path');

  const candidates = [
    join(dir, 'index.json'),
    join(dir, 'storybook-static', 'index.json'),
  ];

  for (const candidate of candidates) {
    try { return sourceIO.readText(candidate, { role: 'storybook-index' }); }
    catch { /* try the next conventional index location */ }
  }

  throw new Error(
    'Could not find a Storybook index in the approved directory. ' +
    'Expected index.json or storybook-static/index.json.',
  );
}
