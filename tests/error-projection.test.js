import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPublicError } from '../src/error-projection.js';

test('child-process projection never exposes the internal command line or argv', () => {
  const projected = projectPublicError(Object.assign(
    new Error('Command failed: /usr/local/bin/node /private/plugin/engine.js render --secret VALUE'),
    { code: 1, stdout: '', stderr: '' },
  ));
  assert.equal(projected.kind, 'engine-exit');
  assert.match(projected.message, /engine exited with code 1/i);
  assert.doesNotMatch(projected.message, /usr\/local|engine\.js|--secret|VALUE/);
});

test('child-process projection retains actionable stderr without argv metadata', () => {
  const projected = projectPublicError(Object.assign(
    new Error('Command failed: node internal.js'),
    { code: 2, stderr: 'Node 12:34 was not found\nTry the current file.', stdout: '' },
  ));
  assert.equal(projected.kind, 'engine-exit');
  assert.match(projected.message, /Node 12:34 was not found/);
  assert.doesNotMatch(projected.message, /internal\.js/);
});
