const VARIABLE_TYPES = Object.freeze(['BOOLEAN', 'COLOR', 'EASING', 'FLOAT', 'STRING', 'TIMING']);

function parseLibraryVariableType(value) {
  if (value === undefined || value === null || value === '') return null;
  const type = String(value).trim().toUpperCase();
  if (!VARIABLE_TYPES.includes(type)) {
    throw new Error(`Library variable type must be one of: ${VARIABLE_TYPES.join(', ')}`);
  }
  return type;
}

function requirePublishKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('A non-empty published library key is required');
  return key;
}

function libraryCollectionHelpersCode() {
  return `
const __libraryCall = (operation, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(
    'Figma team-library ' + label + ' did not respond within 18s. Confirm the library is enabled in this file, then retry.'
  )), 18000);
  Promise.resolve().then(operation).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); },
  );
});
const __libraryCollections = await __libraryCall(
  () => figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(),
  'collection discovery',
);
const __resolveLibraryCollection = (query) => {
  const exact = __libraryCollections.filter(c => c.key === query || c.name === query);
  const matches = exact.length ? exact : __libraryCollections.filter(c =>
    c.name.toLowerCase().includes(String(query).toLowerCase()) ||
    c.libraryName.toLowerCase().includes(String(query).toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous library collection "' + query + '": ' + matches.map(c => c.libraryName + '/' + c.name).join(', '));
  if (!matches.length) throw new Error('Enabled library variable collection not found: ' + query + '. Enable its library in the Figma UI first.');
  return matches[0];
};`;
}

function libraryCollectionsCode() {
  return `(async () => {${libraryCollectionHelpersCode()}
return __libraryCollections
  .map(c => ({ key: c.key, name: c.name, libraryName: c.libraryName }))
  .sort((a, b) => a.libraryName.localeCompare(b.libraryName) || a.name.localeCompare(b.name));
})()`;
}

function libraryVariablesCode({ collection, type = null }) {
  const normalizedType = parseLibraryVariableType(type);
  return `(async () => {${libraryCollectionHelpersCode()}
const selected = __resolveLibraryCollection(${JSON.stringify(String(collection))});
let variables = await __libraryCall(
  () => figma.teamLibrary.getVariablesInLibraryCollectionAsync(selected.key),
  'variable discovery for ' + selected.libraryName + '/' + selected.name,
);
${normalizedType ? `variables = variables.filter(v => v.resolvedType === ${JSON.stringify(normalizedType)});` : ''}
return {
  collection: { key: selected.key, name: selected.name, libraryName: selected.libraryName },
  variables: variables.map(v => ({ key: v.key, name: v.name, resolvedType: v.resolvedType }))
    .sort((a, b) => a.name.localeCompare(b.name)),
};
})()`;
}

function importVariableCode({ key }) {
  const normalized = requirePublishKey(key);
  return `(async () => {
const variable = await figma.variables.importVariableByKeyAsync(${JSON.stringify(normalized)});
const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
return {
  kind: 'VARIABLE', id: variable.id, key: variable.key, name: variable.name,
  resolvedType: variable.resolvedType, remote: !!variable.remote,
  collection: collection ? { id: collection.id, key: collection.key, name: collection.name, remote: !!collection.remote } : null,
};
})()`;
}

function importStyleCode({ key }) {
  const normalized = requirePublishKey(key);
  return `(async () => {
const style = await figma.importStyleByKeyAsync(${JSON.stringify(normalized)});
return { kind: 'STYLE', id: style.id, key: style.key, name: style.name, type: style.type, remote: !!style.remote, description: style.description || '' };
})()`;
}

function importComponentCode({ key, set = false }) {
  const normalized = requirePublishKey(key);
  const method = set ? 'importComponentSetByKeyAsync' : 'importComponentByKeyAsync';
  return `(async () => {
const component = await figma.${method}(${JSON.stringify(normalized)});
return {
  kind: ${JSON.stringify(set ? 'COMPONENT_SET' : 'COMPONENT')}, id: component.id,
  key: component.key, name: component.name, type: component.type, remote: !!component.remote,
  description: component.description || '',
};
})()`;
}

export {
  VARIABLE_TYPES, importComponentCode, importStyleCode, importVariableCode,
  libraryCollectionsCode, libraryVariablesCode, parseLibraryVariableType,
  requirePublishKey,
};
