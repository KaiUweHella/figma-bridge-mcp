import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  devResourceMutationCode,
  devResourceMutationPlanRoute,
  devResourceMutationPlanningArgvFromRequest,
  executeDevResourceMutation,
  executeDevResourceMutationPlan,
} from '../src/application/dev-resource-mutation-command.js';
import {
  acceptsDevResourceMutationArgv,
  devResourceMutationArgvFromRequest,
  devResourceMutationFigmaUrlFileKeyFromArgv,
  parseDevResourceMutationRequest,
} from '../src/application/dev-resource-mutation-request.js';

const OLD = Object.freeze({
  name: 'Old docs',
  url: 'https://example.test/old',
  nodeId: '1:2',
  inheritedNodeId: null,
});

function fixture({
  initial = [OLD],
  primaryMode = 'normal',
  rollbackMode = 'normal',
  readFailures = [],
} = {}) {
  let resources = initial.map((value) => ({ ...value }));
  let writes = 0;
  let reads = 0;
  const apply = async (operation) => {
    writes += 1;
    const mode = writes === 1 ? primaryMode : rollbackMode;
    if (mode === 'throw-before') throw new Error('injected native failure');
    if (mode !== 'no-effect') operation(mode);
    if (mode === 'throw-after') throw new Error('injected acknowledgement failure');
  };
  const node = {
    id: '1:2', name: 'Card', type: 'FRAME',
    async getDevResourcesAsync() {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return resources.map((value) => ({
        ...value,
        ...(value.inheritedNodeId === null ? { inheritedNodeId: undefined } : {}),
      }));
    },
    async addDevResourceAsync(url, name = '') {
      return apply((mode) => {
        if (resources.some((value) => value.url === url)) throw new Error('duplicate');
        resources.push({
          name: mode === 'wrong' ? 'Wrong name' : (name || 'Derived name'),
          url,
          nodeId: '1:2',
          inheritedNodeId: null,
        });
      });
    },
    async deleteDevResourceAsync(url) {
      return apply((mode) => {
        const index = resources.findIndex((value) => value.url === url);
        if (index === -1) throw new Error('missing');
        if (mode === 'wrong') resources[index] = { ...resources[index], name: 'Wrong name' };
        else resources.splice(index, 1);
      });
    },
    async editDevResourceAsync(currentUrl, update) {
      return apply((mode) => {
        const index = resources.findIndex((value) => value.url === currentUrl);
        if (index === -1) throw new Error('missing');
        resources[index] = mode === 'wrong'
          ? { ...resources[index], name: 'Wrong name' }
          : { ...resources[index], ...update };
      });
    },
  };
  return {
    node,
    get resources() { return resources.map((value) => ({ ...value })); },
    get writes() { return writes; },
    figma: { getNodeByIdAsync: async (id) => id === node.id ? node : null },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Dev Resource Mutation request closes actions, options, literals, and URL target identity', () => {
  assert.deepEqual(parseDevResourceMutationRequest([
    'dev', 'link', '-n', 'Storybook', '1-2', 'https://example.test/storybook',
  ]), {
    action: 'link', nodeId: '1:2', url: 'https://example.test/storybook',
    currentUrl: null, newUrl: null, name: 'Storybook',
  });
  assert.deepEqual(parseDevResourceMutationRequest([
    'dev', 'edit', '--name=New docs', '--', '1:2',
    'https://example.test/old', 'https://example.test/new',
  ]), {
    action: 'edit', nodeId: '1:2', url: null,
    currentUrl: 'https://example.test/old', newUrl: 'https://example.test/new',
    name: 'New docs',
  });
  assert.deepEqual(devResourceMutationArgvFromRequest({
    action: 'unlink', nodeId: '1-2', url: '-private-resource',
  }), ['dev', 'unlink', '--', '1:2', '-private-resource']);

  const target = 'https://www.figma.com/design/FILEA/Dev-Lab?node-id=1-2';
  const payload = 'https://www.figma.com/design/FILEB/Payload';
  const planning = devResourceMutationPlanningArgvFromRequest({
    action: 'link', nodeId: target, url: payload, name: 'Storybook',
  });
  assert.equal(devResourceMutationFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.includes(payload), true);
  assert.deepEqual(plan.argv.slice(0, 4), ['dev', 'link', '--name=Storybook', '--']);

  for (const argv of [
    ['dev', 'link', '1:2'],
    ['dev', 'unlink', '--name=forbidden', '1:2', 'https://example.test'],
    ['dev', 'edit', '1:2', 'old'],
    ['dev', 'link', '--future', 'private', '1:2', 'url'],
    ['dev', 'link', 'not-a-node', 'url'],
    ['dev', 'link', '1:2', 'url', 'extra'],
  ]) assert.equal(acceptsDevResourceMutationArgv(argv), false, argv.join(' '));
});

test('link, unlink, and edit mutate once and prove exact fresh state', async () => {
  const linked = fixture({ initial: [] });
  const link = await executeDevResourceMutation({
    action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
  }, { evaluate: evaluate(linked.figma) });
  assert.equal(linked.writes, 1);
  assert.deepEqual(link.result.resource, {
    name: 'New docs', url: 'https://example.test/new', nodeId: '1:2', inheritedNodeId: null,
  });
  assert.match(link.stdout, /^Linked: Card \(1:2\)/);

  const unlinked = fixture();
  const unlink = await executeDevResourceMutation({
    action: 'unlink', nodeId: '1:2', url: OLD.url,
  }, { evaluate: evaluate(unlinked.figma) });
  assert.equal(unlinked.writes, 1);
  assert.deepEqual(unlinked.resources, []);
  assert.equal(unlink.result.status, 'unlinked');
  assert.match(unlink.stdout, /Remaining dev resources: 0/);

  const edited = fixture();
  const edit = await executeDevResourceMutation({
    action: 'edit', nodeId: '1:2', currentUrl: OLD.url,
    newUrl: 'https://example.test/new', name: 'New docs',
  }, { evaluate: evaluate(edited.figma) });
  assert.equal(edited.writes, 1);
  assert.deepEqual(edited.resources[0], {
    name: 'New docs', url: 'https://example.test/new', nodeId: '1:2', inheritedNodeId: null,
  });
  assert.equal(edit.result.status, 'edited');
});

test('a native error is successful only when fresh state proves the exact request', async () => {
  const live = fixture({ initial: [], primaryMode: 'throw-after' });
  const result = await executeDevResourceMutation({
    action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /native mutation reported an error/);
  assert.equal(live.writes, 1);
});

test('preflight refuses duplicates, missing resources, inherited resources, and missing nodes', async () => {
  for (const [request, live] of [
    [{ action: 'link', nodeId: '1:2', url: OLD.url }, fixture()],
    [{ action: 'unlink', nodeId: '1:2', url: 'https://example.test/missing' }, fixture()],
    [{ action: 'edit', nodeId: '1:2', currentUrl: OLD.url, newUrl: 'new' }, fixture({
      initial: [{ ...OLD, inheritedNodeId: '9:8' }],
    })],
    [{ action: 'unlink', nodeId: '9:9', url: OLD.url }, fixture()],
  ]) {
    await assert.rejects(
      () => executeDevResourceMutation(request, { evaluate: evaluate(live.figma) }),
      (error) => error.mutationOutcome === 'no-mutation'
        && error.mutationReport.attempted === 0,
    );
    assert.equal(live.writes, 0);
  }
});

test('unchanged writes, successful rollback, residue, and unavailable verification stay distinct', async () => {
  const unchanged = fixture({ initial: [], primaryMode: 'no-effect' });
  await assert.rejects(
    () => executeDevResourceMutation({
      action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
    }, { evaluate: evaluate(unchanged.figma) }),
    (error) => error.mutationOutcome === 'unchanged'
      && error.mutationReport.residueCount === 1,
  );
  assert.equal(unchanged.writes, 1);

  const rolledBack = fixture({ initial: [], primaryMode: 'wrong' });
  await assert.rejects(
    () => executeDevResourceMutation({
      action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
    }, { evaluate: evaluate(rolledBack.figma) }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.restored === 1,
  );
  assert.deepEqual(rolledBack.resources, []);
  assert.equal(rolledBack.writes, 2);

  const residue = fixture({ initial: [], primaryMode: 'wrong', rollbackMode: 'no-effect' });
  await assert.rejects(
    () => executeDevResourceMutation({
      action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
    }, { evaluate: evaluate(residue.figma) }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
  assert.equal(residue.resources.length, 1);

  const unavailable = fixture({
    initial: [], primaryMode: 'wrong', readFailures: [3],
  });
  await assert.rejects(
    () => executeDevResourceMutation({
      action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
    }, { evaluate: evaluate(unavailable.figma) }),
    (error) => error.mutationOutcome === 'verification-unavailable'
      && error.mutationReport.residueCount === 1,
  );
});

test('Dev Resource Mutation validates Plugin claims and generated code', async () => {
  const request = {
    action: 'link', nodeId: '1:2', url: 'https://example.test/new', name: 'New docs',
  };
  for (const malformed of [
    null,
    '{',
    JSON.stringify({ status: 'linked' }),
    JSON.stringify({
      schemaVersion: 1, status: 'linked', action: 'link', outcome: 'verified',
      node: { id: '1:3', name: 'Card', type: 'FRAME' },
      resource: { name: 'New docs', url: request.url, nodeId: '1:3', inheritedNodeId: null },
      count: 1, attempted: 1, residue: [], warnings: [],
    }),
  ]) {
    await assert.rejects(
      () => executeDevResourceMutation(request, { evaluate: async () => malformed }),
      /invalid/i,
    );
  }
  const code = devResourceMutationCode({
    ...request,
    name: '`); globalThis.DEV_RESOURCE_INJECTED = true; //',
  });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.DEV_RESOURCE_INJECTED, undefined);
});

test('CLI and MCP share one non-retrying write Plan and Application route', async () => {
  const cli = planFigmaCommand([
    'dev', 'edit', '1-2', OLD.url, 'https://example.test/new', '--name', 'New docs',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'dev', 'edit', '--name=New docs', '--', '1:2', OLD.url, 'https://example.test/new',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(devResourceMutationPlanRoute(cli), 'command-application');
  assert.throws(() => devResourceMutationPlanRoute({ ...cli }), /requires a Command Plan/);

  const live = fixture();
  const result = await executeDevResourceMutationPlan(cli, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'edited');
  assert.equal(devResourceMutationPlanRoute(
    planFigmaCommand(['dev', 'list', '1:2'], { adapter: 'mcp' }),
  ), 'not-dev-resource-mutation');
});
