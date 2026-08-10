import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFigmaTarget, targetFileKey } from '../src/figma-target.js';

test('Figma Target Context resolves precedence once and stays immutable', () => {
  const explicit = resolveFigmaTarget({
    explicitFileKey: 'https://www.figma.com/design/EXPLICITFILEKEY/FILE_NAME',
    args: ['inspect', 'https://www.figma.com/design/ARGUMENTFILEKEY/FILE_NAME?node-id=1-2'],
  });
  assert.deepEqual(explicit, { kind: 'plugin-file', fileKey: 'EXPLICIT', source: 'explicit' });
  assert.equal(Object.isFrozen(explicit), true);
  const inferred = resolveFigmaTarget({ args: ['inspect', 'https://www.figma.com/design/ARGUMENTFILEKEY/FILE_NAME?node-id=1-2'] });
  assert.deepEqual(inferred, { kind: 'plugin-file', fileKey: 'ARGUMENT', source: 'figma-url' });
  assert.equal(targetFileKey(inferred), 'ARGUMENT');
});

test('implicit single-window targeting is explicit in the Context', () => {
  const target = resolveFigmaTarget({ args: ['inspect', '1:2'] });
  assert.deepEqual(target, { kind: 'plugin-file', fileKey: null, source: 'implicit-single-window' });
  assert.equal(targetFileKey(target), null);
  assert.equal(targetFileKey('https://www.figma.com/board/BOARDFILEKEY/FILE_NAME'), 'BOARD');
});
