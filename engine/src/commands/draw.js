import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  drawBrushCode, drawInspectCode, drawPatternCode, drawStrokeProfileCode,
  drawTextPathCode, drawTransformGroupCode,
} from '../lib/draw-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const draw = program.command('draw').description('Inspect and manage native Figma Draw features');

draw.command('inspect <nodeId>').action(async (nodeId) => { try { print(await run(drawInspectCode({ nodeId }))); } catch (error) { handleEvalError(error); } });
draw.command('text-path <nodeId>').requiredOption('--text <text>').option('--segment <index>', 'Start segment', '0').option('--position <ratio>', 'Start position 0..1', '0').option('--font-family <family>', 'Font family', 'Inter').option('--font-style <style>', 'Font style', 'Regular').action(async (nodeId, options) => {
  try { print(await run(drawTextPathCode({ nodeId, segment: options.segment, position: options.position, text: options.text, fontFamily: options.fontFamily, fontStyle: options.fontStyle }))); } catch (error) { handleEvalError(error); }
});
draw.command('transform-group <nodeIds>').requiredOption('--modifiers <json>').option('--parent <nodeId>').option('--index <index>').action(async (nodeIds, options) => {
  try { print(await run(drawTransformGroupCode({ nodeIds, parentId: options.parent, index: options.index, modifiers: options.modifiers }))); } catch (error) { handleEvalError(error); }
});
draw.command('brush <nodeId>').requiredOption('--properties <json>', 'ComplexStrokeProperties JSON').action(async (nodeId, options) => {
  try { print(await run(drawBrushCode({ nodeId, properties: options.properties }))); } catch (error) { handleEvalError(error); }
});
draw.command('stroke-profile <nodeId>').option('--preset <name>').option('--points <json>').option('--clear').action(async (nodeId, options) => {
  try { print(await run(drawStrokeProfileCode({ nodeId, preset: options.preset, points: options.points, clear: options.clear }))); } catch (error) { handleEvalError(error); }
});
draw.command('pattern <nodeId> <sourceNodeId>').requiredOption('--field <field>', 'fill or stroke').option('--tile <type>', 'rectangular, horizontal_hexagonal, vertical_hexagonal', 'rectangular').option('--scale <number>', 'Scaling factor', '1').option('--spacing-x <number>', 'Horizontal spacing', '0').option('--spacing-y <number>', 'Vertical spacing', '0').option('--alignment <value>', 'start, center, end', 'center').option('--replace').action(async (nodeId, sourceNodeId, options) => {
  try { print(await run(drawPatternCode({ nodeId, sourceNodeId, field: options.field, tileType: options.tile, scalingFactor: Number(options.scale), spacingX: Number(options.spacingX), spacingY: Number(options.spacingY), alignment: options.alignment, replace: options.replace }))); } catch (error) { handleEvalError(error); }
});
