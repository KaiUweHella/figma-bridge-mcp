import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordRuntimeTrace,
  runtimeTraceEnabled,
} from '../engine/src/lib/runtime-trace.js';

test('runtime traces are opt-in, bounded to safe fields and content-free', () => {
  const directory = mkdtempSync(join(tmpdir(), 'figma-bridge-runtime-trace-test-'));
  const tracePath = join(directory, 'trace.jsonl');
  const previous = process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH;
  delete process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH;
  assert.equal(runtimeTraceEnabled(), false);
  process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH = tracePath;
  assert.equal(runtimeTraceEnabled(), true);
  try {
    recordRuntimeTrace({
      kind: 'daemon-execution',
      action: 'eval',
      elapsedMs: 12.5,
      requestBytes: 100,
      responseBytes: 200,
      pluginExecutionTiming: { version: 1, queuedMs: 2, executionMs: 7, totalMs: 9 },
      secretPayload: 'must-not-be-written',
      fileKey: 'must-not-be-written',
    });
    const text = readFileSync(tracePath, 'utf8');
    const event = JSON.parse(text.trim());
    assert.equal(event.kind, 'daemon-execution');
    assert.equal(event.action, 'eval');
    assert.equal(event.elapsedMs, 12.5);
    assert.ok(event.processRssBytes > 0);
    assert.equal(event.pluginExecutionTiming.executionMs, 7);
    assert.doesNotMatch(text, /must-not-be-written|fileKey|secretPayload/);
  } finally {
    if (previous === undefined) delete process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH;
    else process.env.FIGMA_BRIDGE_RUNTIME_TRACE_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
