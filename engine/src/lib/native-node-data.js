// Native CSS facts exposed by the Figma Plugin API. getCSSAsync() deliberately
// uses the live plugin document and mirrors Figma's Inspect output.

export const MAX_NATIVE_CSS_PROPERTIES = 512;
export const MAX_NATIVE_CSS_PROPERTY_CODE_UNITS = 128;
export const MAX_NATIVE_CSS_VALUE_CODE_UNITS = 2048;
const NODE_ID_PATTERN = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const NODE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const CSS_PROPERTY_PATTERN = /^(?:--[a-zA-Z0-9_-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function nodeCssCode(nodeId) {
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!node) throw new Error('Node not found in the targeted Figma document: ' + ${JSON.stringify(nodeId)});
    if (typeof node.getCSSAsync !== 'function') {
      throw new Error('Node type ' + node.type + ' does not expose getCSSAsync().');
    }
    const css = await node.getCSSAsync();
    if (!css || typeof css !== 'object' || Array.isArray(css)) {
      throw new Error('Figma returned invalid native CSS data.');
    }
    const entries = Object.entries(css);
    if (entries.length > ${MAX_NATIVE_CSS_PROPERTIES}
      || entries.some(([property, value]) => typeof property !== 'string'
        || property.length === 0 || property.length > ${MAX_NATIVE_CSS_PROPERTY_CODE_UNITS}
        || typeof value !== 'string' || value.length > ${MAX_NATIVE_CSS_VALUE_CODE_UNITS})) {
      throw new Error('Figma native CSS exceeds the bounded result contract.');
    }
    return { id: node.id, name: node.name, type: node.type, css };
  })()`;
}

function validNodeCss(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.id !== 'string' || result.id.length > 96 || !NODE_ID_PATTERN.test(result.id)
    || typeof result.name !== 'string' || result.name.length > 512
    || typeof result.type !== 'string' || !NODE_TYPE_PATTERN.test(result.type)
    || !result.css || typeof result.css !== 'object' || Array.isArray(result.css)) return false;
  const entries = Object.entries(result.css);
  return entries.length <= MAX_NATIVE_CSS_PROPERTIES
    && entries.every(([property, value]) => property.length > 0
      && property.length <= MAX_NATIVE_CSS_PROPERTY_CODE_UNITS
      && CSS_PROPERTY_PATTERN.test(property)
      && typeof value === 'string' && value.length <= MAX_NATIVE_CSS_VALUE_CODE_UNITS);
}

export function formatNodeCss(result, { json = false } = {}) {
  if (!validNodeCss(result)) throw new Error('Figma returned invalid or unbounded native CSS data.');
  if (json) return JSON.stringify(result, null, 2);
  const safeName = (result.name || '(unnamed)')
    .replace(UNSAFE_TEXT_CONTROLS, ' ')
    .replaceAll('*/', '* /');
  const lines = [`/* ${safeName} (${result.id}) — ${result.type} */`];
  for (const [property, value] of Object.entries(result.css)) {
    lines.push(`${property}: ${value.replace(UNSAFE_TEXT_CONTROLS, ' ')};`);
  }
  return lines.join('\n');
}
