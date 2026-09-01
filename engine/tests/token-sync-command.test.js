import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenSync,
  prepareTokenSyncPlan,
  tokenSyncPlanRoute,
  withTokenSyncPlanLock,
} from '../src/application/token-sync-command.js';
import {
  acceptsTokenSyncArgv,
  parseTokenSyncRequest,
  tokenSyncArgvFromRequest,
} from '../src/application/token-sync-request.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

function figmaFixture({ existing = [], duplicateCollection = false, fileKey = 'FILE_A' } = {}) {
  let next = 0;
  const collections = [];
  const variables = [];
  const makeCollection = (name, id = `c${++next}`) => {
    const collection = { id, name, remote: false,
      modes: [{ modeId: `${id}:mode`, name: 'Default' }], variableIds: [] };
    collections.push(collection); return collection;
  };
  const target = makeCollection('Design Tokens', 'c1');
  if (duplicateCollection) makeCollection('Design Tokens', 'c2');
  const makeVariable = (name, type, value, collection = target, id = `v${++next}`) => {
    const variable = {
      id, name, resolvedType: type, remote: false,
      variableCollectionId: collection.id,
      valuesByMode: { [collection.modes[0].modeId]: value },
      scopes: [], codeSyntax: {},
      setValueForMode(modeId, nextValue) { this.valuesByMode[modeId] = nextValue; },
      setVariableCodeSyntax(platform, syntax) { this.codeSyntax[platform] = syntax; },
      removeVariableCodeSyntax(platform) { delete this.codeSyntax[platform]; },
      remove() {
        const index = variables.indexOf(variable); if (index >= 0) variables.splice(index, 1);
        collection.variableIds = collection.variableIds.filter((candidate) => candidate !== id);
      },
    };
    variables.push(variable); collection.variableIds.push(id); return variable;
  };
  for (const item of existing) {
    makeVariable(item.name, item.type, item.value, target, item.id);
  }
  const figma = { fileKey, variables: {
    getLocalVariableCollectionsAsync: async () => collections,
    getLocalVariablesAsync: async () => variables,
    createVariableCollection: (name) => makeCollection(name),
    createVariable: (name, collection, type) => makeVariable(name, type, undefined, collection),
  } };
  const evaluate = async (code) => new Function('figma', `return ${code};`)(figma);
  return { figma, collections, variables, target, evaluate, makeVariable };
}

function prepared({ value = 8, apply = false, lock = null } = {}) {
  return {
    request: { file: '/workspace/tokens.json', collection: 'Design Tokens', apply,
      prune: false, ours: false, theirs: false, lockfile: null },
    tokens: [{ name: 'space/md', type: 'FLOAT', value }],
    lock,
    lockPath: '/workspace/figma-tokens.lock.json',
    lockInvalid: false,
    declaredElsewhere: [],
  };
}

function workspace({ fail = false } = {}) {
  const writes = [];
  const publish = (path, value, options) => {
    if (fail) throw new Error('injected lock publication failure');
    writes.push({ path, value, options });
  };
  return {
    writes,
    write: publish,
    replace: publish,
  };
}

test('closed request canonicalizes every option and rejects ambiguous argv', () => {
  assert.deepEqual(parseTokenSyncRequest([
    'tokens', 'sync', '--apply', '--prune', '--ours', '-c', 'Tokens',
    '--lockfile=state.lock.json', '--', '-tokens.json',
  ]), {
    file: '-tokens.json', collection: 'Tokens', apply: true, prune: true,
    ours: true, theirs: false, lockfile: 'state.lock.json',
  });
  assert.deepEqual(tokenSyncArgvFromRequest({
    file: '-tokens.json', collection: 'Tokens', apply: true, prune: false,
    ours: false, theirs: true, lockfile: null,
  }), ['tokens', 'sync', '--collection=Tokens', '--apply', '--theirs', '--', '-tokens.json']);
  for (const argv of [
    ['tokens', 'sync'],
    ['tokens', 'sync', '--wat', 'tokens.json'],
    ['tokens', 'sync', '--apply', '--apply', 'tokens.json'],
    ['tokens', 'sync', '--ours', '--theirs', 'tokens.json'],
    ['tokens', 'sync', 'one.json', 'two.json'],
  ]) assert.equal(acceptsTokenSyncArgv(argv), false, argv.join(' '));
});

test('one cross-Adapter Plan distinguishes dry-run read from non-retrying apply', () => {
  const dry = planFigmaCommand(['tokens', 'sync', 'tokens.json'], {
    adapter: 'mcp', workspaceDir: '/workspace', fileKey: 'FILE_A',
  });
  const apply = planFigmaCommand(['tokens', 'sync', 'tokens.json', '--apply'], {
    adapter: 'mcp', workspaceDir: '/workspace', fileKey: 'FILE_A',
  });
  assert.equal(tokenSyncPlanRoute(dry), 'command-application');
  assert.deepEqual(dry.effects, {
    figma: 'read', editor: 'none', workspace: 'read', network: 'none', shared: 'none',
  });
  assert.equal(dry.execution.retry, 'safe-read');
  assert.deepEqual(dry.execution.okExitCodes, [0, 1]);
  assert.deepEqual(dry.outputs, []);
  assert.equal(apply.effects.figma, 'write');
  assert.equal(apply.effects.workspace, 'write');
  assert.equal(apply.execution.retry, 'never');
  assert.deepEqual(apply.outputs, [{
    role: 'token-lockfile', path: '/workspace/figma-tokens.lock.json',
  }]);
  const cli = planFigmaCommand(apply.argv, {
    adapter: 'cli', workspaceDir: '/workspace', fileKey: 'FILE_A',
  });
  assert.deepEqual(cli.argv, apply.argv);
  assert.deepEqual(cli.effects, apply.effects);
  assert.deepEqual(cli.execution, apply.execution);
});

test('source and optional lock are prepared before any Figma readiness', () => {
  const plan = planFigmaCommand(['tokens', 'sync', 'tokens.json'], {
    adapter: 'mcp', workspaceDir: '/workspace',
  });
  const reads = [];
  const result = prepareTokenSyncPlan(plan, { workspaceIO: {
    exists(path, options) { assert.equal(path, '/workspace/figma-tokens.lock.json');
      assert.deepEqual(options, { role: 'token-lockfile', kind: 'file' }); return false; },
    readText(path, options) { reads.push({ path, options }); return JSON.stringify({
      space: { md: { $type: 'dimension', $value: '8px' } },
    }); },
    write() { throw new Error('preparation must not write'); },
  } });
  assert.deepEqual(reads, [{
    path: '/workspace/tokens.json', options: { role: 'token-file' },
  }]);
  assert.equal(result.tokens[0].name, 'space/md');
});

test('one lockfile serializes concurrent Token Sync transactions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'figma-bridge-token-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tokens'));
  const source = join(root, 'tokens', 'source.json');
  writeFileSync(source, JSON.stringify({
    space: { md: { $type: 'number', $value: 8 } },
  }));
  const lockfile = join(root, 'tokens', 'state.lock.json');
  const plan = planFigmaCommand([
    'tokens', 'sync', '--apply', `--lockfile=${lockfile}`, '--', source,
  ], { adapter: 'mcp', workspaceDir: root, fileKey: 'FILE_A' });
  const io = createWorkspaceIO({ root });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const first = withTokenSyncPlanLock(plan, { workspaceIO: io }, async () => {
    order.push('first-enter'); firstEntered(); await firstGate; order.push('first-exit');
  });
  await entered;
  const second = withTokenSyncPlanLock(plan, { workspaceIO: io }, async () => {
    order.push('second-enter');
  });

  assert.deepEqual(order, ['first-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
});

test('one canonical lock target serializes contained symlink aliases with a missing parent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'figma-bridge-token-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.json');
  const locks = join(root, 'locks');
  const alias = join(root, 'locks-alias');
  mkdirSync(locks);
  symlinkSync(locks, alias);
  writeFileSync(source, JSON.stringify({ token: { $type: 'number', $value: 1 } }));
  const realPlan = planFigmaCommand([
    'tokens', 'sync', '--apply', `--lockfile=${join(locks, 'new', 'state.json')}`, '--', source,
  ], { adapter: 'mcp', workspaceDir: root, fileKey: 'FILE_A' });
  const aliasPlan = planFigmaCommand([
    'tokens', 'sync', '--apply', `--lockfile=${join(alias, 'new', 'state.json')}`, '--', source,
  ], { adapter: 'mcp', workspaceDir: root, fileKey: 'FILE_A' });
  const io = createWorkspaceIO({ root });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const first = withTokenSyncPlanLock(realPlan, { workspaceIO: io }, async () => {
    order.push('first-enter'); firstEntered(); await firstGate; order.push('first-exit');
  });
  await entered;
  const second = withTokenSyncPlanLock(aliasPlan, { workspaceIO: io }, async () => {
    order.push('second-enter');
  });

  assert.deepEqual(order, ['first-enter']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter']);
});

test('an expired Token Sync lock waiter never enters its transaction', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'figma-bridge-token-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source.json');
  writeFileSync(source, JSON.stringify({ token: { $type: 'number', $value: 1 } }));
  const plan = planFigmaCommand(['tokens', 'sync', '--apply', '--', source], {
    adapter: 'mcp', workspaceDir: root, fileKey: 'FILE_A',
  });
  const io = createWorkspaceIO({ root });
  let entered = false;

  await assert.rejects(
    withTokenSyncPlanLock(plan, { workspaceIO: io, remainingMs: () => 0 }, async () => {
      entered = true;
    }),
    (error) => error.kind === 'timeout',
  );
  assert.equal(entered, false);
});

test('source preparation preserves zero and false but rejects invalid declared scalars', () => {
  const plan = planFigmaCommand(['tokens', 'sync', 'tokens.json'], {
    adapter: 'mcp', workspaceDir: '/workspace',
  });
  const io = (content) => ({
    exists: () => false,
    readText: () => content,
    write() { throw new Error('preparation must not write'); },
  });
  const valid = prepareTokenSyncPlan(plan, { workspaceIO: io(JSON.stringify({
    zero: { $type: 'number', $value: 0 },
    disabled: { $type: 'boolean', $value: false },
  })) });
  assert.equal(valid.tokens.find((token) => token.name === 'zero').value, 0);
  assert.equal(valid.tokens.find((token) => token.name === 'disabled').value, false);
  assert.throws(() => prepareTokenSyncPlan(plan, { workspaceIO: io(JSON.stringify({
    bad: { $type: 'dimension', $value: 'nope' },
  })) }), /FLOAT values must be finite numeric values/);
  assert.throws(() => prepareTokenSyncPlan(plan, { workspaceIO: io(JSON.stringify({
    bad: { $type: 'boolean', $value: 'not-a-boolean' },
  })) }), /BOOLEAN values must be true or false/);
});

test('source Collection metadata matches the requested Figma name exactly', () => {
  const plan = planFigmaCommand(['tokens', 'sync', 'tokens.json'], {
    adapter: 'mcp', workspaceDir: '/workspace',
  });
  const result = prepareTokenSyncPlan(plan, { workspaceIO: {
    exists: () => false,
    readText: () => JSON.stringify({
      exact: { $type: 'number', $value: 1, $extensions: {
        'figma-bridge-mcp': { collection: 'Design Tokens' },
      } },
      wrongCase: { $type: 'number', $value: 2, $extensions: {
        'figma-bridge-mcp': { collection: 'design tokens' },
      } },
    }),
  } });

  assert.deepEqual(result.tokens.map((token) => token.name), ['exact']);
  assert.deepEqual(result.declaredElsewhere, [{
    name: 'wrongCase', collection: 'design tokens',
  }]);
});

test('apply revalidates the exact preflight and makes no mutation after a race', async () => {
  const fixture = figmaFixture({ existing: [
    { id: 'v1', name: 'space/md', type: 'FLOAT', value: 8 },
  ] });
  const lock = { version: 1, collection: 'Design Tokens', fileKey: null,
    syncedAt: '2026-09-01T00:00:00.000Z', tokens: {
    'space/md': { id: 'v1', type: 'FLOAT', value: 8 },
  } };
  let calls = 0;
  const evaluate = async (code) => {
    const result = await fixture.evaluate(code); calls++;
    if (calls === 1) fixture.variables[0].valuesByMode['c1:mode'] = 13;
    return result;
  };
  await assert.rejects(
    executeTokenSync(prepared({ value: 12, apply: true, lock }), {
      evaluate, workspaceIO: workspace(), fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'failed'
      && error.mutationOutcome === 'no-mutation'
      && error.mutationReport.residueCount === 0,
  );
  assert.equal(fixture.variables[0].valuesByMode['c1:mode'], 13);
});

test('duplicate Collection and Variable names fail as explicit no-mutation ambiguity', async () => {
  const duplicateCollection = figmaFixture({ duplicateCollection: true });
  await assert.rejects(
    executeTokenSync(prepared(), { evaluate: duplicateCollection.evaluate, workspaceIO: workspace() }),
    (error) => error.mutationOutcome === 'no-mutation' && /collection-ambiguous/.test(error.message),
  );
  const duplicateVariable = figmaFixture({ existing: [
    { id: 'v1', name: 'space/md', type: 'FLOAT', value: 8 },
    { id: 'v2', name: 'space/md', type: 'FLOAT', value: 8 },
  ] });
  await assert.rejects(
    executeTokenSync(prepared(), { evaluate: duplicateVariable.evaluate, workspaceIO: workspace() }),
    (error) => error.mutationOutcome === 'no-mutation'
      && /variable-name-ambiguous/.test(error.message),
  );
});

test('an existing multi-mode Collection preserves the established first-declared-mode policy', async () => {
  const fixture = figmaFixture({ existing: [
    { id: 'v1', name: 'space/md', type: 'FLOAT', value: 8 },
  ] });
  fixture.target.modes = [
    { modeId: 'c1:first', name: 'First' },
    { modeId: 'c1:default', name: 'Declared default' },
  ];
  fixture.target.defaultModeId = 'c1:default';
  fixture.variables[0].valuesByMode = { 'c1:first': 8, 'c1:default': 100 };
  const lock = { version: 1, collection: 'Design Tokens', fileKey: 'FILE_A',
    syncedAt: '2026-09-01T00:00:00.000Z', tokens: {
      'space/md': { id: 'v1', type: 'FLOAT', value: 8 },
    } };

  const result = await executeTokenSync(prepared({ value: 14, apply: true, lock }), {
    evaluate: fixture.evaluate, workspaceIO: workspace(), fileKey: 'FILE_A',
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /2 modes.*first-mode-only policy/);
  assert.equal(fixture.variables[0].valuesByMode['c1:first'], 14);
  assert.equal(fixture.variables[0].valuesByMode['c1:default'], 100);
});

test('an implicit target cannot reuse or erase another Figma file identity from the lock', async () => {
  const fixture = figmaFixture({ fileKey: 'FILE_B' });
  const lock = { version: 1, collection: 'Design Tokens', fileKey: 'FILE_A',
    syncedAt: '2026-09-01T00:00:00.000Z', tokens: {} };
  const output = workspace();
  await assert.rejects(
    executeTokenSync(prepared({ apply: true, lock }), {
      evaluate: fixture.evaluate, workspaceIO: output,
    }),
    (error) => error.kind === 'targeting'
      && error.dispatchState === 'completed'
      && error.mutationOutcome === 'no-mutation',
  );
  assert.equal(fixture.variables.length, 0);
  assert.equal(output.writes.length, 0);
});

test('deadline fences distinguish no dispatch, completed read, and committed mutation residue', async () => {
  {
    const fixture = figmaFixture(); let evaluations = 0;
    await assert.rejects(
      executeTokenSync(prepared(), {
        evaluate: async (...args) => { evaluations++; return fixture.evaluate(...args); },
        remainingMs: () => 0,
      }),
      (error) => error.kind === 'timeout'
        && error.dispatchState === 'not-dispatched'
        && error.mutationOutcome === 'no-mutation',
    );
    assert.equal(evaluations, 0);
  }
  {
    const fixture = figmaFixture(); const output = workspace(); let checks = 0; let evaluations = 0;
    await assert.rejects(
      executeTokenSync(prepared({ apply: true }), {
        evaluate: async (...args) => { evaluations++; return fixture.evaluate(...args); },
        workspaceIO: output, fileKey: 'FILE_A',
        remainingMs: () => (++checks === 1 ? 100 : 0),
      }),
      (error) => error.kind === 'timeout'
        && error.phase === 'plugin-mutation'
        && error.dispatchState === 'completed'
        && error.mutationOutcome === 'no-mutation',
    );
    assert.equal(evaluations, 1);
    assert.equal(fixture.variables.length, 0);
    assert.equal(output.writes.length, 0);
  }
  {
    const fixture = figmaFixture(); const output = workspace(); let checks = 0;
    await assert.rejects(
      executeTokenSync(prepared({ apply: true }), {
        evaluate: fixture.evaluate, workspaceIO: output, fileKey: 'FILE_A',
        remainingMs: () => (++checks < 3 ? 100 : 0),
      }),
      (error) => error.kind === 'timeout'
        && error.phase === 'workspace-publication'
        && error.dispatchState === 'completed'
        && error.mutationOutcome === 'partial-residue'
        && error.mutationReport.residueCount === 1,
    );
    assert.equal(fixture.variables.length, 1);
    assert.equal(output.writes.length, 0);
  }
});

test('collection factory validation failure stops before the first Variable operation', async () => {
  const fixture = figmaFixture();
  fixture.target.name = 'Other Collection';
  const createCollection = fixture.figma.variables.createVariableCollection;
  fixture.figma.variables.createVariableCollection = (name) => {
    const collection = createCollection(name);
    collection.modes = [];
    return collection;
  };
  let variableCreates = 0;
  fixture.figma.variables.createVariable = () => { variableCreates++; throw new Error('must not run'); };

  await assert.rejects(
    executeTokenSync(prepared({ apply: true }), {
      evaluate: fixture.evaluate, workspaceIO: workspace(), fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'failed'
      || error.mutationOutcome === 'verification-unavailable',
  );
  assert.equal(variableCreates, 0);
});

test('transport outcome preserves not-dispatched and conservatively bounds unknown residue', async () => {
  for (const [dispatchState, mutationOutcome, attempted, residueCount] of [
    ['not-dispatched', 'no-mutation', 0, 0],
    ['unknown', 'verification-unavailable', 1, 1],
  ]) {
    const fixture = figmaFixture(); let calls = 0;
    const evaluate = async (code) => {
      calls++; if (calls === 1) return fixture.evaluate(code);
      const error = new Error('injected transport loss');
      if (dispatchState !== 'unknown') error.dispatchState = dispatchState;
      throw error;
    };
    await assert.rejects(
      executeTokenSync(prepared({ apply: true }), {
        evaluate, workspaceIO: workspace(), fileKey: 'FILE_A',
      }),
      (error) => error.dispatchState === dispatchState
        && error.mutationOutcome === mutationOutcome
        && error.mutationReport.attempted === attempted
        && error.mutationReport.residueCount === residueCount,
    );
    assert.equal(fixture.variables.length, 0);
  }
});

test('invalid mutation evidence cannot hide a committed write or advance the lock', async () => {
  const fixture = figmaFixture(); let calls = 0;
  const output = workspace();
  const evaluate = async (code) => {
    calls++; const result = await fixture.evaluate(code);
    return calls === 2 ? '{}' : result;
  };
  await assert.rejects(
    executeTokenSync(prepared({ apply: true }), {
      evaluate, workspaceIO: output, fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'completed'
      && error.mutationOutcome === 'verification-unavailable'
      && error.mutationReport.residueCount === 1,
  );
  assert.equal(fixture.variables.length, 1);
  assert.equal(output.writes.length, 0);
});

test('forged complete counts cannot advance the lock without exact receipt evidence', async () => {
  const fixture = figmaFixture(); let calls = 0;
  const output = workspace();
  const evaluate = async (code) => {
    calls++; if (calls === 1) return fixture.evaluate(code);
    return JSON.stringify({
      schemaVersion: 1, status: 'complete', outcome: 'committed',
      attempted: 0, confirmed: 0, collectionCreated: false,
      counts: { created: 1, updated: 0, retyped: 0, renamed: 0, deleted: 0 },
      newIds: [{ index: 0, name: 'space/md', id: 'forged-id' }],
    });
  };
  await assert.rejects(
    executeTokenSync(prepared({ apply: true }), {
      evaluate, workspaceIO: output, fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'completed'
      && error.mutationOutcome === 'verification-unavailable',
  );
  assert.equal(output.writes.length, 0);
});

test('forged failure residue cannot claim operations outside the attempted Plan prefix', async () => {
  const fixture = figmaFixture(); let calls = 0;
  const output = workspace();
  const evaluate = async (code) => {
    calls++; if (calls === 1) return fixture.evaluate(code);
    return JSON.stringify({
      schemaVersion: 1, status: 'failed', outcome: 'partial-residue',
      failure: 'operation-failed', attempted: 1, confirmed: 1,
      residueCount: 1, residue: [{ kind: 'variable', operation: 'update' }],
      residueOmitted: 0,
    });
  };
  await assert.rejects(
    executeTokenSync(prepared({ apply: true }), {
      evaluate, workspaceIO: output, fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'completed'
      && error.mutationOutcome === 'verification-unavailable',
  );
  assert.equal(output.writes.length, 0);
});

test('lock publication failure reports verified committed Figma residue', async () => {
  const fixture = figmaFixture();
  await assert.rejects(
    executeTokenSync(prepared({ apply: true }), {
      evaluate: fixture.evaluate, workspaceIO: workspace({ fail: true }), fileKey: 'FILE_A',
    }),
    (error) => error.dispatchState === 'completed'
      && error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
  assert.equal(fixture.variables.length, 1);
});

test('successful create publishes the freshly verified Variable identity', async () => {
  const fixture = figmaFixture(); const output = workspace();
  const result = await executeTokenSync(prepared({ apply: true }), {
    evaluate: fixture.evaluate, workspaceIO: output, fileKey: 'FILE_A',
  });
  assert.equal(result.code, 0);
  assert.equal(output.writes.length, 1);
  const lock = JSON.parse(output.writes[0].value);
  assert.equal(lock.tokens['space/md'].id, fixture.variables[0].id);
});
