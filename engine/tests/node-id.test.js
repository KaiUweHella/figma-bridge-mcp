// Node-id normalization: URLs and dash-format ids become canonical ids;
// foreign file keys surface a warning instead of a bare "not found".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNodeId } from '../src/lib/node-id.js';

test('canonical ids and instance paths pass through untouched', () => {
  assert.equal(normalizeNodeId('12:34').id, '12:34');
  assert.equal(normalizeNodeId('I12:34;56:78').id, 'I12:34;56:78');
  assert.equal(normalizeNodeId('0:0').id, '0:0');
});

test('URL dash format converts to colons', () => {
  assert.equal(normalizeNodeId('12-34').id, '12:34');
  assert.equal(normalizeNodeId('I12-34;56-78').id, 'I12:34;56:78');
});

test('layer-name-ish strings with dashes are never rewritten', () => {
  assert.equal(normalizeNodeId('metric-item').id, 'metric-item');
  assert.equal(normalizeNodeId('badge--corner').id, 'badge--corner');
});

test('full Figma URLs yield id + file key + safe-mode warning', () => {
  const r = normalizeNodeId('https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=12-34&m=dev');
  assert.equal(r.id, '12:34');
  assert.equal(r.fileKey, 'PLACEHOLDERFILEKEY');
  assert.match(r.warning, /Safe Mode only reaches the file/);
});

test('URL with encoded colon node-id works too', () => {
  const r = normalizeNodeId('https://www.figma.com/file/PLACEHOLDERFILEKEY/FILE_NAME?node-id=12%3A34');
  assert.equal(r.id, '12:34');
});

test('URL without node-id warns instead of guessing', () => {
  const r = normalizeNodeId('https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME');
  assert.equal(r.fileKey, 'PLACEHOLDERFILEKEY');
  assert.match(r.warning, /no node-id/);
});

test('empty and whitespace inputs pass through without crashing', () => {
  assert.equal(normalizeNodeId('').id, '');
  assert.equal(normalizeNodeId('  12:35  ').id, '12:35');
});
