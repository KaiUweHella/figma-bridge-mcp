/**
 * Optional Dev Mode projection for Figma Bridge.
 *
 * This plugin is deliberately read-only and offline. Repository paths and the
 * accepted round-trip baseline stay in figma-bridge.json, so Dev Mode exposes
 * document-local handles and tells the agent which MCP read resolves the rest.
 */
const DESIGN_ENTITY_STORAGE = 'figma-bridge-design-entity';

function pluginJson(node, key) {
  try {
    const raw = node.getPluginData(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function bridgeContext(node) {
  const entity = pluginJson(node, DESIGN_ENTITY_STORAGE);
  const semanticPath = node.getPluginData('figmaBridge.semanticPath') || null;
  const semanticIndex = node.getPluginData('figmaBridge.semanticIndex') || null;
  const renderPlanVersion = node.getPluginData('figmaBridge.renderPlanVersion') || null;
  const fallbacks = pluginJson(node, 'figmaBridge.fallbackAnnotations');
  const variableFontAxes = pluginJson(node, 'figmaBridge.variableFontAxes');
  const annotations = Array.isArray(node.annotations)
    ? node.annotations.map((annotation) => ({
      labelMarkdown: annotation.labelMarkdown || annotation.label || null,
      categoryId: annotation.categoryId || null,
      properties: (annotation.properties || []).map((property) => property.type),
    }))
    : [];
  return {
    sourceIntent: {
      designEntity: entity && entity.version === 1
        ? { id: entity.id, kind: entity.kind || null }
        : null,
      semanticPath,
      semanticIndex: /^\d+$/.test(String(semanticIndex || '')) ? Number(semanticIndex) : null,
      renderPlanVersion: /^\d+$/.test(String(renderPlanVersion || '')) ? Number(renderPlanVersion) : null,
      fallbackAnnotations: fallbacks?.schemaVersion === 1 ? fallbacks.annotations || [] : [],
      variableFontAxes: variableFontAxes?.schemaVersion === 1 ? variableFontAxes : null,
    },
    designerFacts: { annotations },
    repositoryLookup: entity?.id
      ? `Run link context ${entity.id} through the MCP to resolve code path, Storybook link and round-trip status.`
      : 'Run link inspect for this node, then link set to establish a stable Design Entity.',
  };
}

function cssText(css) {
  return Object.entries(css || {}).map(([property, value]) => `  ${property}: ${value};`).join('\n');
}

async function componentContract(node) {
  const contract = {};
  if (node.componentPropertyReferences && Object.keys(node.componentPropertyReferences).length) {
    contract.propertyReferences = node.componentPropertyReferences;
  }
  if (node.type === 'INSTANCE') {
    contract.properties = node.componentProperties || {};
    contract.directOverrides = (node.overrides || []).map((override) => ({
      id: override.id,
      overriddenFields: Array.from(override.overriddenFields || []),
    }));
    contract.exposedInstances = [];
    for (const instance of node.exposedInstances || []) {
      const item = { id: instance.id, name: instance.name };
      try {
        const main = await instance.getMainComponentAsync();
        if (main) item.mainComponent = { name: main.name, key: main.key || null };
      } catch (error) {}
      contract.exposedInstances.push(item);
    }
    try {
      const main = await node.getMainComponentAsync();
      if (main) contract.mainComponent = { name: main.name, key: main.key || null };
    } catch (error) {}
  }
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    contract.propertyDefinitions = node.componentPropertyDefinitions || {};
  }
  if (node.type === 'SLOT') {
    contract.slot = { limitViolations: Array.from(node.limitViolations || []) };
  }
  return Object.keys(contract).length ? contract : null;
}

if (figma.editorType === 'dev' && figma.mode === 'codegen') figma.codegen.on('generate', async ({ node, language }) => {
  /** @type {CodegenResult[]} */
  const results = [];
  const context = bridgeContext(node);
  results.push({
    title: 'Figma Bridge context',
    language: 'JSON',
    code: JSON.stringify(context, null, 2),
  });

  const contract = await componentContract(node);
  if (contract) {
    results.push({
      title: 'Component contract',
      language: 'JSON',
      code: JSON.stringify(contract, null, 2),
    });
  }

  if (language === 'css' && typeof node.getCSSAsync === 'function') {
    try {
      const css = await node.getCSSAsync();
      if (css && Object.keys(css).length) {
        results.unshift({
          title: 'Native Figma CSS',
          language: 'CSS',
          code: `.${String(node.name || 'layer').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')} {\n${cssText(css)}\n}`,
        });
      }
    } catch (error) {}
  }
  return results;
});
