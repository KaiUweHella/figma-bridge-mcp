// Canonical generated Plugin runtime for exact local Collection mutations.

import {
  MAX_COLLECTION_FACTS_CANDIDATES,
  MAX_COLLECTION_FACTS_MODES,
} from './collection-facts-command.js';

export function collectionMutationPluginRuntimeCode() {
  return `
const __bridgeCollections = await figma.variables.getLocalVariableCollectionsAsync();
if (!Array.isArray(__bridgeCollections)
  || __bridgeCollections.length > ${MAX_COLLECTION_FACTS_CANDIDATES}) {
  throw new Error('Collection mutation candidate limit exceeded.');
}
const __bridgeResolveCollection = (query) => {
  const direct = __bridgeCollections.filter((item) => item.id === query);
  if (direct.length) return { collection: direct[0], resolution: 'id' };
  const exact = __bridgeCollections.filter((item) => item.name === query);
  const partial = __bridgeCollections.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase()));
  const matches = exact.length ? exact : partial;
  if (matches.length > 1) throw new Error('Variable Collection is ambiguous; use its id.');
  if (!matches.length) throw new Error('Variable Collection not found.');
  return { collection: matches[0], resolution: 'name' };
};
const __bridgeResolveMode = (collection, query) => {
  const direct = collection.modes.filter((mode) => mode.modeId === query);
  if (direct.length) return { mode: direct[0], resolution: 'id' };
  const exact = collection.modes.filter((mode) => mode.name === query);
  const partial = collection.modes.filter((mode) =>
    mode.name.toLowerCase().includes(query.toLowerCase()));
  const matches = exact.length ? exact : partial;
  if (matches.length > 1) throw new Error('Collection mode is ambiguous; use its id.');
  if (!matches.length) throw new Error('Collection mode not found.');
  return { mode: matches[0], resolution: 'name' };
};
const __bridgeCollectionFacts = async (collection) => ({
  schemaVersion: 1, id: collection.id, key: collection.key || null,
  name: collection.name, remote: !!collection.remote,
  isExtension: !!collection.isExtension,
  hiddenFromPublishing: !!collection.hiddenFromPublishing,
  defaultModeId: collection.defaultModeId,
  modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
  variableIds: [...collection.variableIds],
  publishStatus: await collection.getPublishStatusAsync(),
});
const __bridgeValidateCollectionFacts = (facts) => {
  const boundedText = (value, empty = true) => typeof value === 'string'
    && value.length <= 1024 && (empty || value.length > 0);
  const exactObject = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };
  if (!exactObject(facts, [
    'schemaVersion', 'id', 'key', 'name', 'remote', 'isExtension',
    'hiddenFromPublishing', 'defaultModeId', 'modes', 'variableIds', 'publishStatus',
  ]) || facts.schemaVersion !== 1 || !boundedText(facts.id, false)
    || !(facts.key === null || boundedText(facts.key, false))
    || !boundedText(facts.name, false) || facts.remote !== false
    || typeof facts.isExtension !== 'boolean'
    || typeof facts.hiddenFromPublishing !== 'boolean'
    || !boundedText(facts.defaultModeId, false)
    || !Array.isArray(facts.modes) || facts.modes.length > ${MAX_COLLECTION_FACTS_MODES}
    || !Array.isArray(facts.variableIds)
    || facts.variableIds.length > ${MAX_COLLECTION_FACTS_CANDIDATES}
    || !['UNPUBLISHED', 'CURRENT', 'CHANGED'].includes(facts.publishStatus)) return false;
  const modeIds = new Set();
  if (!facts.modes.every((mode) => exactObject(mode, ['modeId', 'name'])
    && boundedText(mode.modeId, false) && boundedText(mode.name)
    && !modeIds.has(mode.modeId) && !!modeIds.add(mode.modeId))) return false;
  if (!modeIds.has(facts.defaultModeId)) return false;
  const variableIds = new Set();
  return facts.variableIds.every((id) => boundedText(id, false)
    && !variableIds.has(id) && !!variableIds.add(id));
};`;
}
