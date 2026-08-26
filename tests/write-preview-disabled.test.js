import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testState = mkdtempSync(join(tmpdir(), 'figma-bridge-preview-disabled-'));
process.env.PLUGIN_KEY_FILE = join(testState, 'plugin-key');
process.env.AUDIT_LOG_PATH = join(testState, 'audit.log');
delete process.env.FIGMA_WRITE_CONFIRM;

test('explicit preview remains non-mutating when write confirmation is disabled', async () => {
  const {
    commandPreviewReason,
    handleTool,
    planFigmaRunCommand,
    writeExecutionPolicyFacts,
    writeExecutionPolicyStatusLines,
  } = await import('../src/server.js');
  assert.deepEqual(writeExecutionPolicyFacts(), {
    version: 1,
    confirmation: 'disabled',
    guaranteedPreview: true,
    previewTools: ['figma_run', 'figma_render'],
  });
  assert.equal(writeExecutionPolicyStatusLines()[0], 'write confirmation: disabled');
  const plan = planFigmaRunCommand(['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', 'name']);
  assert.equal(commandPreviewReason({}, plan), null,
    'disabled confirmation must preserve intentional one-shot execution');
  assert.equal(commandPreviewReason({ confirm: false }, plan), null,
    'confirm:false is policy input, not preview intent');
  assert.equal(commandPreviewReason({ preview: true, confirm: true }, plan), 'explicit-preview');

  const result = await handleTool('figma_run', {
    args: ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '-v', '12', 'must-not-be-created'],
    preview: true,
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Guaranteed non-mutating Command Preview/);
  assert.match(result.content[0].text, /effective confirmation policy: disabled/);
  assert.match(result.content[0].text, /dispatched: no/);
  assert.doesNotMatch(result.content[0].text, /must-not-be-created/);
});
