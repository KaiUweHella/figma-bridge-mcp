import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPublicError,
  isPublicFailureProjection,
  projectMcpErrorContext,
  projectPublicError,
  projectPublicFailure,
  publicError,
} from '../src/error-projection.js';

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

test('public errors preserve only bounded mutation counts and terminal receipt state', () => {
  const raw = Object.assign(new Error('A private node could not be restored'), {
    kind: 'execution', dispatchState: 'failed', mutationOutcome: 'partial-residue',
    mutationReport: {
      version: 1, outcome: 'partial-residue', attempted: 3, restored: 2,
      residueCount: 1, residue: [{ id: 'PRIVATE_NODE_ID', name: 'Private layer' }],
      internalFailure: 'customer content',
    },
  });
  assert.deepEqual(projectPublicError(raw), {
    kind: 'execution', message: 'A private node could not be restored', dispatchState: 'failed',
    mutation: { schemaVersion: 1, outcome: 'partial-residue', attempted: 3, restored: 2, residueCount: 1 },
  });
  const failure = projectPublicFailure(raw);
  assert.deepEqual(failure, {
    schemaVersion: 1, status: 'failed', errorKind: 'execution', dispatchState: 'failed',
    mutation: { schemaVersion: 1, outcome: 'partial-residue', attempted: 3, restored: 2, residueCount: 1 },
  });
  assert.equal(isPublicFailureProjection(failure), true);
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_NODE_ID|Private layer|customer content/);
  assert.match(formatPublicError(raw), /\[dispatch:failed\]/);
  assert.match(formatPublicError(raw), /\[mutation:partial-residue attempted:3 restored:2 residue:1\]/);
});

test('forged mutation reports never enter public projections', () => {
  for (const mutationReport of [
    null,
    { version: 2, outcome: 'partial-residue', attempted: 1, restored: 0, residueCount: 1 },
    { version: 1, outcome: 'future', attempted: 1, restored: 0, residueCount: 1 },
    { version: 1, outcome: 'partial-residue', attempted: -1, restored: 0, residueCount: 1 },
    { version: 1, outcome: 'partial-residue', attempted: 1, restored: 0, residueCount: 100_001 },
  ]) {
    const projected = projectPublicError(Object.assign(new Error('failed'), {
      mutationOutcome: 'partial-residue', mutationReport,
    }));
    assert.equal(Object.hasOwn(projected, 'mutation'), false);
  }
  assert.equal(isPublicFailureProjection({
    schemaVersion: 1, status: 'failed', errorKind: 'execution',
    mutation: { schemaVersion: 1, outcome: 'partial-residue', attempted: 1, restored: 0, residueCount: -1 },
  }), false);
});

test('legacy typed mutation reports converge on the same bounded projection', () => {
  const projected = projectPublicError(Object.assign(new Error('batch failed'), {
    kind: 'execution', dispatchState: 'failed', mutationOutcome: 'partial-residue',
    variableValueBatchMutationReport: {
      version: 1, outcome: 'partial-residue', attempted: 5, restored: 3,
      residual: 2, restoreFailures: ['private-mode-id'],
    },
  }));
  assert.deepEqual(projected.mutation, {
    schemaVersion: 1, outcome: 'partial-residue', attempted: 5, restored: 3, residueCount: 2,
  });
  assert.doesNotMatch(JSON.stringify(projected.mutation), /private-mode-id/);
});

test('mutation counts may describe different units without losing multi-field residue', () => {
  const raw = Object.assign(new Error('two-field rollback'), {
    kind: 'execution', dispatchState: 'failed', mutationOutcome: 'verification-unavailable',
    mutationReport: {
      version: 1, outcome: 'verification-unavailable', attempted: 1, restored: 0, residueCount: 2,
    },
  });
  assert.deepEqual(projectPublicFailure(raw)?.mutation, {
    schemaVersion: 1, outcome: 'verification-unavailable', attempted: 1, restored: 0, residueCount: 2,
  });
  assert.deepEqual(projectPublicFailure(publicError(raw))?.mutation,
    projectPublicFailure(raw)?.mutation, 'wrapping must not erase the validated projection');
});

test('MCP errors expose one closed layer, dispatch state and payload-free suggestion', () => {
  assert.deepEqual(projectMcpErrorContext(
    'Unknown or unsupported Figma Command — Unsupported option --future for var list. '
      + 'Accepted form: ["var","list","--limit","<1-1000>","--json"]. private-payload',
  ), {
    schemaVersion: 1,
    layer: 'whitelist',
    kind: 'command-rejected',
    dispatchState: 'not-dispatched',
    suggestion: 'Use ["var","list","--limit","<1-1000>","--json"].',
  });

  assert.deepEqual(projectMcpErrorContext(
    '[targeting] [dispatch:not-dispatched] No connected window matches the target.',
  ), {
    schemaVersion: 1,
    layer: 'transport',
    kind: 'targeting',
    dispatchState: 'not-dispatched',
    suggestion: 'Run figma_status to confirm the intended file, then retry the same request.',
  });

  const execution = projectMcpErrorContext(
    '[execution] [dispatch:failed] private mutation payload',
  );
  assert.equal(execution.layer, 'execution');
  assert.equal(execution.kind, 'execution');
  assert.equal(execution.dispatchState, 'failed');
  assert.match(execution.suggestion, /Inspect the target state before retrying/);
  assert.doesNotMatch(JSON.stringify(execution), /private mutation payload/);

  const unavailable = Object.assign(new Error('Plugin not connected'), {
    kind: 'plugin-unavailable',
    outcome: 'not-dispatched',
  });
  const formattedUnavailable = formatPublicError(unavailable);
  assert.match(formattedUnavailable, /\[plugin-unavailable\] \[dispatch:not-dispatched\]/);
  assert.deepEqual(projectMcpErrorContext(formattedUnavailable), {
    schemaVersion: 1,
    layer: 'transport',
    kind: 'plugin-unavailable',
    dispatchState: 'not-dispatched',
    suggestion: 'Run figma_connect once to wake or restore the configured Bridge, then retry the same not-dispatched request. Diagnose further only if figma_connect fails.',
  });

  assert.deepEqual(projectMcpErrorContext(
    'Plugin not connected — launch the local Bridge plugin in Figma first.',
  ), {
    schemaVersion: 1,
    layer: 'transport',
    kind: 'plugin-unavailable',
    dispatchState: 'not-dispatched',
    suggestion: 'Run figma_connect once to wake or restore the configured Bridge, then retry the same not-dispatched request. Diagnose further only if figma_connect fails.',
  });

  assert.equal(projectMcpErrorContext('[engine-timeout] operation deadline exceeded').layer,
    'execution');
});
