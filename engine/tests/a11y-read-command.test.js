import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  a11yReadCode,
  a11yReadPlanRoute,
  executeA11yRead,
  executeA11yReadPlan,
  MAX_A11Y_READ_NODES,
} from '../src/application/a11y-read-command.js';
import {
  A11Y_READ_ACTIONS,
  acceptsA11yReadArgv,
  a11yReadArgvFromRequest,
  a11yReadFigmaUrlFileKeyFromArgv,
  a11yReadPlanningArgvFromRequest,
  parseA11yReadRequest,
} from '../src/application/a11y-read-request.js';

const solid = (r, g, b, opacity = 1) => ({
  type: 'SOLID', color: { r, g, b }, opacity,
});

function runtime({ selection = true, missingPage = false } = {}) {
  const page = {
    id: '0:1', name: 'Neutral test page', type: 'PAGE', parent: null,
    children: [], selection: [],
  };
  const frame = {
    id: '1:1', name: 'Neutral container', type: 'FRAME', parent: page,
    visible: true, x: 100, y: 200, width: 400, height: 400,
    fills: [solid(1, 1, 1)], children: [],
  };
  const difficultText = {
    id: '1:2', name: 'Body copy', type: 'TEXT', parent: frame,
    visible: true, x: 10, y: 10, width: 120, height: 20,
    fills: [solid(0.5, 0.5, 0.5)], fontSize: 10, fontWeight: 400,
    lineHeight: { unit: 'PIXELS', value: 12 }, paragraphSpacing: 10,
    letterSpacing: { unit: 'PIXELS', value: 0.5 }, textCase: 'UPPER',
    characters: 'A LONG UPPERCASE ACCESSIBILITY FIXTURE',
  };
  const button = {
    id: '1:3', name: 'Primary Button', type: 'RECTANGLE', parent: frame,
    visible: true, x: 10, y: 60, width: 20, height: 20,
    fills: [solid(0, 0, 1)], reactions: [],
  };
  const passingText = {
    id: '1:4', name: 'Label', type: 'TEXT', parent: frame,
    visible: true, x: 50, y: 60, width: 100, height: 20,
    fills: [solid(0, 0, 0)], fontSize: 16, fontWeight: 400,
    lineHeight: { unit: 'PERCENT', value: 150 }, paragraphSpacing: 32,
    letterSpacing: { unit: 'PIXELS', value: 0 }, textCase: 'ORIGINAL',
    characters: 'Readable label',
  };
  const hiddenButton = {
    id: '1:5', name: 'Hidden Button', type: 'RECTANGLE', parent: frame,
    visible: false, x: 0, y: 0, width: 1, height: 1, reactions: [],
  };
  frame.children.push(difficultText, button, passingText, hiddenButton);
  page.children.push(frame);
  page.selection = selection ? [frame] : [];
  const nodes = new Map([page, frame, difficultText, button, passingText, hiddenButton]
    .map((node) => [node.id, node]));
  return {
    page,
    frame,
    figma: {
      currentPage: missingPage ? null : page,
      async getNodeByIdAsync(id) { return nodes.get(id) || null; },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('A11y read closes action-specific options and canonical URL identity', () => {
  assert.deepEqual(parseA11yReadRequest([
    'a11y', 'contrast', '1-2', '--level=aaa', '--json', '--fail-on-issues',
  ]), {
    action: 'contrast', nodeId: '1:2', level: 'AAA', minimum: 44,
    json: true, failOnIssues: true, warning: '',
  });
  assert.deepEqual(a11yReadArgvFromRequest({
    action: 'touch', nodeId: '1-1', minimum: 48, json: true, failOnIssues: true,
  }), ['a11y', 'touch', '1:1', '--min=48', '--json', '--fail-on-issues']);

  const url = 'https://www.figma.com/design/FILEA/Neutral?node-id=1-1';
  const planning = a11yReadPlanningArgvFromRequest({ action: 'focus', nodeId: url });
  assert.equal(a11yReadFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');

  for (const argv of [
    ['a11y', 'contrast', '--level=private'],
    ['a11y', 'contrast', '--level=AA', '--level=AAA'],
    ['a11y', 'touch', '--min=0'],
    ['a11y', 'touch', '--min=12px'],
    ['a11y', 'text', '--level=AA'],
    ['a11y', 'focus', '--fail-on-issues'],
    ['a11y', 'audit', '--min=44'],
    ['a11y', 'focus', '1:1', '1:2'],
    ['a11y', 'audit', '--future'],
  ]) assert.equal(acceptsA11yReadArgv(argv), false, argv.join(' '));
});

test('Contrast preserves complete legacy facts and fail-on-issues semantics', async () => {
  const live = runtime();
  const result = await executeA11yRead({
    action: 'contrast', level: 'AA', json: true, failOnIssues: true,
  }, { evaluate: evaluate(live.figma) });
  const data = JSON.parse(result.stdout);
  assert.equal(result.code, 1);
  assert.deepEqual({
    level: data.level, total: data.total, passing: data.passing, failing: data.failing,
  }, { level: 'AA', total: 2, passing: 1, failing: 1 });
  assert.equal(data.all.length, 2);
  assert.equal(data.issues[0].id, '1:2');
  assert.equal(data.issues[0].ratio, 3.98);
  assert.equal(data.issues[0].fgColor, '#808080');
  assert.equal(data.issues[0].bgColor, '#ffffff');
});

test('Touch reports configured minimum, critical targets, and bounded issue facts', async () => {
  const live = runtime();
  const result = await executeA11yRead({
    action: 'touch', nodeId: '1:1', minimum: 44,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.code, 0);
  assert.equal(result.result.data.total, 1);
  assert.equal(result.result.data.passing, 0);
  assert.equal(result.result.data.failing, 1);
  assert.equal(result.result.data.critical, 1);
  assert.deepEqual(result.result.data.issues[0], {
    id: '1:3', name: 'Primary Button', type: 'RECTANGLE',
    width: 20, height: 20, pass: false, wcag248: false, issue: 'both',
  });
  assert.match(result.stdout, /Touch Target Check \(min 44x44px\)/);
});

test('Text keeps node-level error and warning classification separate from passing text', async () => {
  const live = runtime();
  const result = await executeA11yRead({
    action: 'text', nodeId: '1:1', json: true,
  }, { evaluate: evaluate(live.figma) });
  const data = JSON.parse(result.stdout);
  assert.deepEqual({
    total: data.total, errors: data.errors, warnings: data.warnings, passing: data.passing,
  }, { total: 2, errors: 1, warnings: 0, passing: 1 });
  assert.equal(data.issues.length, 1);
  assert.deepEqual(data.issues[0].issues.map((issue) => issue.rule), [
    'min-size', 'line-height', 'paragraph-spacing', 'letter-spacing', 'all-caps',
  ]);
  assert.equal(data.issues[0].lineHeightRatio, 1.2);
});

test('Focus uses selection before the current page and retains deterministic reading order', async () => {
  const live = runtime();
  const selected = await executeA11yRead({ action: 'focus', json: true }, {
    evaluate: evaluate(live.figma),
  });
  const data = JSON.parse(selected.stdout);
  assert.equal(data.total, 3);
  assert.equal(data.interactive, 1);
  assert.deepEqual(data.order.map((item) => item.id), ['1:2', '1:3', '1:4']);
  assert.equal(data.order[1].tabOrder, 1);
  assert.deepEqual(data.order.map(({ x, y }) => ({ x, y })), [
    { x: 110, y: 210 }, { x: 110, y: 260 }, { x: 150, y: 260 },
  ]);

  live.page.selection = [];
  const pageFallback = await executeA11yRead({ action: 'focus' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(pageFallback.result.data.total, 3);
});

test('Audit preserves category breakdown, score, and valid diagnostic exit', async () => {
  const live = runtime();
  const result = await executeA11yRead({
    action: 'audit', level: 'AA', failOnIssues: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.code, 1);
  assert.equal(result.result.data.score, 'C');
  assert.deepEqual(result.result.data.summary, {
    textNodes: 2, interactiveElements: 1, errors: 3, warnings: 2,
  });
  assert.deepEqual(result.result.data.breakdown, {
    contrast: { issues: 1, errors: 1 },
    text: { issues: 3, errors: 1 },
    touch: { issues: 1, errors: 1 },
  });
  assert.match(result.stdout, /Accessibility Audit \(WCAG AA\)/);
  assert.match(result.stdout, /Score: C/);
});

test('missing targets, unavailable pages, and excessive inventories fail without reports', async () => {
  const live = runtime();
  await assert.rejects(() => executeA11yRead({
    action: 'contrast', nodeId: '9:9',
  }, { evaluate: evaluate(live.figma) }), /target was not found/);
  const unavailable = runtime({ missingPage: true });
  await assert.rejects(() => executeA11yRead({ action: 'audit' }, {
    evaluate: evaluate(unavailable.figma),
  }), /target was not found/);

  const excessive = runtime();
  excessive.page.children.length = MAX_A11Y_READ_NODES + 1;
  await assert.rejects(() => executeA11yRead({ action: 'audit' }, {
    evaluate: evaluate(excessive.figma),
  }), /invalid child facts/);
});

test('all five reads share policy-identical safe Plans across CLI and MCP', async () => {
  for (const action of A11Y_READ_ACTIONS) {
    const options = action === 'contrast' || action === 'audit'
      ? ['--level=AAA'] : action === 'touch' ? ['--min=48'] : [];
    const cli = planFigmaCommand(['a11y', action, '1-1', ...options], { adapter: 'cli' });
    const mcp = planFigmaCommand(['a11y', action, ...options, '--', '1:1'], { adapter: 'mcp' });
    assert.equal(cli.allowed, true, action);
    assert.equal(mcp.allowed, true, action);
    assert.deepEqual(cli.argv, mcp.argv, action);
    assert.deepEqual(cli.effects, mcp.effects, action);
    assert.deepEqual(cli.execution, mcp.execution, action);
    assert.equal(cli.effects.figma, 'read', action);
    assert.equal(cli.effects.editor, 'none', action);
    assert.equal(cli.confirmation, 'none', action);
    assert.equal(cli.execution.retry, 'safe-read', action);
    assert.equal(a11yReadPlanRoute(cli), 'command-application', action);

    const contextual = planFigmaCommand(['a11y', action], { adapter: 'mcp' });
    assert.equal(contextual.effects.editor, 'read', action);
  }

  const failing = planFigmaCommand([
    'a11y', 'audit', '--fail-on-issues',
  ], { adapter: 'mcp' });
  assert.deepEqual(failing.execution.okExitCodes, [0, 1]);
  const live = runtime();
  assert.equal((await executeA11yReadPlan(failing, {
    evaluate: evaluate(live.figma),
  })).code, 1);
});

test('malformed and forged Plugin results cannot become accessibility facts', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ action: 'contrast' })]) {
    await assert.rejects(() => executeA11yRead({ action: 'contrast' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(a11yReadCode({ action: 'audit' }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, action: 'contrast' },
    { ...payload, data: { ...payload.data, score: 'A+' } },
    { ...payload, data: { ...payload.data, summary: { ...payload.data.summary, errors: 0 } } },
    { ...payload, futureField: 'private' },
  ]) {
    await assert.rejects(() => executeA11yRead({ action: 'audit' }, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('A11y read generated Plugin code parses for every action', () => {
  for (const action of A11Y_READ_ACTIONS) {
    assert.doesNotThrow(() => new Function(`return ${a11yReadCode({ action })}`), action);
  }
});
