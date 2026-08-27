import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePageNavigation,
  executePageNavigationPlan,
  pageNavigationPlanRoute,
} from '../src/application/page-navigation-command.js';
import {
  acceptsPageNavigationArgv,
  pageNavigationArgvFromRequest,
  parsePageNavigationRequest,
} from '../src/application/page-navigation-request.js';

const PAGES = [
  { id: '0:1', name: 'Foundations', current: true },
  { id: '0:2', name: 'Components', current: false },
];

test('Page Navigation request closes and canonicalizes pages and page', () => {
  assert.deepEqual(parsePageNavigationRequest(['canvas', 'pages', '--json']), {
    action: 'pages', json: true,
  });
  assert.deepEqual(parsePageNavigationRequest(['canvas', 'page', '--', '--help']), {
    action: 'page',
    reference: {
      kind: 'query', value: '--help', nodeId: null, fileKey: null,
      warning: '', planningValue: '--help',
    },
  });
  assert.deepEqual(pageNavigationArgvFromRequest({ action: 'pages' }), ['canvas', 'pages']);
  assert.deepEqual(pageNavigationArgvFromRequest({ action: 'page', query: '--help' }),
    ['canvas', 'page', 'query:--help']);

  for (const argv of [
    ['canvas', 'pages', '--json', '--json'],
    ['canvas', 'pages', 'payload'],
    ['canvas', 'page'],
    ['canvas', 'page', 'One', 'Two'],
    ['canvas', 'page', '--future', 'private-value'],
    ['canvas', 'page', ''],
  ]) assert.equal(acceptsPageNavigationArgv(argv), false, argv.join(' '));
});

test('Page Navigation lists bounded pages in text and JSON', async () => {
  let code = '';
  const textResult = await executePageNavigation({ action: 'pages' }, {
    evaluate: async (value) => { code = value; return PAGES; },
  });
  assert.match(code, /figma\.root\.children/);
  assert.equal(textResult.stdout, '→ Foundations (0:1)\n  Components (0:2)');
  assert.deepEqual(textResult.result, PAGES);

  const jsonResult = await executePageNavigation({ action: 'pages', json: true }, {
    evaluate: async () => PAGES,
  });
  assert.deepEqual(JSON.parse(jsonResult.stdout), PAGES);
});

test('Page Navigation switches by the closed query and sanitizes text projection', async () => {
  let code = '';
  const result = await executePageNavigation({ action: 'page', query: 'Comp' }, {
    evaluate: async (value) => {
      code = value;
      return { status: 'switched', id: '0:2', name: 'Comp\u001b[31monents' };
    },
  });
  assert.match(code, /setCurrentPageAsync\(target\)/);
  assert.match(code, /"kind":"query","value":"Comp"/);
  assert.equal(result.stdout, '✓ Switched to page: Comp�[31monents (0:2)');
  assert.equal(result.result.name, 'Comp\u001b[31monents');
});

test('Page Navigation owns bounded ambiguity and not-found failures', async () => {
  await assert.rejects(
    () => executePageNavigation({ action: 'page', query: 'UI' }, {
      evaluate: async () => ({
        status: 'ambiguous',
        count: 3,
        matches: [
          { id: '0:1', name: 'UI One' },
          { id: '0:2', name: 'UI\u202eTwo' },
        ],
      }),
    }),
    /Ambiguous page name "UI": UI One \(0:1\), UI�Two \(0:2\) \(and 1 more\)/,
  );
  await assert.rejects(
    () => executePageNavigation({ action: 'page', query: 'Missing' }, {
      evaluate: async () => ({ status: 'not-found' }),
    }),
    /Page not found: Missing/,
  );
});

test('Page Navigation generated resolver refuses duplicate exact names', async () => {
  let code = '';
  await assert.rejects(
    () => executePageNavigation({ action: 'page', query: 'Duplicate' }, {
      evaluate: async (value) => {
        code = value;
        return {
          status: 'ambiguous',
          count: 2,
          matches: [
            { id: '0:1', name: 'Duplicate' },
            { id: '0:2', name: 'Duplicate' },
          ],
        };
      },
    }),
    /Duplicate \(0:1\), Duplicate \(0:2\)/,
  );
  assert.match(code, /const exactMatches = pages\.filter/);
  assert.match(code, /exactMatches\.length > 1/);
});

test('Page Navigation rejects malformed or unbounded Plugin results', async () => {
  await assert.rejects(
    () => executePageNavigation({ action: 'pages' }, {
      evaluate: async () => [{ id: '0:1', name: 'Only', current: false }],
    }),
    /invalid Page Navigation result/,
  );
  await assert.rejects(
    () => executePageNavigation({ action: 'page', query: 'One' }, {
      evaluate: async () => ({ status: 'switched', id: '', name: 'One' }),
    }),
    /invalid Page Navigation result/,
  );
});

test('Page Navigation accepts only authentic Plans with action-specific retry', async () => {
  const pages = planFigmaCommand(['canvas', 'pages', '--json'], { adapter: 'mcp' });
  const page = planFigmaCommand(['canvas', 'page', '--', '--help'], { adapter: 'mcp' });
  assert.equal(pages.allowed, true);
  assert.equal(page.allowed, true);
  assert.equal(pages.execution.retry, 'safe-read');
  assert.equal(page.execution.retry, 'never');
  assert.equal(page.id, 'canvas.page');
  assert.equal(pageNavigationPlanRoute(pages), 'command-application');
  assert.equal(pageNavigationPlanRoute(page), 'command-application');
  assert.deepEqual((await executePageNavigationPlan(pages, {
    evaluate: async () => PAGES,
  })).result, PAGES);
  await assert.rejects(
    () => executePageNavigationPlan({ ...page }, { evaluate: async () => null }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(pageNavigationPlanRoute(planFigmaCommand(['canvas', 'info'])),
    'not-page-navigation');
});

test('Page Navigation resolves policy-identical CLI and MCP Plans', () => {
  for (const argv of [['canvas', 'pages', '--json'], ['canvas', 'page', 'Components']]) {
    const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEPLACEHOLDER' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEPLACEHOLDER' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
    const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
    assert.deepEqual(cliPolicy, mcpPolicy);
  }
});

test('Page Navigation projects a Figma file only from an explicit node variant', () => {
  const url = 'https://www.figma.com/design/ARGUMENTPLACEHOLDERKEY/FILE_NAME?node-id=0-2';
  const node = planFigmaCommand(['canvas', 'page', `node:${url}`], { adapter: 'mcp' });
  assert.equal(node.allowed, true);
  assert.deepEqual(node.argv, ['canvas', 'page', 'node:0:2']);
  assert.equal(node.target.fileKey, 'ARGUMENTPLACEHOLDERKEY');
  assert.equal(node.target.source, 'figma-url');

  for (const value of [`name:${url}`, `query:${url}`, url]) {
    const payload = planFigmaCommand(['canvas', 'page', value], { adapter: 'mcp' });
    assert.equal(payload.allowed, true, value);
    assert.equal(payload.target.fileKey, null, value);
    assert.equal(payload.target.source, 'implicit-single-window', value);
  }
});

test('Page Navigation explicit node and name variants do not fall through to another identity kind', async () => {
  let code = '';
  await assert.rejects(
    () => executePageNavigation({ action: 'page', reference: { kind: 'node', value: '0:9' } }, {
      evaluate: async (value) => { code = value; return { status: 'not-found' }; },
    }),
    /Page not found: 0:9/,
  );
  assert.match(code, /reference\.kind !== 'node'/);

  await assert.rejects(
    () => executePageNavigation({ action: 'page', reference: { kind: 'name', value: '0:2' } }, {
      evaluate: async () => ({ status: 'not-found' }),
    }),
    /Page not found: 0:2/,
  );
});
