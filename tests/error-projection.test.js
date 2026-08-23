import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPublicError, projectPublicError, publicError } from '../src/error-projection.js';

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

test('public errors expose only the closed Dispatch Receipt state', () => {
  const raw = Object.assign(new Error('Plugin editor does not match'), {
    kind: 'targeting',
    dispatchState: 'not-dispatched',
    connectionEpoch: '11111111-1111-4111-8111-111111111111',
    fileKey: 'PRIVATE_FILE_KEY',
  });
  assert.deepEqual(projectPublicError(raw), {
    kind: 'targeting',
    message: 'Plugin editor does not match',
    dispatchState: 'not-dispatched',
  });
  const wrapped = publicError(raw);
  assert.equal(wrapped.dispatchState, 'not-dispatched');
  const formatted = formatPublicError(raw);
  assert.match(formatted, /\[dispatch:not-dispatched\]/);
  assert.doesNotMatch(formatted, /11111111|PRIVATE_FILE_KEY/);

  const forged = projectPublicError(Object.assign(new Error('failed'), {
    dispatchState: 'forged-state',
  }));
  assert.equal(Object.hasOwn(forged, 'dispatchState'), false);
});
