import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  designMdImportPlanRoute,
  executeDesignMdImportPlan,
  prepareDesignMdImportPlan,
} from '../src/application/design-md-import-command.js';
import { designMdPlanningArgvFromRequest } from '../src/application/design-md-context-command.js';
import { createWorkspaceIO } from '../src/lib/workspace-io.js';

function document(tokens, source = 'DESIGN Import Fixture') {
  return `# DESIGN Import Fixture\n\n## Machine-readable tokens\n\`\`\`json design-tokens\n${JSON.stringify({
    ...tokens,
    meta: { source },
  })}\n\`\`\`\n`;
}

function planned(tokens, request = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'design-import-'));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, document(tokens));
  const workspaceIO = createWorkspaceIO({ root: dir });
  const plan = planFigmaCommand(designMdPlanningArgvFromRequest({
    file,
    collection: request.collection || null,
    printContext: false,
    forceSlash: request.forceSlash === true,
  }), { adapter: 'cli', workspaceDir: dir, workspaceIO });
  return { plan, workspaceIO };
}

test('simple DESIGN.md preflight produces one bounded Single-Collection import before readiness', () => {
  const { plan, workspaceIO } = planned({
    color: { primary: '#336699' },
    radius: { card: 12 },
    spacing: { stack: 8 },
    typography: { body: { fontFamily: 'Inter', fontSize: 16 } },
    shadow: {},
  }, { collection: 'Imported Theme' });
  assert.equal(designMdImportPlanRoute(plan), 'command-application');
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  assert.equal(prepared.kind, 'single-collection');
  assert.equal(prepared.tokenImport.request.collection, 'Imported Theme');
  assert.equal(Object.isFrozen(prepared.tokenImport), true);
  assert.equal(Object.isFrozen(prepared.tokenImport.request), true);
  assert.deepEqual(prepared.tokenImport.items.map((item) => ({
    name: item.name, type: item.type, scopes: item.scopes,
  })), [
    { name: 'primary', type: 'COLOR', scopes: undefined },
    { name: 'card', type: 'FLOAT', scopes: ['CORNER_RADIUS'] },
    { name: 'stack', type: 'FLOAT', scopes: ['GAP'] },
  ]);
  assert.equal(prepared.unsupportedCompositeCount, 1);
});

test('prepared simple DESIGN.md target identity cannot change after preflight', async () => {
  const { plan, workspaceIO } = planned({ color: { primary: '#336699' } }, {
    collection: 'Prepared Theme', forceSlash: false,
  });
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  for (const [field, value] of [
    ['collection', 'Changed Theme'], ['forceSlash', true], ['file', '/changed/DESIGN.md'],
  ]) {
    assert.throws(() => { prepared.tokenImport.request[field] = value; }, TypeError);
  }
  let evaluated = false;
  await executeDesignMdImportPlan(plan, prepared, {
    evaluate: async () => {
      evaluated = true;
      return JSON.stringify({
        schemaVersion: 1,
        status: 'complete',
        collection: { id: 'c1', name: 'Prepared Theme', created: true, modeId: 'm1' },
        created: { total: 1, indexes: [0] },
        matching: { total: 0, indexes: [] },
        residue: { total: 0, items: [], omitted: 0 },
      });
    },
  });
  assert.equal(evaluated, true);
  assert.equal(prepared.tokenImport.request.collection, 'Prepared Theme');
});

test('implicit DESIGN.md Collection accepts only a bounded safe string identity', () => {
  for (const source of [
    { name: 'object' }, 123, true, 'unsafe\u0000source',
    'Theme\u061cSpoof', 'Theme\u200eSpoof', 'Theme\u200fSpoof', 'x'.repeat(513),
  ]) {
    const { plan, workspaceIO } = planned({ color: { primary: '#336699' } }, {});
    const file = plan.argv.at(-1);
    writeFileSync(file, document({ color: { primary: '#336699' } }, source));
    assert.equal(
      prepareDesignMdImportPlan(plan, { workspaceIO }).tokenImport.request.collection,
      'Imported Design System',
    );
  }

  const explicit = planned({ color: { primary: '#336699' } }, {
    collection: 'Explicit Theme',
  });
  const file = explicit.plan.argv.at(-1);
  writeFileSync(file, document({ color: { primary: '#336699' } }, { unsafe: true }));
  assert.equal(
    prepareDesignMdImportPlan(explicit.plan, { workspaceIO: explicit.workspaceIO })
      .tokenImport.request.collection,
    'Explicit Theme',
  );

  for (const control of ['\u061c', '\u200e', '\u200f']) {
    const projected = planned({ color: { [`primary${control}spoof`]: '#336699' } });
    assert.throws(
      () => prepareDesignMdImportPlan(projected.plan, { workspaceIO: projected.workspaceIO }),
      /token name is empty, unsafe, or too long/,
    );
  }
});

test('simple DESIGN.md executes the journaled mutation and shared bounded output', async () => {
  const { plan, workspaceIO } = planned({
    color: { primary: '#336699' },
    radius: { card: 12 },
    spacing: { stack: 8 },
    typography: { body: { fontFamily: 'Inter' } },
  }, { collection: 'Imported Theme' });
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  const length = prepared.tokenImport.items.length;
  const result = await executeDesignMdImportPlan(plan, prepared, {
    evaluate: async () => JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      collection: {
        id: 'c1', name: 'Imported Theme', created: true, modeId: 'm1',
      },
      created: { total: length, indexes: Array.from({ length }, (_value, index) => index) },
      matching: { total: 0, indexes: [] },
      residue: { total: 0, items: [], omitted: 0 },
    }),
  });
  assert.match(result.stdout, /Imported 3 token\(s\)/);
  assert.match(result.stdout, /Design system loaded: DESIGN Import Fixture/);
  assert.match(result.stderr, /SCOPE DECISION REQUIRED for 1 imported token/);
  assert.match(result.stderr, /1 typography or shadow token remains context-only/);
});

test('composite-only DESIGN.md remains useful context without Plugin evaluation', async () => {
  const { plan, workspaceIO } = planned({
    color: {}, radius: {}, spacing: {},
    typography: { body: { fontFamily: 'Inter' } },
    shadow: {},
  });
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  assert.equal(prepared.kind, 'context-only');
  const result = await executeDesignMdImportPlan(plan, prepared, {});
  assert.match(result.stdout, /Typography tokens \(1\): body/);
  assert.match(result.stderr, /context-only/);
});

test('legacy v1 Variable Snapshots remain explicit on their compatibility route', async () => {
  const { plan, workspaceIO } = planned({
    variables: {
      Theme: {
        modes: ['Light', 'Dark'],
        variables: { primary: { type: 'COLOR', values: { Light: '#fff', Dark: '#000' } } },
      },
    },
  });
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  assert.equal(prepared.kind, 'legacy-variable-snapshot');
  await assert.rejects(
    () => executeDesignMdImportPlan(plan, prepared, { evaluate: async () => '' }),
    /Legacy name-keyed Variable Snapshot.*compatibility path/,
  );
});

test('portable v2 snapshots take precedence over legacy v1 and reject incomplete before readiness', async () => {
  const portable = {
    schemaVersion: 2, kind: 'figma-variable-snapshot', complete: true,
    collections: [{
      handle: 'collection:one', name: 'Theme', hiddenFromPublishing: false,
      defaultMode: 'collection:one/mode:base',
      modes: [{ handle: 'collection:one/mode:base', name: 'Base' }],
      variables: [{
        handle: 'collection:one/variable:space', name: 'space/base', type: 'FLOAT',
        description: '', hiddenFromPublishing: false, scopes: ['GAP'], codeSyntax: {},
        values: { 'collection:one/mode:base': 8 },
      }],
    }],
  };
  const { plan, workspaceIO } = planned({
    variableSnapshot: portable,
    variables: { Legacy: { modes: ['Old'], variables: {} } },
  });
  const prepared = prepareDesignMdImportPlan(plan, { workspaceIO });
  assert.equal(prepared.kind, 'variable-snapshot-v2');
  let evaluated = false;
  const result = await executeDesignMdImportPlan(plan, prepared, {
    evaluate: async () => {
      evaluated = true;
      return JSON.stringify({ schemaVersion: 1, status: 'complete',
        collections: 1, variables: 1, aliases: 0, residue: 0 });
    },
  });
  assert.equal(evaluated, true);
  assert.match(result.stdout, /Imported 1 Variable/);

  const incomplete = structuredClone(portable);
  incomplete.complete = false;
  const rejected = planned({ variableSnapshot: incomplete, variables: {
    Legacy: { modes: ['Old'], variables: { unsafe: { type: 'FLOAT', values: { Old: 1 } } } },
  } });
  assert.throws(
    () => prepareDesignMdImportPlan(rejected.plan, { workspaceIO: rejected.workspaceIO }),
    /incomplete/,
  );

  for (const request of [{ collection: 'Ignored' }, { forceSlash: true }]) {
    const optionConflict = planned({ variableSnapshot: portable }, request);
    assert.throws(
      () => prepareDesignMdImportPlan(optionConflict.plan, {
        workspaceIO: optionConflict.workspaceIO,
      }),
      /apply only to simple single-Collection/,
    );
  }
});

test('DESIGN.md import rejects forged preparation and requires explicit slash intent', async () => {
  const { plan } = planned({ color: { primary: '#fff' } });
  await assert.rejects(
    () => executeDesignMdImportPlan(plan, {
      kind: 'context-only', request: plan.argv, summary: 'forged', unsupportedCompositeCount: 0,
    }),
    /authentic prepared source/,
  );

  const rejected = planned({ color: { primary: '#fff' } }, { collection: 'Brand/Theme' });
  assert.throws(
    () => prepareDesignMdImportPlan(rejected.plan, { workspaceIO: rejected.workspaceIO }),
    /force-slash/,
  );
  const accepted = planned({ color: { primary: '#fff' } }, {
    collection: 'Brand/Theme', forceSlash: true,
  });
  assert.equal(
    prepareDesignMdImportPlan(accepted.plan, { workspaceIO: accepted.workspaceIO })
      .tokenImport.request.collection,
    'Brand/Theme',
  );
});
