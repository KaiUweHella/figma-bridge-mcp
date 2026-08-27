// Immutable Design Entity bindings for Semantic Render Plans.
//
// Input adapters author repository-owned ids and variant intent. This module
// is the only seam allowed to turn Registry handles into executable Plan
// bindings, so source props and later Registry reads cannot change identity.

const ENTITY_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const NODE_ID = /^\d+:\d+$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function bindingError(message) {
  return new Error(`Semantic Render Design Entity binding failed: ${message}`);
}

function dynamicEntries(props, prefix) {
  return Object.entries(props || {})
    .filter(([key]) => key.startsWith(`${prefix}:`))
    .map(([key, value]) => ({ key, value }));
}

function matchingAuthoredAnchor(props, entity, field, projected) {
  if (props[field] == null) return;
  if (!projected || String(props[field]) !== String(projected)) {
    throw bindingError(`Design Entity ${entity} has a conflicting authored ${field} anchor`);
  }
}

function executableBinding(entity, usage, projection) {
  const source = projection.entities?.[entity];
  if (!source) throw bindingError(`Design Entity ${entity} is missing from the Registry projection`);
  const purposes = [...usage.purposes].sort();
  const variantIntents = [...usage.variantIntents].sort();

  if (purposes.includes('render-root')) {
    if (!['screen', 'frame'].includes(source.entityKind)) {
      throw bindingError(`rendered root ${entity} must be a screen or frame entity`);
    }
    return Object.freeze({
      entityId: entity,
      entityKind: source.entityKind,
      purposes: Object.freeze(purposes),
      handleKind: 'created-root',
      handle: 'created-root',
      variantIntents: Object.freeze(variantIntents),
    });
  }

  if (source.entityKind !== 'component') {
    throw bindingError(`instance ${entity} must resolve to a component entity`);
  }
  const publishedKey = source.publishedKey == null ? null : String(source.publishedKey);
  const localNodeId = source.localNodeId == null ? null : String(source.localNodeId);
  const localFileKey = source.localFileKey == null ? null : String(source.localFileKey);
  if (publishedKey && !SAFE_TEXT.test(publishedKey)) {
    throw bindingError(`Design Entity ${entity} has an invalid published key`);
  }
  if (localNodeId && !NODE_ID.test(localNodeId)) {
    throw bindingError(`Design Entity ${entity} has an invalid local node id`);
  }
  const targetFileKey = projection.targetConstraint?.kind === 'file-key'
    ? String(projection.targetConstraint.fileKey || '')
    : null;
  const localMatchesTarget = Boolean(localNodeId && localFileKey && targetFileKey
    && localFileKey === targetFileKey);

  if (!publishedKey && !localMatchesTarget) {
    if (localNodeId && !localFileKey) {
      throw bindingError(`Design Entity ${entity} local node has no exact Registry file key`);
    }
    if (localNodeId && !targetFileKey) {
      throw bindingError(`Design Entity ${entity} local node needs an exact Command target file`);
    }
    if (localNodeId) {
      throw bindingError(`Design Entity ${entity} belongs to Figma file ${localFileKey}, not the Command target`);
    }
    throw bindingError(`Design Entity ${entity} has no published key or exact-file local node`);
  }

  return Object.freeze({
    entityId: entity,
    entityKind: 'component',
    purposes: Object.freeze(purposes),
    handleKind: publishedKey ? 'published-key' : 'local-node',
    handle: publishedKey || localNodeId,
    ...(publishedKey && localMatchesTarget ? {
      localFallback: Object.freeze({
        handleKind: 'local-node',
        handle: localNodeId,
        fileKey: localFileKey,
      }),
    } : {}),
    variantIntents: Object.freeze(variantIntents),
  });
}

/** Bind only identities used by one semantic model and remove redundant
 * caller-authored component handles from its node props. */
export function bindSemanticDesignEntities(model, projection) {
  if (!isRecord(model?.root)) throw bindingError('semantic model root is missing');
  if (!isRecord(projection) || projection.version !== 1 || !isRecord(projection.registry)
    || !isRecord(projection.targetConstraint) || !isRecord(projection.entities)) {
    throw bindingError('Registry projection is missing or invalid');
  }
  const usage = new Map();
  const use = (entity, purpose, variant = null) => {
    const id = String(entity || '').trim();
    if (!ENTITY_ID.test(id)) throw bindingError(`${purpose} needs a valid Design Entity id`);
    const item = usage.get(id) || { purposes: new Set(), variantIntents: new Set() };
    item.purposes.add(purpose);
    if (variant != null && String(variant).trim()) item.variantIntents.add(String(variant).trim());
    usage.set(id, item);
    return id;
  };

  const visit = (node, root = false) => {
    const props = { ...(node.source?.props || {}) };
    if (root && node.source?.type === 'frame' && props.entity != null) {
      use(props.entity, 'render-root');
    }
    if (node.source?.type === 'instance') {
      const entity = use(props.entity, 'instance', props.variant);
      const projected = projection.entities[entity];
      matchingAuthoredAnchor(props, entity, 'key', projected?.publishedKey);
      matchingAuthoredAnchor(props, entity, 'id', projected?.localNodeId);
      if (props.component != null) {
        throw bindingError(`Design Entity ${entity} cannot use a display-name component anchor`);
      }
      delete props.key;
      delete props.id;
      delete props.component;
      const registryVariant = projected?.variant;
      if (props.variant == null && registryVariant != null) props.variant = registryVariant;
      use(entity, 'instance', props.variant);
      for (const entry of dynamicEntries(props, 'swap')) {
        use(entry.value, 'instance-swap', projection.entities?.[entry.value]?.variant);
      }
      for (const entry of dynamicEntries(props, 'prop')) {
        if (projection.entities?.[entry.value]) {
          use(entry.value, 'instance-swap', projection.entities[entry.value].variant);
        }
      }
    }
    return {
      ...node,
      source: { ...node.source, props },
      children: (node.children || []).map((child) => visit(child, false)),
    };
  };

  const root = visit(model.root, true);
  const bindings = Object.create(null);
  for (const entity of [...usage.keys()].sort()) {
    bindings[entity] = executableBinding(entity, usage.get(entity), projection);
  }
  const table = usage.size ? deepFreeze({
    version: 1,
    registry: {
      schemaVersion: projection.registry.schemaVersion,
      sourceFingerprint: projection.registry.sourceFingerprint,
    },
    targetConstraint: { ...projection.targetConstraint },
    bindings,
  }) : null;
  return Object.freeze({ model: { ...model, root }, designEntityBindings: table });
}

function compatibilityHandle(binding) {
  if (!binding || binding.handleKind === 'created-root') return null;
  return {
    ...(binding.handleKind === 'published-key' ? { key: binding.handle } : { id: binding.handle }),
    ...(binding.localFallback ? { id: binding.localFallback.handle } : {}),
    ...(binding.variantIntents?.length === 1 ? { variant: binding.variantIntents[0] } : {}),
  };
}

/** Generated compatibility remains a consumer of the immutable binding table.
 * Handles are materialized into its temporary tree only after Plan validation;
 * they never return to authored source intent or become a second Plan truth. */
export function materializeDesignBindingsForCompatibility(plan) {
  const table = plan?.designEntityBindings;
  if (!table) return plan;
  const visit = (node) => {
    const props = { ...(node.source?.props || {}) };
    if (node.source?.type === 'instance') {
      const main = compatibilityHandle(table.bindings?.[props.entity]);
      if (main) Object.assign(props, main);
      for (const prefix of ['prop', 'swap']) {
        for (const entry of dynamicEntries(props, prefix)) {
          const target = compatibilityHandle(table.bindings?.[entry.value]);
          if (target) props[entry.key] = { $figmaBridgeBinding: target };
        }
      }
    }
    return {
      ...node,
      source: { ...node.source, props },
      children: (node.children || []).map(visit),
    };
  };
  return { ...plan, root: visit(plan.root) };
}
