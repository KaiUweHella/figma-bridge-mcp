// Canonical closed Plugin operations that may bypass the mutation lane.
// The marked runtime is synchronized into plugin/code.js; no operation accepts
// generated JavaScript or another executable payload.

// BEGIN TYPED READ RUNTIME
export const TYPED_READ_CAPABILITY = 'typed-read-v1';
export const BRIDGE_HEALTH_TYPED_READ = 'bridge-health-v1';
export const STYLE_CONSUMERS_TYPED_READ = 'style-consumers-v1';
export const NODE_BINDINGS_TYPED_READ = 'node-bindings-v1';
export const TOKEN_OVERLAP_TYPED_READ = 'token-overlap-v1';
export const TYPED_READ_OPERATIONS = Object.freeze([
  BRIDGE_HEALTH_TYPED_READ,
  STYLE_CONSUMERS_TYPED_READ,
  NODE_BINDINGS_TYPED_READ,
  TOKEN_OVERLAP_TYPED_READ,
]);

function typedReadRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typedReadExactKeys(value, keys) {
  return typedReadRecord(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function typedReadAnchorError(value) {
  const fields = new Set([
    'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
    'effectStyleId', 'gridStyleId',
  ]);
  if (!typedReadExactKeys(value, ['nodeId', 'fields'])) return 'after must contain only nodeId and fields';
  if (typeof value.nodeId !== 'string' || value.nodeId.length < 1 || value.nodeId.length > 1024) {
    return 'after nodeId must contain 1-1024 code units';
  }
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > fields.size
    || value.fields.some((field) => !fields.has(field))
    || new Set(value.fields).size !== value.fields.length
    || value.fields.some((field, index) => index > 0 && value.fields[index - 1] >= field)) {
    return 'after fields must be a sorted unique inherited-style field set';
  }
  return null;
}

export function typedReadRequestValidationError(operation, request) {
  if (!TYPED_READ_OPERATIONS.includes(operation)) return 'typed-read operation is unsupported';
  if (operation === BRIDGE_HEALTH_TYPED_READ) {
    return typedReadExactKeys(request, [])
      ? null
      : 'Bridge health typed-read request contains an unknown field';
  }
  if (operation === NODE_BINDINGS_TYPED_READ) {
    if (!typedReadExactKeys(request, ['nodeId'])) {
      return 'Node Binding Facts typed-read request has an unknown or missing field';
    }
    if (request.nodeId !== null && (typeof request.nodeId !== 'string'
      || request.nodeId.length < 1 || request.nodeId.length > 512
      || !/^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/.test(request.nodeId))) {
      return 'Node Binding Facts typed-read nodeId is invalid';
    }
    return null;
  }
  if (operation === TOKEN_OVERLAP_TYPED_READ) {
    if (!typedReadExactKeys(request, ['queries', 'limit'])) {
      return 'Token Overlap typed-read request has an unknown or missing field';
    }
    if (!Array.isArray(request.queries) || request.queries.length < 2
      || request.queries.length > 32) {
      return 'Token Overlap typed-read requires 2-32 Collection queries';
    }
    if (request.queries.some((query) => typeof query !== 'string' || !query.trim()
      || query.length > 512
      || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(query))) {
      return 'Token Overlap typed-read Collection query is invalid';
    }
    const folded = request.queries.map((query) => query.toLocaleLowerCase('en-US'));
    if (new Set(folded).size !== folded.length) {
      return 'Token Overlap typed-read Collection queries must be unique';
    }
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      return 'Token Overlap typed-read limit must be 1-1000';
    }
    return null;
  }
  if (!typedReadExactKeys(request, ['style', 'type', 'limit', 'after'])) {
    return 'Style Consumer typed-read request has an unknown or missing field';
  }
  if (typeof request.style !== 'string' || request.style.length < 1 || request.style.length > 512
    || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(request.style)) {
    return 'Style Consumer typed-read style is invalid';
  }
  if (request.type !== null && !['PAINT', 'TEXT', 'EFFECT', 'GRID'].includes(request.type)) {
    return 'Style Consumer typed-read type is invalid';
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    return 'Style Consumer typed-read limit must be 1-500';
  }
  if (request.after !== null) return typedReadAnchorError(request.after);
  return null;
}

export async function executeStyleConsumersTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxStyleCandidates = 10_000;
  const maxConsumers = 100_000;
  const maxSerializedCodeUnits = 250_000;
  const allowedFields = new Set([
    'fillStyleId', 'strokeStyleId', 'backgroundStyleId', 'textStyleId',
    'effectStyleId', 'gridStyleId',
  ]);
  const direct = await figmaApi.getStyleByIdAsync(request.style);
  let style = direct && (!request.type || direct.type === request.type) ? direct : null;
  let resolution = 'id';
  if (!style) {
    const loaders = {
      PAINT: () => figmaApi.getLocalPaintStylesAsync(),
      TEXT: () => figmaApi.getLocalTextStylesAsync(),
      EFFECT: () => figmaApi.getLocalEffectStylesAsync(),
      GRID: () => figmaApi.getLocalGridStylesAsync(),
    };
    const lists = request.type
      ? [await loaders[request.type]()]
      : await Promise.all(Object.values(loaders).map((load) => load()));
    const pool = lists.flat();
    if (pool.length > maxStyleCandidates) {
      throw new Error('Style Consumer style-candidate limit exceeded. Use an exact style id.');
    }
    const exact = pool.filter((candidate) => candidate.name === request.style);
    const matches = exact.length ? exact
      : pool.filter((candidate) => candidate.name.toLowerCase().includes(request.style.toLowerCase()));
    if (matches.length > 1) throw new Error('Style reference is ambiguous (' + matches.length + ' matches). Use an exact style id or name.');
    if (matches.length === 0) throw new Error('Style not found in the targeted Figma document.');
    style = matches[0];
    resolution = exact.length ? 'exact-name' : 'partial-name';
  }
  if (typeof style.id !== 'string' || typeof style.key !== 'string'
    || typeof style.name !== 'string' || typeof style.remote !== 'boolean'
    || !['PAINT', 'TEXT', 'EFFECT', 'GRID'].includes(style.type)
    || typeof style.getStyleConsumersAsync !== 'function') {
    throw new Error('Style Consumer encountered incompatible publishable metadata.');
  }
  const nativeConsumers = await style.getStyleConsumersAsync();
  if (!Array.isArray(nativeConsumers) || nativeConsumers.length > maxConsumers) {
    throw new Error('Style Consumer candidate limit exceeded.');
  }
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const consumers = nativeConsumers.map((consumer) => {
    if (!consumer || !consumer.node || !Array.isArray(consumer.fields)
      || typeof consumer.node.id !== 'string' || typeof consumer.node.name !== 'string'
      || typeof consumer.node.type !== 'string' || consumer.node.id.length < 1
      || consumer.node.id.length > 1024 || consumer.node.name.length > 1024) {
      throw new Error('Style Consumer encountered incompatible node metadata.');
    }
    const fields = [...consumer.fields].sort(compareText);
    if (fields.length < 1 || fields.length > allowedFields.size
      || new Set(fields).size !== fields.length
      || fields.some((field) => !allowedFields.has(field))) {
      throw new Error('Style Consumer encountered an incompatible inherited style field.');
    }
    return { node: { id: consumer.node.id, name: consumer.node.name, type: consumer.node.type }, fields };
  });
  const compare = (left, right) => compareText(left.node.id, right.node.id)
    || compareText(left.fields.join('\u0000'), right.fields.join('\u0000'));
  consumers.sort(compare);
  for (let index = 1; index < consumers.length; index++) {
    if (compare(consumers[index - 1], consumers[index]) === 0) {
      throw new Error('Style Consumer returned a duplicate node/field identity.');
    }
  }
  let start = 0;
  if (request.after) {
    const anchorIndex = consumers.findIndex((consumer) => consumer.node.id === request.after.nodeId
      && consumer.fields.length === request.after.fields.length
      && consumer.fields.every((field, index) => field === request.after.fields[index]));
    if (anchorIndex === -1) throw new Error('Style Consumer cursor is stale. Restart without --cursor.');
    start = anchorIndex + 1;
  }
  const end = Math.min(consumers.length, start + request.limit);
  const page = consumers.slice(start, end);
  const omittedBefore = start;
  const omittedAfter = consumers.length - end;
  const payload = {
    schemaVersion: 1,
    resolution,
    query: request.style,
    requestedType: request.type,
    style: { id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote },
    scan: { api: 'getStyleConsumersAsync', complete: true, interruptible: false },
    cursorAnchor: request.after,
    total: consumers.length,
    returned: page.length,
    omitted: omittedBefore + omittedAfter,
    omittedBefore,
    omittedAfter,
    complete: omittedBefore === 0 && omittedAfter === 0,
    nextAnchor: omittedAfter > 0
      ? { nodeId: page[page.length - 1].node.id, fields: page[page.length - 1].fields }
      : null,
    consumers: page,
  };
  const serialized = JSON.stringify(payload);
  if (serialized.length > maxSerializedCodeUnits) {
    throw new Error('Style Consumer serialized-size limit exceeded. Lower --limit.');
  }
  return serialized;
}

export async function executeNodeBindingsTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxNodes = 128;
  const maxFacts = 384;
  const maxLabel = 512;
  const maxResources = 20_000;
  const maxField = 128;
  const maxId = 512;
  const maxSerializedCodeUnits = 1_000_000;
  const lookupTimeoutMs = 7000;
  const clean = (value, limit) => {
    const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
    if (text.length > limit) {
      throw new Error('Figma Node Binding Facts exceed the bounded result contract.');
    }
    return text;
  };
  async function findTarget(id) {
    let timeoutHandle;
    try {
      return await Promise.race([
        figmaApi.getNodeByIdAsync(id),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(
            'Figma node lookup timed out before the bounded read: ' + id,
          )), lookupTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
    }
  }
  const target = request.nodeId ? await findTarget(request.nodeId) : null;
  if (request.nodeId && !target) {
    throw new Error('Node not found in the targeted Figma document: ' + request.nodeId);
  }
  const nodes = request.nodeId ? [target] : Array.from(figmaApi.currentPage.selection || []);
  if (nodes.length > maxNodes) {
    throw new Error('Figma selection exceeds the bounded Node Binding Facts contract.');
  }

  const variableCache = new Map();
  const collectionCache = new Map();
  let localVariables = null;
  let localCollections = null;
  let factCount = 0;
  async function localVariable(id) {
    if (localVariables === null) {
      localVariables = false;
      if (typeof figmaApi.variables.getLocalVariablesAsync === 'function') {
        try {
          const candidates = await figmaApi.variables.getLocalVariablesAsync();
          if (!Array.isArray(candidates) || candidates.length > maxResources) {
            throw new Error('Figma local Variable catalog exceeds the bounded Node Binding Facts contract.');
          }
          localVariables = new Map(candidates
            .filter((candidate) => candidate && candidate.remote === false
              && typeof candidate.id === 'string' && candidate.id.length <= maxId)
            .map((candidate) => [candidate.id, candidate]));
        } catch (error) {
          if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
        }
      }
    }
    return localVariables && localVariables.get(id) || null;
  }
  async function localCollection(id) {
    if (localCollections === null) {
      localCollections = false;
      if (typeof figmaApi.variables.getLocalVariableCollectionsAsync === 'function') {
        try {
          const candidates = await figmaApi.variables.getLocalVariableCollectionsAsync();
          if (!Array.isArray(candidates) || candidates.length > maxResources) {
            throw new Error('Figma local Collection catalog exceeds the bounded Node Binding Facts contract.');
          }
          localCollections = new Map(candidates
            .filter((candidate) => candidate && candidate.remote === false
              && typeof candidate.id === 'string' && candidate.id.length <= maxId)
            .map((candidate) => [candidate.id, candidate]));
        } catch (error) {
          if (/exceeds the bounded/.test(String(error && error.message || error))) throw error;
        }
      }
    }
    return localCollections && localCollections.get(id) || null;
  }
  async function collectionFact(collectionId) {
    if (!collectionId) return null;
    const id = clean(collectionId, maxId);
    if (collectionCache.has(id)) return collectionCache.get(id);
    let collection = await localCollection(id);
    if (!collection && typeof figmaApi.variables.getVariableCollectionByIdAsync === 'function') {
      try { collection = await figmaApi.variables.getVariableCollectionByIdAsync(id); } catch {}
    }
    const fact = { id, name: collection ? clean(collection.name, maxLabel) : null, resolved: !!collection };
    collectionCache.set(id, fact);
    return fact;
  }
  async function variableFact(alias) {
    if (!alias || typeof alias.id !== 'string') {
      throw new Error('Figma returned unsupported node binding topology.');
    }
    const id = clean(alias.id, maxId);
    if (variableCache.has(id)) return variableCache.get(id);
    let variable = await localVariable(id);
    if (!variable && typeof figmaApi.variables.getVariableByIdAsync === 'function') {
      try { variable = await figmaApi.variables.getVariableByIdAsync(id); } catch {}
    }
    const fact = variable ? {
      id,
      name: clean(variable.name, maxLabel),
      resolvedType: clean(variable.resolvedType, 64),
      collection: await collectionFact(variable.variableCollectionId),
      resolved: true,
    } : { id, name: null, resolvedType: null, collection: null, resolved: false };
    variableCache.set(id, fact);
    return fact;
  }
  async function bindingFact(field, variableAlias, index = null, propertyName = null) {
    factCount++;
    if (factCount > maxFacts) {
      throw new Error('Figma node bindings exceed the bounded Node Binding Facts contract.');
    }
    return {
      field: clean(field, maxField),
      index,
      propertyName: propertyName == null ? null : clean(propertyName, maxLabel),
      variable: await variableFact(variableAlias),
    };
  }

  const results = [];
  for (const node of nodes) {
    const bindings = [];
    for (const [field, value] of Object.entries(node.boundVariables || {})) {
      if (field === 'componentProperties' && value && typeof value === 'object'
        && !Array.isArray(value) && typeof value.id !== 'string') {
        for (const [propertyName, variableAlias] of Object.entries(value)) {
          if (variableAlias == null) continue;
          bindings.push(await bindingFact(field, variableAlias, null, propertyName));
        }
      } else if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (value[index] == null) continue;
          bindings.push(await bindingFact(field, value[index], index));
        }
      } else if (value != null) {
        bindings.push(await bindingFact(field, value));
      }
    }
    results.push({
      id: clean(node.id, 96),
      name: clean(node.name, maxLabel),
      type: clean(node.type, 64),
      bindings,
    });
  }
  const payload = {
    schemaVersion: 1,
    source: request.nodeId ? 'node' : 'selection',
    nodes: results,
  };
  if (JSON.stringify(payload).length > maxSerializedCodeUnits) {
    throw new Error('Figma Node Binding Facts exceed the bounded serialized result contract.');
  }
  return payload;
}

export async function executeTokenOverlapTypedRead(figmaApi, request) {
  const requestError = typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, request);
  if (requestError) throw new Error(requestError);
  const maxCollectionCandidates = 10_000;
  const maxTargetVariables = 100_000;
  const maxString = 512;
  const maxSerializedCodeUnits = 2_000_000;
  const validText = (value, empty = true) => typeof value === 'string'
    && value.length <= maxString && (empty || value.length > 0);
  const collections = await figmaApi.variables.getLocalVariableCollectionsAsync();
  if (!Array.isArray(collections) || collections.length > maxCollectionCandidates
    || collections.some((collection) => !collection || !validText(collection.id, false)
      || !validText(collection.name) || collection.remote
      || !Array.isArray(collection.variableIds)
      || collection.variableIds.length > maxTargetVariables
      || collection.variableIds.some((id) => !validText(id, false))
      || new Set(collection.variableIds).size !== collection.variableIds.length)
    || new Set(collections.map((collection) => collection.id)).size !== collections.length) {
    throw new Error('Token Overlap encountered invalid Collection metadata.');
  }
  const resolved = request.queries.map((query) => {
    const folded = query.toLocaleLowerCase('en-US');
    const byId = collections.filter((collection) => collection.id === query);
    const exact = collections.filter((collection) =>
      collection.name.toLocaleLowerCase('en-US') === folded);
    const partial = collections.filter((collection) =>
      collection.name.toLocaleLowerCase('en-US').includes(folded));
    const matches = byId.length ? byId : exact.length ? exact : partial;
    if (!matches.length) throw new Error('Token Overlap Collection not found.');
    if (matches.length > 1) throw new Error('Token Overlap Collection query is ambiguous.');
    return { query, collection: matches[0] };
  });
  if (new Set(resolved.map((item) => item.collection.id)).size !== resolved.length) {
    throw new Error('Token Overlap queries resolve to the same Collection.');
  }
  const membershipTotal = resolved.reduce((total, item) =>
    total + item.collection.variableIds.length, 0);
  if (membershipTotal > maxTargetVariables) {
    throw new Error('Token Overlap selected Variable membership limit exceeded.');
  }
  const memberships = resolved.flatMap((item, collectionIndex) =>
    item.collection.variableIds.map((id) => ({ id, collectionIndex })));
  if (new Set(memberships.map((item) => item.id)).size !== memberships.length) {
    throw new Error('Token Overlap encountered cross-Collection Variable identity reuse.');
  }
  const variables = [];
  for (let start = 0; start < memberships.length; start += 64) {
    variables.push(...await Promise.all(memberships.slice(start, start + 64)
      .map((item) => figmaApi.variables.getVariableByIdAsync(item.id))));
  }
  const counts = resolved.map(() => new Map());
  for (let index = 0; index < memberships.length; index++) {
    const membership = memberships[index];
    const variable = variables[index];
    const owner = resolved[membership.collectionIndex].collection;
    if (!variable || variable.id !== membership.id || variable.remote
      || variable.variableCollectionId !== owner.id || !validText(variable.name, false)) {
      throw new Error('Token Overlap could not load exact Variable membership.');
    }
    const map = counts[membership.collectionIndex];
    map.set(variable.name, (map.get(variable.name) || 0) + 1);
  }
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const union = [...new Set(counts.flatMap((map) => [...map.keys()]))].sort(compare);
  const common = union.filter((name) => counts.every((map) => map.get(name) === 1));
  const list = (items) => {
    const projected = items.slice(0, request.limit);
    return {
      total: items.length,
      returned: projected.length,
      omitted: items.length - projected.length,
      complete: projected.length === items.length,
      items: projected,
    };
  };
  const perCollection = resolved.map((item, index) => {
    const map = counts[index];
    const names = [...map.keys()].sort(compare);
    const only = names.filter((name) => counts.every((other, otherIndex) =>
      otherIndex === index || !other.has(name)));
    const missing = union.filter((name) => !map.has(name));
    const ambiguous = names.filter((name) => map.get(name) > 1)
      .map((name) => ({ name, count: map.get(name) }));
    return {
      collection: item.collection.name,
      total: names.length,
      variableCount: item.collection.variableIds.length,
      duplicateNameCount: ambiguous.reduce((total, entry) => total + entry.count - 1, 0),
      only_here: list(only),
      missing_here: list(missing),
      ambiguous_here: list(ambiguous),
    };
  });
  const commonCore = list(common);
  const complete = commonCore.complete && perCollection.every((row) =>
    row.only_here.complete && row.missing_here.complete && row.ambiguous_here.complete);
  const payload = {
    schemaVersion: 1,
    limit: request.limit,
    complete,
    resolved: resolved.map((item) => ({
      query: item.query,
      id: item.collection.id,
      name: item.collection.name,
    })),
    collections: resolved.map((item) => item.collection.name),
    commonCore,
    perCollection,
  };
  if (JSON.stringify(payload).length > maxSerializedCodeUnits) {
    throw new Error('Token Overlap result exceeded the serialized-size limit. Lower --limit.');
  }
  return payload;
}

export async function executeTypedReadOperation(figmaApi, operation, request) {
  const error = typedReadRequestValidationError(operation, request);
  if (error) throw new Error(error);
  if (operation === BRIDGE_HEALTH_TYPED_READ) {
    const editorType = String(figmaApi?.editorType || '');
    if (!['figma', 'figjam', 'slides', 'dev'].includes(editorType) || !figmaApi?.currentPage) {
      throw new Error('Bridge health could not read the active Figma document context.');
    }
    return JSON.stringify({ schemaVersion: 1, responsive: true, editorType });
  }
  if (operation === STYLE_CONSUMERS_TYPED_READ) {
    return executeStyleConsumersTypedRead(figmaApi, request);
  }
  if (operation === NODE_BINDINGS_TYPED_READ) {
    return JSON.stringify(await executeNodeBindingsTypedRead(figmaApi, request));
  }
  if (operation === TOKEN_OVERLAP_TYPED_READ) {
    return JSON.stringify(await executeTokenOverlapTypedRead(figmaApi, request));
  }
  throw new Error('Typed-read operation is unsupported.');
}
// END TYPED READ RUNTIME
