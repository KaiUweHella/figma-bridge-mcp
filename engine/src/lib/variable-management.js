const VARIABLE_SCOPES = Object.freeze([
  'ALL_SCOPES', 'TEXT_CONTENT', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP',
  'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR',
  'STROKE_FLOAT', 'EFFECT_FLOAT', 'EFFECT_COLOR', 'OPACITY', 'FONT_FAMILY',
  'FONT_STYLE', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT', 'LETTER_SPACING',
  'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
]);

function parseBoolean(value, label = 'value') {
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function parseScopes(value) {
  if (value === undefined) return undefined;
  const scopes = String(value).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  const invalid = scopes.filter((scope) => !VARIABLE_SCOPES.includes(scope));
  if (invalid.length) throw new Error(`Unknown variable scopes: ${invalid.join(', ')}`);
  return scopes;
}

function parseCodePlatform(value) {
  const key = String(value).trim().toLowerCase();
  const platform = { web: 'WEB', android: 'ANDROID', ios: 'iOS' }[key];
  if (!platform) throw new Error('Platform must be WEB, ANDROID, or iOS');
  return platform;
}

function variableHelpersCode() {
  return `
const __collections = await figma.variables.getLocalVariableCollectionsAsync();
const __allVars = await figma.variables.getLocalVariablesAsync();
const __resolveCollection = async (query) => {
  const direct = await figma.variables.getVariableCollectionByIdAsync(query);
  if (direct) return direct;
  const exact = __collections.filter(c => c.name === query);
  const matches = exact.length ? exact : __collections.filter(c => c.name.toLowerCase().includes(String(query).toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous collection "' + query + '": ' + matches.map(c => c.name).join(', '));
  if (!matches.length) throw new Error('Collection not found: ' + query);
  return matches[0];
};
const __resolveVariable = async (query, collectionHint) => {
  const direct = await figma.variables.getVariableByIdAsync(query);
  if (direct) {
    if (collectionHint) {
      const col = await __resolveCollection(collectionHint);
      if (direct.variableCollectionId !== col.id) throw new Error('Variable is not in collection: ' + collectionHint);
    }
    return direct;
  }
  let pool = __allVars;
  if (collectionHint) {
    const col = await __resolveCollection(collectionHint);
    pool = pool.filter(v => v.variableCollectionId === col.id);
  }
  const exact = pool.filter(v => v.name === query);
  const tail = pool.filter(v => v.name.endsWith('/' + query));
  const partial = pool.filter(v => v.name.toLowerCase().includes(String(query).toLowerCase()));
  const matches = exact.length ? exact : (tail.length ? tail : partial);
  if (matches.length > 1) throw new Error('Ambiguous variable "' + query + '": ' + matches.map(v => v.name).join(', '));
  if (!matches.length) throw new Error('Variable not found: ' + query);
  return matches[0];
};
const __resolveMode = (collection, query) => {
  const q = String(query);
  const exact = collection.modes.filter(m => m.modeId === q || m.name === q);
  const matches = exact.length ? exact : collection.modes.filter(m => m.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length > 1) throw new Error('Ambiguous mode "' + q + '": ' + matches.map(m => m.name).join(', '));
  if (!matches.length) throw new Error('Mode not found: ' + q);
  return matches[0];
};
const __collectionFacts = async (c) => ({
  id: c.id, key: c.key || null, name: c.name, remote: !!c.remote,
  isExtension: !!c.isExtension, hiddenFromPublishing: !!c.hiddenFromPublishing,
  defaultModeId: c.defaultModeId, modes: c.modes, variableIds: c.variableIds,
  publishStatus: await c.getPublishStatusAsync(),
});
const __variableFacts = async (v) => {
  const collection = __collections.find(c => c.id === v.variableCollectionId) || await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  return {
    id: v.id, key: v.key || null, name: v.name, description: v.description || '',
    resolvedType: v.resolvedType, remote: !!v.remote, variableCollectionId: v.variableCollectionId,
    collection: collection ? { id: collection.id, name: collection.name } : null,
    hiddenFromPublishing: !!v.hiddenFromPublishing, scopes: v.scopes,
    codeSyntax: v.codeSyntax, valuesByMode: v.valuesByMode,
    modes: collection ? collection.modes : [], publishStatus: await v.getPublishStatusAsync(),
  };
};`;
}

function variableShowCode({ variable, collection = null }) {
  return `(async () => {${variableHelpersCode()}
return __variableFacts(await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)}));
})()`;
}

function variableUpdateCode({ variable, collection = null, name, description, hidden, scopes }) {
  return `(async () => {${variableHelpersCode()}
const target = await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)});
if (target.remote) throw new Error('Remote variables cannot be updated');
${name === undefined ? '' : `target.name = ${JSON.stringify(String(name).trim())};`}
${description === undefined ? '' : `target.description = ${JSON.stringify(String(description))};`}
${hidden === undefined ? '' : `target.hiddenFromPublishing = ${parseBoolean(hidden, '--hidden')};`}
${scopes === undefined ? '' : `target.scopes = ${JSON.stringify(parseScopes(scopes))};`}
return __variableFacts(target);
})()`;
}

function variableSetValueCode({ variable, collection = null, mode, value, alias = null }) {
  return `(async () => {${variableHelpersCode()}
const target = await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)});
if (target.remote) throw new Error('Remote variables cannot be updated');
const col = await __resolveCollection(target.variableCollectionId);
const resolvedMode = __resolveMode(col, ${JSON.stringify(mode)});
let nextValue;
if (${JSON.stringify(alias)} !== null) {
  const aliasTarget = await __resolveVariable(${JSON.stringify(alias)}, null);
  if (aliasTarget.resolvedType !== target.resolvedType) throw new Error('Alias type ' + aliasTarget.resolvedType + ' does not match ' + target.resolvedType);
  nextValue = figma.variables.createVariableAlias(aliasTarget);
} else {
  const raw = ${JSON.stringify(value)};
  if (target.resolvedType === 'BOOLEAN') {
    if (!/^(true|false)$/i.test(raw)) throw new Error('BOOLEAN value must be true or false');
    nextValue = raw.toLowerCase() === 'true';
  } else if (target.resolvedType === 'FLOAT') {
    nextValue = Number(raw); if (!Number.isFinite(nextValue)) throw new Error('FLOAT value must be a finite number');
  } else if (target.resolvedType === 'COLOR') {
    const match = String(raw).match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!match) throw new Error('COLOR value must be #RGB, #RGBA, #RRGGBB, or #RRGGBBAA');
    let hex = match[1]; if (hex.length <= 4) hex = [...hex].map(c => c + c).join('');
    nextValue = { r: parseInt(hex.slice(0,2),16)/255, g: parseInt(hex.slice(2,4),16)/255, b: parseInt(hex.slice(4,6),16)/255 };
    if (hex.length === 8) nextValue.a = parseInt(hex.slice(6,8),16)/255;
  } else if (target.resolvedType === 'STRING') nextValue = raw;
  else {
    try { nextValue = JSON.parse(raw); } catch { throw new Error(target.resolvedType + ' value must be JSON'); }
  }
}
target.setValueForMode(resolvedMode.modeId, nextValue);
return { variable: await __variableFacts(target), mode: resolvedMode, value: target.valuesByMode[resolvedMode.modeId] };
})()`;
}

function variableCodeSyntaxCode({ variable, collection = null, platform, value, remove = false }) {
  const normalized = parseCodePlatform(platform);
  return `(async () => {${variableHelpersCode()}
const target = await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)});
if (target.remote) throw new Error('Remote variables cannot be updated');
${remove ? `target.removeVariableCodeSyntax(${JSON.stringify(normalized)});` : `target.setVariableCodeSyntax(${JSON.stringify(normalized)}, ${JSON.stringify(String(value))});`}
return __variableFacts(target);
})()`;
}

function variableResolveCode({ variable, collection = null, nodeId }) {
  return `(async () => {${variableHelpersCode()}
const target = await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)});
const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error('Scene node not found: ${String(nodeId)}');
return { variable: await __variableFacts(target), consumer: { id: node.id, name: node.name, type: node.type }, resolved: target.resolveForConsumer(node) };
})()`;
}

function variablePublishStatusCode({ variable, collection = null }) {
  return `(async () => {${variableHelpersCode()}
const target = await __resolveVariable(${JSON.stringify(variable)}, ${JSON.stringify(collection)});
return { id: target.id, name: target.name, publishStatus: await target.getPublishStatusAsync() };
})()`;
}

function collectionShowCode({ collection }) {
  return `(async () => {${variableHelpersCode()} return __collectionFacts(await __resolveCollection(${JSON.stringify(collection)})); })()`;
}

function collectionUpdateCode({ collection, name, hidden }) {
  return `(async () => {${variableHelpersCode()}
const target = await __resolveCollection(${JSON.stringify(collection)});
if (target.remote) throw new Error('Remote collections cannot be updated');
${name === undefined ? '' : `target.name = ${JSON.stringify(String(name).trim())};`}
${hidden === undefined ? '' : `target.hiddenFromPublishing = ${parseBoolean(hidden, '--hidden')};`}
return __collectionFacts(target);
})()`;
}

function collectionModeCode({ collection, action, mode, name }) {
  if (!['add', 'rename', 'remove'].includes(action)) throw new Error('Unknown mode action');
  return `(async () => {${variableHelpersCode()}
const target = await __resolveCollection(${JSON.stringify(collection)});
if (target.remote) throw new Error('Remote collections cannot be updated');
${action === 'add' ? `const modeId = target.addMode(${JSON.stringify(String(name).trim())});` : `const selected = __resolveMode(target, ${JSON.stringify(mode)}); ${action === 'rename' ? `target.renameMode(selected.modeId, ${JSON.stringify(String(name).trim())});` : 'target.removeMode(selected.modeId);'} `}
return __collectionFacts(target);
})()`;
}

function collectionPublishStatusCode({ collection }) {
  return `(async () => {${variableHelpersCode()} const target = await __resolveCollection(${JSON.stringify(collection)}); return { id: target.id, name: target.name, publishStatus: await target.getPublishStatusAsync() }; })()`;
}

function collectionExtendCode({ collection, name }) {
  const extensionName = String(name || '').trim();
  if (!extensionName) throw new Error('Extension name is required');
  return `(async () => {${variableHelpersCode()}
const query = ${JSON.stringify(collection)};
let target = null;
try { target = await __resolveCollection(query); } catch (error) {
  if (!/Collection not found/.test(String(error && error.message))) throw error;
}
let extended;
if (target) {
  if (target.remote) throw new Error('Use the published collection key to extend a library collection');
  if (typeof target.extend !== 'function') throw new Error('Collection extension is unavailable in this Figma editor');
  extended = target.extend(${JSON.stringify(extensionName)});
} else {
  if (typeof figma.variables.extendLibraryCollectionByKeyAsync !== 'function') throw new Error('Library collection extension is unavailable in this Figma editor');
  extended = await figma.variables.extendLibraryCollectionByKeyAsync(query, ${JSON.stringify(extensionName)});
}
return __collectionFacts(extended);
})()`;
}

export {
  VARIABLE_SCOPES, collectionExtendCode, collectionModeCode, collectionPublishStatusCode, collectionShowCode,
  collectionUpdateCode, parseBoolean, parseCodePlatform, parseScopes,
  variableCodeSyntaxCode, variablePublishStatusCode, variableResolveCode,
  variableSetValueCode, variableShowCode, variableUpdateCode,
};
