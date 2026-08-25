// Bounded Component Inventory seam shared by component listing, Storybook
// mapping and post-render reuse advice. The Plugin and host validate the same
// compact facts; an exceeded bound fails instead of returning a partial list.

import { Buffer } from 'node:buffer';

export const COMPONENT_INVENTORY_SCHEMA_VERSION = 1;
export const MAX_COMPONENT_INVENTORY_PAGES = 2_000;
export const MAX_COMPONENT_INVENTORY_VISITS = 250_000;
export const MAX_COMPONENT_INVENTORY_SETS = 5_000;
export const MAX_COMPONENT_INVENTORY_VARIANTS = 50_000;
export const MAX_COMPONENT_INVENTORY_VARIANTS_PER_SET = 2_048;
export const MAX_COMPONENT_INVENTORY_STANDALONES = 50_000;
export const MAX_COMPONENT_INVENTORY_AXES_PER_SET = 64;
export const MAX_COMPONENT_INVENTORY_AXIS_VALUES = 8_192;
export const MAX_COMPONENT_INVENTORY_AXIS_VALUES_PER_AXIS = 256;
export const MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS = 512;
export const MAX_COMPONENT_INVENTORY_KEY_CODE_UNITS = 256;
export const MAX_COMPONENT_INVENTORY_ID_CODE_UNITS = 96;
export const MAX_COMPONENT_INVENTORY_SERIALIZED_BYTES = 2_000_000;

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

/**
 * Eval code for a complete bounded component inventory. Stable publish keys
 * remain the mapping identity; node ids remain file-local handles.
 */
export function componentInventoryCode(allPages) {
  return `(async () => {
    ${allPages ? 'await figma.loadAllPagesAsync();' : ''}
    const schemaVersion = ${COMPONENT_INVENTORY_SCHEMA_VERSION};
    const scope = ${allPages ? "'ALL_PAGES'" : "'CURRENT_PAGE'"};
    const pages = ${allPages ? 'figma.root.children' : '[figma.currentPage]'};
    const sets = [];
    const singles = [];
    let visited = 0;
    let variantCount = 0;
    let axisValueCount = 0;
    const unsafeText = /[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/;
    const fail = (what, recovery) => {
      throw new Error('Component Inventory ' + what + ' limit exceeded.'
        + (recovery ? ' ' + recovery : ' Narrow the scan to the current page.'));
    };
    const text = (value, label, maximum, allowEmpty = true) => {
      if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.length)) {
        throw new Error('Component Inventory encountered an invalid or oversized ' + label + '.');
      }
      if (unsafeText.test(value)) {
        throw new Error('Component Inventory ' + label + ' contains unsupported control or Bidi characters.');
      }
      return value;
    };
    const id = (value, label = 'node id') => text(value, label, ${MAX_COMPONENT_INVENTORY_ID_CODE_UNITS}, false);
    const name = (value, label = 'name') => text(value, label, ${MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS});
    const safeKey = (node) => {
      let value = null;
      try { value = node.key || null; } catch {}
      return value === null ? null : text(value, 'publish key', ${MAX_COMPONENT_INVENTORY_KEY_CODE_UNITS}, false);
    };
    const axes = (value) => {
      if (value == null) return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Component Inventory encountered invalid variant axes.');
      }
      const entries = Object.entries(value);
      if (entries.length > ${MAX_COMPONENT_INVENTORY_AXES_PER_SET}) fail('variant-axis');
      const projected = Object.create(null);
      for (const [axisName, definition] of entries) {
        const safeAxis = name(axisName, 'variant-axis name');
        if (!definition || typeof definition !== 'object' || !Array.isArray(definition.values)) {
          throw new Error('Component Inventory encountered an invalid variant axis.');
        }
        if (definition.values.length > ${MAX_COMPONENT_INVENTORY_AXIS_VALUES_PER_AXIS}) fail('per-axis value');
        axisValueCount += definition.values.length;
        if (axisValueCount > ${MAX_COMPONENT_INVENTORY_AXIS_VALUES}) fail('axis-value');
        projected[safeAxis] = {
          values: definition.values.map((item) => name(item, 'variant-axis value')),
        };
      }
      return projected;
    };
    if (!pages || pages.length > ${MAX_COMPONENT_INVENTORY_PAGES}) {
      fail('page', 'Open a smaller library file or scan only the current page.');
    }
    for (const page of pages) {
      const pageName = name(page.name, 'page name');
      const stack = Array.from(page.children || []).reverse();
      while (stack.length) {
        const node = stack.pop();
        visited++;
        if (visited > ${MAX_COMPONENT_INVENTORY_VISITS}) {
          fail('visit', 'Re-run component list without --all-pages or map storybook with --current-page.');
        }
        if (node.type === 'COMPONENT_SET') {
          if (sets.length >= ${MAX_COMPONENT_INVENTORY_SETS}) fail('component-set');
          const children = Array.from(node.children || []);
          if (children.length > ${MAX_COMPONENT_INVENTORY_VARIANTS_PER_SET}) fail('variants-per-set');
          variantCount += children.length;
          visited += children.length;
          if (variantCount > ${MAX_COMPONENT_INVENTORY_VARIANTS}) fail('variant');
          if (visited > ${MAX_COMPONENT_INVENTORY_VISITS}) fail('visit');
          const variants = children.map((child) => {
            if (child.type !== 'COMPONENT') {
              throw new Error('Component Inventory encountered a non-component variant child.');
            }
            return { id: id(child.id), name: name(child.name), key: safeKey(child) };
          });
          let defaultVariantId = null;
          try { defaultVariantId = (node.defaultVariant || children[0] || {}).id || null; } catch {}
          if (defaultVariantId !== null) defaultVariantId = id(defaultVariantId, 'default variant id');
          let rawAxes = null;
          try { rawAxes = node.variantGroupProperties; } catch {}
          sets.push({
            id: id(node.id), name: name(node.name), page: pageName,
            key: safeKey(node), defaultVariantId, variantAxes: axes(rawAxes), variants,
          });
          continue;
        }
        if (node.type === 'COMPONENT') {
          if (singles.length >= ${MAX_COMPONENT_INVENTORY_STANDALONES}) fail('standalone-component');
          singles.push({ id: id(node.id), name: name(node.name), page: pageName, key: safeKey(node) });
        }
        if ('children' in node) {
          const children = Array.from(node.children || []);
          for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
      }
    }
    const payload = {
      schemaVersion, scope, visited, pagesScanned: pages.length,
      fileName: name(figma.root.name, 'file name'),
      componentSets: sets, standaloneComponents: singles,
    };
    const serialized = JSON.stringify(payload);
    let bytes = 0;
    for (let index = 0; index < serialized.length; index++) {
      const code = serialized.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < serialized.length
        && serialized.charCodeAt(index + 1) >= 0xdc00 && serialized.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4; index++;
      } else bytes += 3;
      if (bytes > ${MAX_COMPONENT_INVENTORY_SERIALIZED_BYTES}) {
        fail('serialized-result', 'Re-run against the current page.');
      }
    }
    return JSON.parse(serialized);
  })()`;
}

/** Cached form for advisory reuse checks. Only already validated, bounded
 * payloads reach the cache; mutations invalidate it elsewhere. */
export function cachedInventoryCode(allPages, ttlMs = 60_000) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > 600_000) {
    throw new TypeError('Component Inventory cache TTL must be between 0 and 600000ms.');
  }
  return `(async () => {
    const now = Date.now();
    const c = globalThis.__invCache;
    if (c && c.schemaVersion === ${COMPONENT_INVENTORY_SCHEMA_VERSION}
      && c.allPages === ${Boolean(allPages)} && (now - c.at) < ${Math.floor(ttl)}) return c.data;
    const data = await ${componentInventoryCode(Boolean(allPages))};
    globalThis.__invCache = {
      schemaVersion: ${COMPONENT_INVENTORY_SCHEMA_VERSION},
      at: now, allPages: ${Boolean(allPages)}, data,
    };
    return data;
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validText(value, maximum, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT.test(value);
}

function validKey(value) {
  return value === null || validText(value, MAX_COMPONENT_INVENTORY_KEY_CODE_UNITS, { empty: false });
}

function validIdentity(value, { page = false } = {}) {
  const keys = page ? ['id', 'name', 'page', 'key'] : ['id', 'name', 'key'];
  return exactKeys(value, keys)
    && validText(value.id, MAX_COMPONENT_INVENTORY_ID_CODE_UNITS, { empty: false })
    && validText(value.name, MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS)
    && (!page || validText(value.page, MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS))
    && validKey(value.key);
}

function validAxes(value, state) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_COMPONENT_INVENTORY_AXES_PER_SET) return false;
  for (const [name, definition] of entries) {
    if (!validText(name, MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS)
      || !exactKeys(definition, ['values'])
      || !Array.isArray(definition.values)
      || definition.values.length > MAX_COMPONENT_INVENTORY_AXIS_VALUES_PER_AXIS
      || !definition.values.every((item) => validText(item, MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS))) return false;
    state.axisValues += definition.values.length;
    if (state.axisValues > MAX_COMPONENT_INVENTORY_AXIS_VALUES) return false;
  }
  return true;
}

function validSet(value, state) {
  if (!exactKeys(value, [
    'id', 'name', 'page', 'key', 'defaultVariantId', 'variantAxes', 'variants',
  ]) || !validIdentity({ id: value.id, name: value.name, page: value.page, key: value.key }, { page: true })
    || !(value.defaultVariantId === null
      || validText(value.defaultVariantId, MAX_COMPONENT_INVENTORY_ID_CODE_UNITS, { empty: false }))
    || !Array.isArray(value.variants)
    || value.variants.length > MAX_COMPONENT_INVENTORY_VARIANTS_PER_SET
    || !value.variants.every((variant) => validIdentity(variant))
    || !validAxes(value.variantAxes, state)) return false;
  state.variants += value.variants.length;
  if (state.variants > MAX_COMPONENT_INVENTORY_VARIANTS) return false;
  const ids = value.variants.map((variant) => variant.id);
  if (new Set(ids).size !== ids.length) return false;
  return value.defaultVariantId === null
    ? ids.length === 0
    : ids.filter((id) => id === value.defaultVariantId).length === 1;
}

/** Validate the untrusted Plugin response before callers list, map or lint it. */
export function projectComponentInventory(value) {
  const validEnvelope = exactKeys(value, [
    'schemaVersion', 'scope', 'visited', 'pagesScanned', 'fileName',
    'componentSets', 'standaloneComponents',
  ]) && value.schemaVersion === COMPONENT_INVENTORY_SCHEMA_VERSION
    && ['CURRENT_PAGE', 'ALL_PAGES'].includes(value.scope)
    && Number.isInteger(value.visited) && value.visited >= 0
    && value.visited <= MAX_COMPONENT_INVENTORY_VISITS
    && Number.isInteger(value.pagesScanned) && value.pagesScanned >= 1
    && value.pagesScanned <= MAX_COMPONENT_INVENTORY_PAGES
    && validText(value.fileName, MAX_COMPONENT_INVENTORY_NAME_CODE_UNITS)
    && Array.isArray(value.componentSets)
    && value.componentSets.length <= MAX_COMPONENT_INVENTORY_SETS
    && Array.isArray(value.standaloneComponents)
    && value.standaloneComponents.length <= MAX_COMPONENT_INVENTORY_STANDALONES;
  if (!validEnvelope) {
    throw new Error('Component Inventory returned an invalid bounded result. Reload the current Bridge Plugin and retry.');
  }
  const state = { variants: 0, axisValues: 0 };
  if (!value.componentSets.every((set) => validSet(set, state))
    || !value.standaloneComponents.every((item) => validIdentity(item, { page: true }))) {
    throw new Error('Component Inventory returned invalid or oversized component facts. Narrow the scan to the current page.');
  }
  const ids = [
    ...value.componentSets.map((set) => set.id),
    ...value.componentSets.flatMap((set) => set.variants.map((variant) => variant.id)),
    ...value.standaloneComponents.map((item) => item.id),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new Error('Component Inventory returned duplicate component identities.');
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch {}
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_COMPONENT_INVENTORY_SERIALIZED_BYTES) {
    throw new Error('Component Inventory returned an oversized serialized result. Narrow the scan to the current page.');
  }
  return value;
}
