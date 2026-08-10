const SLOT_SETTING_FIELDS = Object.freeze([
  'stretchChildOnInsert', 'displayEmptyByDefault', 'minChildren', 'maxChildren', 'allowPreferredValuesOnly',
]);

function parseObject(raw, label) {
  if (raw === undefined) return undefined;
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid ${label} JSON: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object`);
  return value;
}

function parseSlotSettings(raw) {
  const settings = parseObject(raw, 'slot settings');
  if (settings === undefined) return undefined;
  const unknown = Object.keys(settings).filter((key) => !SLOT_SETTING_FIELDS.includes(key));
  if (unknown.length) throw new Error(`Unknown slot settings: ${unknown.join(', ')}`);
  for (const key of ['stretchChildOnInsert', 'displayEmptyByDefault', 'allowPreferredValuesOnly']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  for (const key of ['minChildren', 'maxChildren']) {
    if (settings[key] !== undefined && settings[key] !== null && (!Number.isInteger(settings[key]) || settings[key] < 0)) throw new Error(`${key} must be a non-negative integer or null`);
  }
  if (settings.minChildren != null && settings.maxChildren != null && settings.minChildren > settings.maxChildren) throw new Error('minChildren must be <= maxChildren');
  return settings;
}

function parsePreferredValues(raw) {
  if (raw === undefined) return undefined;
  let values;
  try { values = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw new Error(`Invalid preferred values JSON: ${error.message}`); }
  if (!Array.isArray(values) || values.some((value) => !value || !['COMPONENT', 'COMPONENT_SET'].includes(value.type) || typeof value.key !== 'string')) {
    throw new Error('Preferred values must be [{"type":"COMPONENT|COMPONENT_SET","key":"..."}]');
  }
  return values;
}

function slotCreateCode({ componentId, name, settings, preferredValues, description }) {
  const parsedSettings = parseSlotSettings(settings);
  const parsedPreferred = parsePreferredValues(preferredValues);
  return `(async () => {
const component = await figma.getNodeByIdAsync(${JSON.stringify(componentId)});
if (!component || component.type !== 'COMPONENT') throw new Error('Local component not found: ${String(componentId)}');
if (component.remote) throw new Error('Remote components cannot be changed');
if (typeof component.createSlot !== 'function') throw new Error('Slots are unavailable in this Figma editor');
const before = new Set(Object.keys(component.componentPropertyDefinitions || {}));
const slot = component.createSlot(); slot.name = ${JSON.stringify(String(name))};
const definitions = component.componentPropertyDefinitions || {};
const propertyName = Object.keys(definitions).find(key => !before.has(key) && definitions[key].type === 'SLOT') || null;
if (propertyName && (${JSON.stringify(parsedSettings !== undefined || parsedPreferred !== undefined || description !== undefined)})) {
  component.editComponentProperty(propertyName, { ${parsedSettings === undefined ? '' : `slotSettings: ${JSON.stringify(parsedSettings)},`}${parsedPreferred === undefined ? '' : `preferredValues: ${JSON.stringify(parsedPreferred)},`}${description === undefined ? '' : `description: ${JSON.stringify(String(description))},`} name: ${JSON.stringify(String(name))} });
}
return { component: { id: component.id, name: component.name }, slot: { id: slot.id, name: slot.name, limitViolations: slot.limitViolations || [] }, propertyName, definition: propertyName ? component.componentPropertyDefinitions[propertyName] : null };
})()`;
}

function slotEditCode({ componentId, propertyName, name, settings, preferredValues, description }) {
  const parsedSettings = parseSlotSettings(settings);
  const parsedPreferred = parsePreferredValues(preferredValues);
  if ([name, parsedSettings, parsedPreferred, description].every((value) => value === undefined)) throw new Error('Provide --name, --settings, --preferred, or --description');
  const update = { ...(name !== undefined ? { name: String(name) } : {}), ...(parsedSettings !== undefined ? { slotSettings: parsedSettings } : {}), ...(parsedPreferred !== undefined ? { preferredValues: parsedPreferred } : {}), ...(description !== undefined ? { description: String(description) } : {}) };
  return `(async () => { const component = await figma.getNodeByIdAsync(${JSON.stringify(componentId)}); if (!component || !('componentPropertyDefinitions' in component)) throw new Error('Component not found: ${String(componentId)}'); const def = component.componentPropertyDefinitions[${JSON.stringify(propertyName)}]; if (!def || def.type !== 'SLOT') throw new Error('Slot property not found: ${String(propertyName)}'); const nextName = component.editComponentProperty(${JSON.stringify(propertyName)}, ${JSON.stringify(update)}); return { component: { id: component.id, name: component.name }, propertyName: nextName, definition: component.componentPropertyDefinitions[nextName] }; })()`;
}

function slotInspectCode({ nodeId }) {
  return `(async () => { const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); if (!node) throw new Error('Node not found: ${String(nodeId)}'); if (node.type === 'SLOT') return { id: node.id, name: node.name, type: node.type, childCount: node.children.length, limitViolations: node.limitViolations || [] }; if ('componentPropertyDefinitions' in node) return { id: node.id, name: node.name, type: node.type, slots: Object.entries(node.componentPropertyDefinitions).filter(([, d]) => d.type === 'SLOT').map(([name, definition]) => ({ name, definition })) }; throw new Error(node.type + ' is neither a slot nor a component'); })()`;
}

function slotResetCode({ nodeId }) {
  return `(async () => { const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); if (!node || node.type !== 'SLOT') throw new Error('Slot not found: ${String(nodeId)}'); if (typeof node.resetSlot !== 'function') throw new Error('Slot reset is unavailable'); const before = { childCount: node.children.length, limitViolations: node.limitViolations || [] }; node.resetSlot(); return { id: node.id, name: node.name, before, after: { childCount: node.children.length, limitViolations: node.limitViolations || [] } }; })()`;
}

function slotValidateCode({ nodeId = null } = {}) {
  return `(async () => { const root = ${nodeId ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})` : 'figma.currentPage'}; if (!root) throw new Error('Node not found: ${String(nodeId)}'); const slots = root.type === 'SLOT' ? [root] : (typeof root.findAll === 'function' ? root.findAll(n => n.type === 'SLOT') : []); const results = slots.map(node => ({ id: node.id, name: node.name, childCount: node.children.length, limitViolations: node.limitViolations || [] })); return { valid: results.every(result => result.limitViolations.length === 0), slots: results }; })()`;
}

export {
  SLOT_SETTING_FIELDS, parsePreferredValues, parseSlotSettings, slotCreateCode,
  slotEditCode, slotInspectCode, slotResetCode, slotValidateCode,
};
