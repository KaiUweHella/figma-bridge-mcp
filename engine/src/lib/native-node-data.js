// Native node facts exposed by the Figma Plugin API.
//
// These deliberately use the live plugin document instead of the REST API:
// getCSSAsync() mirrors Figma's Inspect output, while JSON_REST_V1 gives the
// REST-shaped node representation without a network request or API token.

export function nodeCssCode(nodeId) {
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
    if (typeof node.getCSSAsync !== 'function') {
      throw new Error('Node type ' + node.type + ' does not expose getCSSAsync().');
    }
    const css = await node.getCSSAsync();
    return { id: node.id, name: node.name, type: node.type, css };
  })()`;
}

export function formatNodeCss(result, { json = false } = {}) {
  if (!result || typeof result !== 'object' || !result.css || typeof result.css !== 'object') {
    throw new Error('Figma returned no native CSS data.');
  }
  if (json) return JSON.stringify(result, null, 2);
  const lines = [`/* ${result.name || '(unnamed)'} (${result.id}) — ${result.type} */`];
  for (const [property, value] of Object.entries(result.css)) lines.push(`${property}: ${value};`);
  return lines.join('\n');
}

export function nodeRestJsonCode(nodeId) {
  return `(async () => {
    const node = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!node) throw new Error('Node not found: ' + ${JSON.stringify(nodeId)});
    if (typeof node.exportAsync !== 'function') {
      throw new Error('Node type ' + node.type + ' cannot be exported.');
    }
    if (node.type === 'PAGE' && typeof node.loadAsync === 'function') await node.loadAsync();
    return await node.exportAsync({ format: 'JSON_REST_V1' });
  })()`;
}
