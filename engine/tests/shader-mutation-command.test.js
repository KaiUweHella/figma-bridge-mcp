import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeShaderMutation,
  executeShaderMutationPlan,
  shaderMutationCode,
  shaderMutationPlanRoute,
} from '../src/application/shader-mutation-command.js';
import {
  acceptsShaderMutationArgv,
  parseShaderMutationRequest,
  shaderMutationArgvFromRequest,
  shaderMutationFigmaUrlFileKeyFromArgv,
  shaderMutationPlanningArgvFromRequest,
} from '../src/application/shader-mutation-request.js';

function fixture({ setter = 'apply', importMismatch = false, longDefinition = false } = {}) {
  const shader = {
    id: 'SH:1', name: 'Glow', type: 'fill', imported: true,
    propertyDefinitions: {
      power: {
        name: 'Power', type: 'NUMBER', defaultValue: 1,
        description: longDefinition ? 'x'.repeat(100_000) : 'Intensity',
      },
    },
  };
  let fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  let imports = 0;
  let writes = 0;
  const node = {
    id: '1:2', name: 'Target', type: 'RECTANGLE', strokes: [], effects: [],
    get fills() { return fills; },
    set fills(value) {
      writes += 1;
      if (setter === 'throw-after-apply' && writes === 1) { fills = structuredClone(value); throw new Error('setter failed'); }
      if (setter === 'ignore' && writes === 1) return;
      if (['wrong', 'rollback-fails'].includes(setter) && writes === 1) { fills = [{ type: 'SHADER', id: 'OTHER' }]; return; }
      if (setter === 'rollback-fails' && writes > 1) return;
      fills = structuredClone(value);
    },
  };
  const figma = {
    editorType: 'figma', mixed: Symbol('mixed'),
    listAvailableShaders: async () => [importMismatch ? { ...shader, id: 'OTHER' } : shader],
    importShaderById: async (id) => { imports += 1; return { ...shader, id }; },
    getNodeByIdAsync: async (id) => id === node.id ? node : null,
  };
  return { figma, imports: () => imports, writes: () => writes, node, shader };
}

const plugin = (request, figma) => new Function('figma', `return ${shaderMutationCode(request)}`)(figma);

test('Shader Mutation closes import/apply requests and projects only the apply node URL', () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-2';
  assert.deepEqual(parseShaderMutationRequest(['shader', 'import', '--', ' SH:1 ']), {
    action: 'import', nodeId: null, shaderId: 'SH:1', field: null, properties: null, replace: false,
  });
  assert.deepEqual(parseShaderMutationRequest([
    'shader', 'apply', url, 'SH:1', '--field=fill', '--properties', '{"power":2}', '--replace',
  ]), {
    action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: { power: 2 }, replace: true,
  });
  assert.equal(shaderMutationFigmaUrlFileKeyFromArgv([
    'shader', 'apply', url, 'SH:1', '--field', 'fill',
  ]), 'PLACEHOLDERFILEKEY');
  for (const argv of [
    ['shader', 'import'],
    ['shader', 'import', 'SH:1', '--replace'],
    ['shader', 'apply', '1:2', 'SH:1'],
    ['shader', 'apply', '1:2', 'SH:1', '--field', 'unknown'],
    ['shader', 'apply', '1:2', 'SH:1', '--field', 'fill', '--future', 'private-value'],
  ]) assert.equal(acceptsShaderMutationArgv(argv), false, argv.join(' '));
});

test('Shader Import invokes native materialization once and freshly verifies bounded facts', async () => {
  const source = fixture({ longDefinition: true });
  const result = await executeShaderMutation({ action: 'import', shaderId: 'SH:1' }, {
    evaluate: async () => plugin({ action: 'import', shaderId: 'SH:1' }, source.figma),
  });
  assert.equal(result.result.status, 'imported');
  assert.equal(result.result.shader.id, 'SH:1');
  assert.equal(result.result.shader.propertyDefinitions.power.description.length, 4096);
  assert.equal(source.imports(), 1);
});

test('Shader Apply verifies exact field placement, preserves native defaults and never imports', async () => {
  const source = fixture();
  const result = await executeShaderMutation({
    action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill',
    properties: { power: 2 }, replace: false,
  }, { evaluate: async (code) => new Function('figma', `return ${code}`)(source.figma) });
  assert.equal(result.result.status, 'applied');
  assert.equal(result.result.count, 2);
  assert.deepEqual(source.node.fills.at(-1), { type: 'SHADER', id: 'SH:1', properties: { power: 2 } });
  assert.equal(source.imports(), 0);
  assert.equal(source.writes(), 1);
});

test('Shader Mutation preserves verified-after-error, rollback and irreversible import uncertainty', async () => {
  const afterError = fixture({ setter: 'throw-after-apply' });
  const verified = await executeShaderMutation({
    action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true,
  }, { evaluate: async () => plugin({ action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true }, afterError.figma) });
  assert.equal(verified.result.outcome, 'verified-after-error');

  const wrong = fixture({ setter: 'wrong' });
  await assert.rejects(() => executeShaderMutation({
    action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true,
  }, { evaluate: async () => plugin({ action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true }, wrong.figma) }),
  (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);

  const residue = fixture({ setter: 'rollback-fails' });
  await assert.rejects(() => executeShaderMutation({
    action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true,
  }, { evaluate: async () => plugin({ action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: null, replace: true }, residue.figma) }),
  (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);

  const imported = fixture({ importMismatch: true });
  await assert.rejects(() => executeShaderMutation({ action: 'import', shaderId: 'SH:1' }, {
    evaluate: async () => plugin({ action: 'import', shaderId: 'SH:1' }, imported.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.residueCount === 1 && imported.imports() === 1);
});

test('Shader Mutation uses one non-retrying canonical Plan in both Adapters', async () => {
  const requests = [
    { action: 'import', shaderId: 'SH:1' },
    { action: 'apply', nodeId: '1:2', shaderId: 'SH:1', field: 'fill', properties: { power: 2 }, replace: false },
  ];
  for (const request of requests) {
    const cli = planFigmaCommand(shaderMutationArgvFromRequest(request), { adapter: 'cli' });
    const mcp = planFigmaCommand(shaderMutationPlanningArgvFromRequest(request), { adapter: 'mcp' });
    assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.execution.retry, 'never');
    assert.equal(shaderMutationPlanRoute(mcp), 'command-application');
    const source = fixture(); let evaluations = 0;
    await executeShaderMutationPlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return new Function('figma', `return ${code}`)(source.figma); },
    });
    assert.equal(evaluations, 1);
  }
});
