import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationAddCode, annotationCategoriesCode, annotationCategoryCreateCode,
  annotationEditCode, annotationRemoveCode, parseProperties,
} from '../src/lib/annotation-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture() {
  const node = { id: '1:2', name: 'Card', type: 'FRAME', annotations: [] };
  const categories = [{ id: 'C:1', label: 'Review', color: 'blue', isPreset: false }];
  const figma = {
    getNodeByIdAsync: async () => node,
    annotations: {
      getAnnotationCategoriesAsync: async () => categories,
      getAnnotationCategoryByIdAsync: async (id) => categories.find((c) => c.id === id) || null,
      addAnnotationCategoryAsync: async (input) => { const c = { id: `C:${categories.length + 1}`, ...input, isPreset: false }; categories.push(c); return c; },
    },
  };
  return { node, categories, figma };
}

test('annotation properties parse to the official property object shape', () => {
  assert.deepEqual(parseProperties('width,fontSize'), [{ type: 'width' }, { type: 'fontSize' }]);
  assert.deepEqual(parseProperties(''), []);
});

test('annotations support categories, properties, index edit/removal, and category creation', async () => {
  const { node, categories, figma } = fixture();
  await execute(annotationAddCode({ nodeId: '1:2', text: 'Check', category: 'Review', properties: 'width' }), figma);
  assert.equal(node.annotations[0].categoryId, 'C:1');
  await execute(annotationEditCode({ nodeId: '1:2', index: 0, text: 'Fixed', markdown: true, properties: '' }), figma);
  assert.equal(node.annotations[0].labelMarkdown, 'Fixed');
  assert.deepEqual(node.annotations[0].properties, []);
  await execute(annotationRemoveCode({ nodeId: '1:2', index: 0 }), figma);
  assert.equal(node.annotations.length, 0);
  await execute(annotationCategoryCreateCode({ label: 'Ready', color: 'green' }), figma);
  assert.equal(categories.length, 2);
  assert.equal((await execute(annotationCategoriesCode(), figma))[1].label, 'Ready');
});
