import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  drawPlanningArgvFromRequest,
  executeDrawCommandPlan,
} from '../application/draw-command.js';
import { daemonExec, handleEvalError, program } from '../lib/cli-core.js';

const draw = program.command('draw').description('Inspect and manage native Figma Draw features');

async function runDrawCommand(request) {
  try {
    const plan = planFigmaCommand(drawPlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeDrawCommandPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

draw.command('inspect <nodeId>')
  .allowExcessArguments(false)
  .action(async (nodeId) => runDrawCommand({ action: 'inspect', nodeId }));
draw.command('text-path <nodeId>')
  .requiredOption('--text <text>')
  .option('--segment <index>', 'Start segment', '0')
  .option('--position <ratio>', 'Start position 0..1', '0')
  .option('--font-family <family>', 'Font family', 'Inter')
  .option('--font-style <style>', 'Font style', 'Regular')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runDrawCommand({
    action: 'text-path', nodeId, text: options.text, segment: options.segment,
    position: options.position, fontFamily: options.fontFamily, fontStyle: options.fontStyle,
  }));
draw.command('transform-group <nodeIds>')
  .requiredOption('--modifiers <json>')
  .option('--parent <nodeId>')
  .option('--index <index>')
  .allowExcessArguments(false)
  .action(async (nodeIds, options) => runDrawCommand({
    action: 'transform-group', nodeIds, parentId: options.parent,
    index: options.index, modifiers: options.modifiers,
  }));
draw.command('brush <nodeId>')
  .requiredOption('--properties <json>', 'ComplexStrokeProperties JSON')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runDrawCommand({
    action: 'brush', nodeId, properties: options.properties,
  }));
draw.command('stroke-profile <nodeId>')
  .option('--preset <name>')
  .option('--points <json>')
  .option('--clear')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => runDrawCommand({
    action: 'stroke-profile', nodeId, preset: options.preset,
    points: options.points, clear: options.clear,
  }));
draw.command('pattern <nodeId> <sourceNodeId>')
  .requiredOption('--field <field>', 'fill or stroke')
  .option('--tile <type>', 'rectangular, horizontal_hexagonal, vertical_hexagonal', 'rectangular')
  .option('--scale <number>', 'Scaling factor', '1')
  .option('--spacing-x <number>', 'Horizontal spacing', '0')
  .option('--spacing-y <number>', 'Vertical spacing', '0')
  .option('--alignment <value>', 'start, center, end', 'center')
  .option('--replace')
  .allowExcessArguments(false)
  .action(async (nodeId, sourceNodeId, options) => runDrawCommand({
    action: 'pattern', nodeId, sourceNodeId, field: options.field,
    tileType: options.tile, scalingFactor: options.scale, spacingX: options.spacingX,
    spacingY: options.spacingY, alignment: options.alignment, replace: options.replace,
  }));
