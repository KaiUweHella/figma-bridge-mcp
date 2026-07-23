/**
 * Storybook index parser.
 * Accepts Storybook v6 stories.json (field: `stories`) and v7-9 index.json
 * (field: `entries`). Groups by `title`, skips docs entries, derives component
 * name from the last `/` segment and category from the rest.
 */

/**
 * parseStorybookIndex(jsonText) → { tokens, meta }
 * tokens: all-empty normalized shape
 * meta.components: [{name, category, variants}]
 */
export function parseStorybookIndex(jsonText) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }

  // Support v7-9 `entries` and v6 `stories`
  const entries = doc.entries ?? doc.stories ?? {};

  // Group by title, preserving insertion order
  const groups = new Map(); // title → { name, category, variants[] }
  for (const entry of Object.values(entries)) {
    // Skip docs entries
    if (entry.type === 'docs') continue;

    const title = entry.title ?? entry.kind ?? '';
    if (!groups.has(title)) {
      const segments = title.split('/');
      const name = segments[segments.length - 1].trim();
      const category = segments.length > 1 ? segments.slice(0, -1).join('/').trim() : undefined;
      groups.set(title, { name, category, variants: [] });
    }
    if (entry.name) {
      groups.get(title).variants.push(entry.name);
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
  return res.text();
}

async function readFromDir(dir) {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const candidates = [
    join(dir, 'index.json'),
    join(dir, 'storybook-static', 'index.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8');
    }
  }

  throw new Error(
    `Could not find Storybook index in directory "${dir}". Tried:\n` +
    candidates.map(c => `  ${c}`).join('\n')
  );
}
