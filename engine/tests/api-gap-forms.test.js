import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageForms } from '../src/api-docs.js';

// `api gap` reports which documented Figma API names the engine never touches.
// The docs name TYPES; plugin code writes factory calls and type strings. When
// the two were compared literally, the report claimed the engine used 14 of
// 254 names — it uses at least twice that.
test('a node type maps to its factory call and its type string', () => {
  assert.deepEqual(usageForms('FrameNode'), ['FrameNode', 'createFrame', 'FRAME']);
});

test('a multi-word node type becomes an UPPER_SNAKE type string', () => {
  const forms = usageForms('ComponentSetNode');
  assert.ok(forms.includes('COMPONENT_SET'), 'node.type === "COMPONENT_SET" must count');
  assert.ok(forms.includes('createComponentSet'));
});

test('names that are not node types are matched literally only', () => {
  assert.deepEqual(usageForms('SolidPaint'), ['SolidPaint']);
});
