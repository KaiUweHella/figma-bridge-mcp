import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialTypingNames, usageForms } from '../src/api-docs.js';

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

test('official typings declarations are the coverage source and are deduplicated', () => {
  const names = parseOfficialTypingNames(`
interface FrameNode {}
type Paint = SolidPaint | GradientPaint
declare interface FrameNode {}
export enum Foo { A }
  `);
  assert.deepEqual(names.map(({ kind, name }) => ({ kind, name })), [
    { kind: 'interface', name: 'FrameNode' },
    { kind: 'type', name: 'Paint' },
    { kind: 'type', name: 'Foo' },
  ]);
});
