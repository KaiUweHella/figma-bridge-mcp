const ANNOTATION_COLORS = Object.freeze(['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'teal', 'green']);

function parseProperties(raw) {
  if (raw === undefined) return undefined;
  const values = String(raw).split(',').map((value) => value.trim()).filter(Boolean);
  return values.map((type) => ({ type }));
}

function annotationHelpersCode() {
  return `const __resolveCategory = async (query) => {
  if (!query) return null;
  const direct = await figma.annotations.getAnnotationCategoryByIdAsync(query);
  if (direct) return direct;
  const categories = await figma.annotations.getAnnotationCategoriesAsync();
  const exact = categories.filter(c => c.label === query);
  const matches = exact.length ? exact : categories.filter(c => c.label.toLowerCase().includes(String(query).toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous annotation category: ' + query);
  if (!matches.length) throw new Error('Annotation category not found: ' + query);
  return matches[0];
};
const __copyAnnotation = (a) => ({ ...(a.labelMarkdown ? { labelMarkdown: a.labelMarkdown } : a.label ? { label: a.label } : {}), ...(a.categoryId ? { categoryId: a.categoryId } : {}), ...(a.properties ? { properties: Array.from(a.properties, p => ({ type: p.type })) } : {}) });`;
}

function annotationAddCode({ nodeId, text, markdown = false, category = null, properties }) {
  const parsedProperties = parseProperties(properties);
  return `(async () => {${annotationHelpersCode()}
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
if (!('annotations' in node)) throw new Error(node.type + ' does not support annotations');
const category = await __resolveCategory(${JSON.stringify(category)});
const annotation = { ${markdown ? 'labelMarkdown' : 'label'}: ${JSON.stringify(String(text))}${category ? '' : ''}${category !== null ? `, ...(category ? { categoryId: category.id } : {})` : ''}${parsedProperties !== undefined ? `, properties: ${JSON.stringify(parsedProperties)}` : ''} };
node.annotations = [...(node.annotations || []).map(__copyAnnotation), annotation];
return { id: node.id, name: node.name, index: node.annotations.length - 1, annotation };
})()`;
}

function annotationEditCode({ nodeId, index, text, markdown = false, category, properties }) {
  const normalizedIndex = Number(index);
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) throw new Error('Annotation index must be a zero-based integer');
  const parsedProperties = parseProperties(properties);
  if (text === undefined && category === undefined && parsedProperties === undefined) throw new Error('Provide --text, --category, or --properties');
  return `(async () => {${annotationHelpersCode()}
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
if (!('annotations' in node)) throw new Error(node.type + ' does not support annotations');
const annotations = (node.annotations || []).map(__copyAnnotation);
if (${normalizedIndex} >= annotations.length) throw new Error('Annotation index out of range: ${normalizedIndex}');
const next = annotations[${normalizedIndex}];
${text === undefined ? '' : `delete next.label; delete next.labelMarkdown; next.${markdown ? 'labelMarkdown' : 'label'} = ${JSON.stringify(String(text))};`}
${category === undefined ? '' : `if (${JSON.stringify(category)} === '') delete next.categoryId; else next.categoryId = (await __resolveCategory(${JSON.stringify(category)})).id;`}
${parsedProperties === undefined ? '' : `next.properties = ${JSON.stringify(parsedProperties)};`}
node.annotations = annotations;
return { id: node.id, name: node.name, index: ${normalizedIndex}, annotation: next };
})()`;
}

function annotationRemoveCode({ nodeId, index }) {
  const normalizedIndex = Number(index);
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0) throw new Error('Annotation index must be a zero-based integer');
  return `(async () => {${annotationHelpersCode()}
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node) throw new Error('Node not found: ${String(nodeId)}');
if (!('annotations' in node)) throw new Error(node.type + ' does not support annotations');
const annotations = (node.annotations || []).map(__copyAnnotation);
if (${normalizedIndex} >= annotations.length) throw new Error('Annotation index out of range: ${normalizedIndex}');
const removed = annotations.splice(${normalizedIndex}, 1)[0]; node.annotations = annotations;
return { id: node.id, name: node.name, index: ${normalizedIndex}, removed };
})()`;
}

function annotationCategoriesCode() {
  return `(async () => (await figma.annotations.getAnnotationCategoriesAsync()).map(c => ({ id: c.id, label: c.label, color: c.color, isPreset: c.isPreset })))()`;
}

function annotationCategoryCreateCode({ label, color }) {
  const normalizedColor = String(color || '').toLowerCase();
  if (!ANNOTATION_COLORS.includes(normalizedColor)) throw new Error(`Category color must be one of: ${ANNOTATION_COLORS.join(', ')}`);
  return `(async () => { const c = await figma.annotations.addAnnotationCategoryAsync({ label: ${JSON.stringify(String(label))}, color: ${JSON.stringify(normalizedColor)} }); return { id: c.id, label: c.label, color: c.color, isPreset: c.isPreset }; })()`;
}

function annotationCategoryEditCode({ category, label, color }) {
  if (label === undefined && color === undefined) throw new Error('Provide --label or --color');
  if (color !== undefined && !ANNOTATION_COLORS.includes(String(color).toLowerCase())) throw new Error(`Category color must be one of: ${ANNOTATION_COLORS.join(', ')}`);
  return `(async () => {${annotationHelpersCode()} const c = await __resolveCategory(${JSON.stringify(category)}); if (c.isPreset) throw new Error('Preset annotation categories cannot be edited'); ${label === undefined ? '' : `c.setLabel(${JSON.stringify(String(label))});`} ${color === undefined ? '' : `c.setColor(${JSON.stringify(String(color).toLowerCase())});`} return { id: c.id, label: c.label, color: c.color, isPreset: c.isPreset }; })()`;
}

function annotationCategoryRemoveCode({ category }) {
  return `(async () => {${annotationHelpersCode()} const c = await __resolveCategory(${JSON.stringify(category)}); if (c.isPreset) throw new Error('Preset annotation categories cannot be removed'); const out = { id: c.id, label: c.label, color: c.color }; c.remove(); return out; })()`;
}

export {
  ANNOTATION_COLORS, annotationAddCode, annotationCategoriesCode,
  annotationCategoryCreateCode, annotationCategoryEditCode, annotationCategoryRemoveCode,
  annotationEditCode, annotationRemoveCode, parseProperties,
};
