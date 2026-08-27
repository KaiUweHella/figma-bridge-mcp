// Canonical closed Plugin operations that may bypass the mutation lane.
// The marked runtime is synchronized into plugin/code.js; no operation accepts
// generated JavaScript or another executable payload.

// BEGIN TYPED READ RUNTIME
export const TYPED_READ_CAPABILITY = 'typed-read-v1';
export const BRIDGE_HEALTH_TYPED_READ = 'bridge-health-v1';
export const STYLE_CONSUMERS_TYPED_READ = 'style-consumers-v1';
export const TYPED_READ_OPERATIONS = Object.freeze([
  BRIDGE_HEALTH_TYPED_READ,
  STYLE_CONSUMERS_TYPED_READ,
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

export function executeTypedReadOperation(figmaApi, operation, request) {
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
  throw new Error('Typed-read operation is unsupported.');
}
// END TYPED READ RUNTIME
