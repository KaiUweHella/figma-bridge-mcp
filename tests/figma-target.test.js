import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFigmaTarget, targetFileKey } from '../src/figma-target.js';
import { projectFigmaUrlFileKey } from '../src/figma-target-projection.js';

test('Figma Target Context resolves precedence once and stays immutable', () => {
  const explicit = resolveFigmaTarget({
    explicitFileKey: 'https://www.figma.com/design/EXPLICITPLACEHOLDERKEY/FILE_NAME',
    args: ['inspect', 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=1-2'],
  });
  assert.deepEqual(explicit, { kind: 'plugin-file', fileKey: 'EXPLICITPLACEHOLDERKEY', source: 'explicit' });
  assert.equal(Object.isFrozen(explicit), true);
  const inferredArgs = ['inspect', 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=1-2'];
  const inferred = resolveFigmaTarget({
    args: inferredArgs,
    figmaUrlFileKey: projectFigmaUrlFileKey(inferredArgs, 'inspect'),
  });
  assert.deepEqual(inferred, { kind: 'plugin-file', fileKey: 'ARGUMENTPLACEHOLDERKEY', source: 'figma-url' });
  assert.equal(targetFileKey(inferred), 'ARGUMENTPLACEHOLDERKEY');
});

test('a closed request may project one URL target without scanning payload fields', () => {
  const target = resolveFigmaTarget({
    args: ['node', 'set-text', '1:2', 'https://www.figma.com/design/PAYLOADPLACEHOLDERKEY/FILE_NAME?node-id=9-9'],
    figmaUrlArgs: [],
    figmaUrlFileKey: 'NODEPLACEHOLDERKEY',
  });
  assert.deepEqual(target, {
    kind: 'plugin-file', fileKey: 'NODEPLACEHOLDERKEY', source: 'figma-url',
  });
  const explicit = resolveFigmaTarget({
    explicitFileKey: 'EXPLICITPLACEHOLDERKEY',
    figmaUrlFileKey: 'NODEPLACEHOLDERKEY',
    figmaUrlArgs: [],
  });
  assert.equal(explicit.fileKey, 'EXPLICITPLACEHOLDERKEY');
  assert.equal(explicit.source, 'explicit');
});

test('implicit single-window targeting is explicit in the Context', () => {
  const target = resolveFigmaTarget({ args: ['inspect', '1:2'] });
  assert.deepEqual(target, { kind: 'plugin-file', fileKey: null, source: 'implicit-single-window' });
  assert.equal(targetFileKey(target), null);
  assert.equal(targetFileKey('https://www.figma.com/board/BOARDPLACEHOLDERKEY/FILE_NAME'), 'BOARDPLACEHOLDERKEY');
});

test('registry targeting is lazy and stays below explicit and URL-derived targets', () => {
  let registryReads = 0;
  const registryFileKey = () => {
    registryReads++;
    return 'REGISTRYPLACEHOLDERKEY';
  };

  const explicit = resolveFigmaTarget({
    explicitFileKey: 'EXPLICITPLACEHOLDERKEY',
    args: ['inspect', '1:2'],
    registryFileKey,
  });
  assert.equal(explicit.source, 'explicit');
  assert.equal(registryReads, 0);

  const urlArgs = ['inspect', 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=1-2'];
  const fromUrl = resolveFigmaTarget({
    args: urlArgs,
    figmaUrlFileKey: projectFigmaUrlFileKey(urlArgs, 'inspect'),
    registryFileKey,
  });
  assert.equal(fromUrl.source, 'figma-url');
  assert.equal(registryReads, 0);

  const fromRegistry = resolveFigmaTarget({ args: ['link', 'context', 'screen.settings'], registryFileKey });
  assert.deepEqual(fromRegistry, {
    kind: 'plugin-file',
    fileKey: 'REGISTRYPLACEHOLDERKEY',
    source: 'design-link-registry',
  });
  assert.equal(Object.isFrozen(fromRegistry), true);
  assert.equal(registryReads, 1);
});
