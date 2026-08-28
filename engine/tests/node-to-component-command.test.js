import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  MAX_NODE_TO_COMPONENT_RESULT_CODE_UNITS,
  executeNodeToComponent,
  executeNodeToComponentPlan,
  nodeToComponentArgvFromRequest,
  nodeToComponentCode,
  nodeToComponentPlanRoute,
  nodeToComponentPlanningArgvFromRequest,
} from '../src/application/node-to-component-command.js';
import { parseNodeToComponentRequest } from '../src/application/node-to-component-request.js';
import { parseStructuredMutationReport } from '../src/lib/daemon-error-envelope.js';

function fixture({
  types = ['FRAME', 'GROUP'],
  replacementIds = false,
  failAt = null,
  throwAfterConvertAt = null,
  failFreshReadAt = null,
} = {}) {
  const document = { id: '0:0', type: 'DOCUMENT', children: [] };
  const page = { id: '1:1', type: 'PAGE', parent: document, children: [] };
  document.children.push(page);
  const nodes = types.map((type, index) => ({
    id: `2:${index + 1}`,
    type,
    name: `Source ${index + 1}`,
    parent: page,
    children: [{ id: `3:${index + 1}` }],
  }));
  page.children.push(...nodes);
  let calls = 0;
  let converted = 0;
  const nodeById = (id) => {
    if (id === document.id) return document;
    if (id === page.id) return page;
    return page.children.find((node) => node.id === id) || null;
  };
  const figma = {
    async getNodeByIdAsync(id) {
      calls += 1;
      if (failFreshReadAt !== null && converted > failFreshReadAt) {
        throw new Error('injected fresh-read failure');
      }
      return nodeById(id);
    },
    createComponentFromNode(node) {
      const index = nodes.findIndex((candidate) => candidate.id === node.id);
      if (index === failAt) throw new Error('injected conversion failure');
      const component = replacementIds ? {
        ...node, id: `4:${index + 1}`, type: 'COMPONENT', parent: page,
      } : node;
      component.type = 'COMPONENT';
      if (replacementIds) page.children.splice(page.children.indexOf(node), 1, component);
      converted += 1;
      if (index === throwAfterConvertAt) throw new Error('injected acknowledgement failure');
      return component;
    },
  };
  return { figma, page, nodes, conversionCount: () => converted, calls: () => calls };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (nodeIds = ['2:1', '2:2']) => ({ nodeIds });

test('Node to-component closes every URL target and canonicalizes the batch', () => {
  const url1 = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const url2 = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(parseNodeToComponentRequest([
    'node', 'to-component', url1, url2,
  ]), { nodeIds: ['2:1', '2:2'] });
  assert.deepEqual(nodeToComponentArgvFromRequest(request()), [
    'node', 'to-component', '2:1', '2:2',
  ]);
  assert.deepEqual(nodeToComponentPlanningArgvFromRequest({ nodeIds: [url1, url2] }), [
    'node', 'to-component', url1, url2,
  ]);
  const plan = planFigmaCommand(['node', 'to-component', url1, url2], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'to-component', '2:1', '2:2']);
  for (const argv of [
    ['node', 'to-component'],
    ['node', 'to-component', 'bad'],
    ['node', 'to-component', '2:1', '2-1'],
    ['node', 'to-component', url1, 'https://www.figma.com/design/FILEB/Test?node-id=2-2'],
    ['node', 'to-component', '2:1', '--future'],
  ]) assert.throws(() => parseNodeToComponentRequest(argv), /Invalid node to-component command/);
});

test('multiple Frames and Groups convert once each and keep exact structure', async () => {
  const live = fixture();
  const result = await executeNodeToComponent(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'converted');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.converted.map(({ id }) => id), ['2:1', '2:2']);
  assert.deepEqual(result.result.converted.map(({ childCount }) => childCount), [1, 1]);
  assert.equal(live.conversionCount(), 2);
  assert.deepEqual(live.page.children.map(({ type }) => type), ['COMPONENT', 'COMPONENT']);
});

test('replacement Component identities are accepted only at their exact parent indexes', async () => {
  const live = fixture({ replacementIds: true });
  const result = await executeNodeToComponent(request(), { evaluate: evaluate(live.figma) });
  assert.deepEqual(result.result.converted.map(({ id }) => id), ['4:1', '4:2']);
  assert.deepEqual(live.page.children.map(({ id }) => id), ['4:1', '4:2']);
});

test('an acknowledgement error succeeds only when fresh readback proves the Component', async () => {
  const live = fixture({ throwAfterConvertAt: 0 });
  const result = await executeNodeToComponent(request(['2:1']), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.conversionCount(), 1);
});

test('exact bounded names are verified before and after conversion while output stays inert', async () => {
  const live = fixture();
  live.nodes[0].name = 'Source\u0007\u202e exact';
  const result = await executeNodeToComponent(request(['2:1']), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(live.nodes[0].name, 'Source\u0007\u202e exact');
  assert.doesNotMatch(result.stdout, /\u0007|\u202e/);
  assert.equal(result.result.converted[0].name, 'Source   exact');
});

test('a target lost after preflight makes no native call and reports no Bridge mutation', async () => {
  const live = fixture({ types: ['FRAME'] });
  const originalRead = live.figma.getNodeByIdAsync;
  let sourceReads = 0;
  live.figma.getNodeByIdAsync = async (id) => {
    if (id === '2:1' && ++sourceReads === 2) return null;
    return originalRead(id);
  };
  await assert.rejects(() => executeNodeToComponent(request(['2:1']), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(live.conversionCount(), 0);
});

test('an unbounded target name refuses before native conversion', async () => {
  const live = fixture({ types: ['FRAME'] });
  live.nodes[0].name = 'n'.repeat(1_025);
  await assert.rejects(() => executeNodeToComponent(request(['2:1']), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    return true;
  });
  assert.equal(live.conversionCount(), 0);
});

test('every invalid target refuses before the first native conversion', async () => {
  const live = fixture({ types: ['FRAME', 'RECTANGLE'] });
  await assert.rejects(() => executeNodeToComponent(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.outcome, 'no-mutation');
    return true;
  });
  assert.equal(live.conversionCount(), 0);
  assert.deepEqual(live.page.children.map(({ type }) => type), ['FRAME', 'RECTANGLE']);
});

test('a later conversion failure preserves exact irreversible residue without retrying', async () => {
  const live = fixture({ failAt: 1 });
  await assert.rejects(() => executeNodeToComponent(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.created, 1);
    assert.deepEqual(error.mutationReport.residue.map(({ handle }) => handle), ['2:1']);
    return true;
  });
  assert.equal(live.conversionCount(), 1);
  assert.deepEqual(live.page.children.map(({ type }) => type), ['COMPONENT', 'GROUP']);
});

test('large partial residue stays bounded and valid across the Daemon error contract', async () => {
  const count = 61;
  const live = fixture({ types: Array.from({ length: count }, () => 'FRAME'), failAt: count - 1 });
  const nodeIds = Array.from({ length: count }, (_, index) => `2:${index + 1}`);
  await assert.rejects(() => executeNodeToComponent(request(nodeIds), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationReport.created, 60);
    assert.equal(error.mutationReport.residueCount, 60);
    assert.equal(error.mutationReport.residue.length, 50);
    assert.equal(error.mutationReport.residueTruncated, true);
    assert.deepEqual(parseStructuredMutationReport(error.mutationReport), error.mutationReport);
    return true;
  });
  assert.equal(live.conversionCount(), 60);
});

test('generated conversion code keeps node identities inert and returns one bounded JSON value', () => {
  const code = nodeToComponentCode(request(['2:1']));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.match(code, /createComponentFromNode/);
  assert.match(code, /JSON\.stringify/);
  assert.doesNotMatch(code, /eval\(|Function\(/);
});

test('only one authentic non-retrying node.to-component Plan crosses the Application seam', async () => {
  const plan = planFigmaCommand(['node', 'to-component', '2:1', '2:2'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.to-component');
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeToComponentPlanRoute(plan), 'command-application');
  assert.throws(() => nodeToComponentPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeNodeToComponentPlan(plan, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluate(live.figma)(code);
    },
  });
  assert.equal(result.result.status, 'converted');
  assert.equal(evaluations, 1);
});

test('malformed or oversized Plugin results never become conversion success', async () => {
  for (const value of [
    null, {}, 'not-json', JSON.stringify({ status: 'converted' }),
    'x'.repeat(MAX_NODE_TO_COMPONENT_RESULT_CODE_UNITS + 1),
  ]) {
    await assert.rejects(() => executeNodeToComponent(request(['2:1']), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});
