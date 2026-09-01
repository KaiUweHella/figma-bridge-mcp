import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGradientApply,
  executeGradientApplyPlan,
  gradientApplyCode,
  gradientApplyPlanRoute,
} from '../src/application/gradient-apply-command.js';
import {
  acceptsGradientApplyArgv,
  gradientApplyArgvFromRequest,
  gradientApplyPlanningArgvFromRequest,
  parseGradientApplyRequest,
} from '../src/application/gradient-apply-request.js';
import { parseGradientPaint } from '../src/lib/gradient-paint.js';

const copy = (value) => JSON.parse(JSON.stringify(value));
const VALUE = 'linear-gradient(90deg, #FF0000 0%, rgba(0, 0, 255, 0.5) 100%)';

function fixture({ paintMode = 'normal', weightMode = 'normal', beforePaints } = {}) {
  let paints = copy(beforePaints || [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]);
  let strokeWeight = 2;
  let paintWrites = 0; let weightWrites = 0;
  const assignPaint = (value) => {
    paintWrites += 1;
    if (paintMode === 'ignore-first' && paintWrites === 1) return;
    if (paintMode === 'wrong-first' && paintWrites === 1) {
      paints = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; return;
    }
    if (paintMode === 'wrong-ignore-rollback') {
      if (paintWrites === 1) paints = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      return;
    }
    paints = copy(value);
    if (paintMode === 'throw-after-first' && paintWrites === 1) throw new Error('paint acknowledgement');
  };
  const node = {
    id: '1:2', name: 'Gradient Card', type: 'RECTANGLE',
    get fills() { return copy(paints); }, set fills(value) { assignPaint(value); },
    get strokes() { return copy(paints); }, set strokes(value) { assignPaint(value); },
    get strokeWeight() { return strokeWeight; },
    set strokeWeight(value) {
      weightWrites += 1; strokeWeight = value;
      if (weightMode === 'throw-after-first' && weightWrites === 1) throw new Error('weight acknowledgement');
      if (weightMode === 'ignore-rollback' && weightWrites > 1) strokeWeight = value + 1;
    },
  };
  return {
    figma: { async getNodeByIdAsync(id) { return id === node.id ? node : null; } },
    node,
    paints: () => copy(paints),
    strokeWeight: () => strokeWeight,
    paintWrites: () => paintWrites,
    weightWrites: () => weightWrites,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Gradient Paint parsing is bounded, strict, and preserves native kinds and alpha', () => {
  const paint = parseGradientPaint(VALUE);
  assert.equal(paint.type, 'GRADIENT_LINEAR');
  assert.deepEqual(paint.gradientTransform, [[1, 0, 0], [0, 1, 0]]);
  assert.equal(paint.gradientStops[1].color.a, 0.5);
  assert.equal(Object.isFrozen(paint.gradientStops), true);
  assert.equal(parseGradientPaint('radial-gradient(circle at 60% 40%, #fff, transparent)').type,
    'GRADIENT_RADIAL');
  assert.equal(parseGradientPaint('angular-gradient(#f00, #0f0)').type, 'GRADIENT_ANGULAR');
  assert.equal(parseGradientPaint('diamond-gradient(#f00, #0f0)').type, 'GRADIENT_DIAMOND');
  for (const value of [
    'linear-gradient(#fff)',
    'linear-gradient(#fff, private-color)',
    'linear-gradient(#fff -1%, #000 100%)',
    'radial-gradient(circle at 120% 40%, #fff, #000)',
    'linear-gradient(rgba(300,0,0,1), #000)',
  ]) assert.throws(() => parseGradientPaint(value), /Invalid gradient/);
});

test('Gradient Apply closes options, canonical values, URL identity, and excess input', () => {
  const url = 'https://www.figma.com/design/FILEA/Gradient-Lab?node-id=1-2';
  assert.deepEqual(parseGradientApplyRequest([
    'gradient', 'apply', '--field=STROKE', '--stroke-weight', '3.5', '--json', url, VALUE,
  ]), {
    nodeId: '1:2', value: VALUE, paint: parseGradientPaint(VALUE),
    field: 'stroke', strokeWeight: 3.5, json: true,
  });
  assert.deepEqual(gradientApplyArgvFromRequest({ nodeId: '1:2', value: VALUE }), [
    'gradient', 'apply', '--field', 'fill', '--', '1:2', VALUE,
  ]);
  assert.equal(gradientApplyPlanningArgvFromRequest({ nodeId: url, value: VALUE }).at(-2), url);
  for (const argv of [
    ['gradient', 'apply'],
    ['gradient', 'apply', 'bad', VALUE],
    ['gradient', 'apply', '1:2', 'private-value'],
    ['gradient', 'apply', '--field', 'effect', '1:2', VALUE],
    ['gradient', 'apply', '--stroke-weight', '-1', '1:2', VALUE],
    ['gradient', 'apply', '--json=true', '1:2', VALUE],
    ['gradient', 'apply', '--future', 'private-value', '1:2', VALUE],
    ['gradient', 'apply', '1:2', VALUE, 'extra'],
  ]) assert.equal(acceptsGradientApplyArgv(argv), false, argv.join(' '));
});

test('Gradient Apply freshly verifies fill and stroke mutations', async () => {
  const fill = fixture();
  const fillResult = await executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(fill.figma),
  });
  assert.equal(fillResult.result.outcome, 'verified');
  assert.equal(fill.paints()[0].type, 'GRADIENT_LINEAR');
  assert.equal(fill.paintWrites(), 1);
  assert.match(fillResult.stdout, /Applied gradient fill to Gradient Card \(1:2\)/);

  const stroke = fixture();
  const strokeResult = await executeGradientApply({
    nodeId: '1:2', value: 'radial-gradient(#fff, #000)', field: 'stroke', strokeWeight: 4,
  }, { evaluate: evaluate(stroke.figma) });
  assert.equal(strokeResult.result.field, 'stroke');
  assert.equal(stroke.paints()[0].type, 'GRADIENT_RADIAL');
  assert.equal(stroke.strokeWeight(), 4);
  assert.equal(stroke.weightWrites(), 1);
});

test('Gradient Apply distinguishes no-op, unchanged, verified acknowledgement, rollback, and residue', async () => {
  const paint = parseGradientPaint(VALUE);
  const noOp = fixture({ beforePaints: [paint] });
  assert.equal((await executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(noOp.figma),
  })).result.outcome, 'no-op');
  assert.equal(noOp.paintWrites(), 0);

  const unchanged = fixture({ paintMode: 'ignore-first' });
  await assert.rejects(() => executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');

  const acknowledged = fixture({ paintMode: 'throw-after-first' });
  const accepted = await executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(acknowledged.figma),
  });
  assert.equal(accepted.result.outcome, 'verified-after-error');
  assert.match(accepted.stderr, /fresh readback proved/);

  const rolledBack = fixture({ paintMode: 'wrong-first' });
  await assert.rejects(() => executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.equal(rolledBack.paints()[0].type, 'SOLID');

  const residue = fixture({ paintMode: 'wrong-ignore-rollback' });
  await assert.rejects(() => executeGradientApply({ nodeId: '1:2', value: VALUE }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);
});

test('Gradient Apply JSON output preserves the legacy compact result contract', async () => {
  const live = fixture();
  const result = await executeGradientApply({ nodeId: '1:2', value: VALUE, json: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    id: '1:2', name: 'Gradient Card', type: 'RECTANGLE', field: 'fill', strokeWeight: 2,
  });
});

test('Gradient Apply owns one non-retrying target-aware Plan across CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Gradient-Lab?node-id=1-2';
  const cli = planFigmaCommand([
    'gradient', 'apply', url, VALUE, '--field', 'stroke', '--stroke-weight=4',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'gradient', 'apply', '--field=stroke', '--stroke-weight', '4', '--', url, VALUE,
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.target.fileKey, 'FILEA');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(gradientApplyPlanRoute(cli), 'command-application');
  const live = fixture();
  assert.equal((await executeGradientApplyPlan(cli, { evaluate: evaluate(live.figma) })).result.outcome,
    'verified');
  assert.throws(() => gradientApplyPlanRoute({ ...cli }), /requires a Command Plan/);
});

test('malformed and forged Plugin results cannot become successful Gradient Applies', async () => {
  const request = { nodeId: '1:2', value: VALUE };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(() => executeGradientApply(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = fixture();
  const serialized = await evaluate(live.figma)(gradientApplyCode(request));
  const forged = JSON.parse(serialized);
  forged.node.id = '9:9';
  await assert.rejects(() => executeGradientApply(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Gradient Apply generated code parses and Source MCP uses the same Application', () => {
  const code = gradientApplyCode({ nodeId: '1:2', value: VALUE });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.doesNotMatch(code, /setTimeout/);
  assert.match(code, /beforePaints/);
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('const gradientApplyRoute = gradientApplyPlanRoute(plan);');
  const end = server.indexOf('const motionApplyRoute = motionApplyPlanRoute(plan);', start);
  const route = server.slice(start, end);
  assert.ok(start >= 0 && end > start, 'Gradient Apply MCP route exists');
  assert.match(route, /compatibilityFallback: false/);
  assert.match(route, /executeGradientApplyPlan\(plan/);
});
