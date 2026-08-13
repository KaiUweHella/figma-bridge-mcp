import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugin', 'manifest.codegen.json'), 'utf8'));
const source = readFileSync(join(ROOT, 'plugin', 'codegen.js'), 'utf8');

test('Dev Mode adapter is a separate offline codegen manifest', () => {
  assert.deepEqual(manifest.editorType, ['dev']);
  assert.deepEqual(manifest.capabilities, ['codegen']);
  assert.equal(manifest.main, 'codegen.js');
  assert.equal(manifest.id, 'figma-bridge-mcp-codegen');
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['none']);
  assert.doesNotThrow(() => new Function('figma', source));
});

test('Dev Mode projects Bridge context, native CSS and component contracts', async () => {
  let generate;
  const figma = { editorType: 'dev', mode: 'codegen', codegen: { on(type, callback) { if (type === 'generate') generate = callback; } } };
  new Function('figma', source)(figma);
  assert.equal(typeof generate, 'function');
  const data = {
    'figma-bridge-design-entity': JSON.stringify({ version: 1, id: 'ui.button', kind: 'component' }),
    'figmaBridge.semanticPath': 'screen.actions.primary',
    'figmaBridge.semanticIndex': '2',
    'figmaBridge.renderPlanVersion': '1',
    'figmaBridge.fallbackAnnotations': JSON.stringify({ schemaVersion: 1, annotations: [{ policy: 'solid-border' }] }),
  };
  const node = {
    id: '1:2', name: 'Primary action', type: 'INSTANCE',
    getPluginData: (key) => data[key] || '',
    annotations: [{ labelMarkdown: 'Keep code and Figma aligned', properties: [{ type: 'WIDTH' }] }],
    componentProperties: { 'Icon#1': { type: 'INSTANCE_SWAP', value: '9:9' } },
    componentPropertyReferences: { visible: 'Show icon#2' },
    overrides: [{ id: '1:3', overriddenFields: ['componentProperties'] }],
    exposedInstances: [],
    getMainComponentAsync: async () => ({ name: 'Button/Primary', key: 'BUTTON_KEY' }),
    getCSSAsync: async () => ({ display: 'flex', 'border-radius': '8px' }),
  };
  const results = await generate({ node, language: 'css' });
  assert.deepEqual(results.map((result) => result.title), [
    'Native Figma CSS', 'Figma Bridge context', 'Component contract',
  ]);
  assert.match(results[0].code, /display: flex/);
  const context = JSON.parse(results[1].code);
  assert.equal(context.sourceIntent.designEntity.id, 'ui.button');
  assert.equal(context.sourceIntent.semanticPath, 'screen.actions.primary');
  assert.equal(context.designerFacts.annotations[0].properties[0], 'WIDTH');
  assert.match(context.repositoryLookup, /link context ui\.button/);
  const contract = JSON.parse(results[2].code);
  assert.equal(contract.properties['Icon#1'].type, 'INSTANCE_SWAP');
  assert.equal(contract.mainComponent.key, 'BUTTON_KEY');
});

test('Codegen registers only in the Dev Mode codegen context', () => {
  for (const context of [
    { editorType: 'figma', mode: 'default' },
    { editorType: 'dev', mode: 'inspect' },
  ]) {
    let registered = false;
    const figma = {
      ...context,
      codegen: { on() { registered = true; } },
    };
    new Function('figma', source)(figma);
    assert.equal(registered, false);
  }
});
