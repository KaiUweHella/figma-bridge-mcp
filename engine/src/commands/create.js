// Commands: create (extracted from index.js)
import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  checkConnection,
  daemonExec,
  evalPrint,
  getVarName,
  program
} from '../lib/cli-core.js';
import {
  createFramePlanningArgvFromRequest,
  executeCreateFramePlan,
} from '../application/create-frame-command.js';
import {
  createShapePlanningArgvFromRequest,
  executeCreateShapePlan,
} from '../application/create-shape-command.js';
import {
  createCanvasNodePlanningArgvFromRequest,
  executeCreateCanvasNodePlan,
} from '../application/create-canvas-node-command.js';
import {
  createLinePlanningArgvFromRequest,
  executeCreateLinePlan,
} from '../application/create-line-command.js';
import {
  createAutoLayoutPlanningArgvFromRequest,
  executeCreateAutoLayoutPlan,
} from '../application/create-auto-layout-command.js';
import {
  createTextPlanningArgvFromRequest,
  executeCreateTextPlan,
} from '../application/create-text-command.js';
import {
  createImageArgvFromRequest,
  executeCreateImagePlan,
  prepareCreateImagePlan,
} from '../application/create-image-command.js';

// ============ CREATE ============

const create = program
  .command('create')
  .description('Create Figma elements');

async function runCreateShape(kind, name, options) {
  try {
    const plan = planFigmaCommand(createShapePlanningArgvFromRequest({
      kind, name, width: options.width, height: options.height,
      x: options.x, y: options.y, fill: options.fill, stroke: options.stroke,
      radius: options.radius, opacity: options.opacity, points: options.points,
      innerRadius: options.innerRadius, parentId: options.parent, index: options.index,
    }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCreateShapePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Create Shape failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

async function runCreateCanvasNode(kind, name, options) {
  try {
    const plan = planFigmaCommand(createCanvasNodePlanningArgvFromRequest({
      kind, name, width: options.width, height: options.height,
      x: options.x, y: options.y, network: options.network,
      parentId: options.parent, index: options.index,
    }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCreateCanvasNodePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Create Canvas Node failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

async function runCreateLine(options) {
  try {
    const plan = planFigmaCommand(createLinePlanningArgvFromRequest({
      x1: options.x1, y1: options.y1, x2: options.x2, y2: options.y2,
      length: options.length, color: options.color, weight: options.weight,
      spacing: options.spacing, parentId: options.parent, index: options.index,
    }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCreateLinePlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Create Line failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

async function runCreateAutoLayout(name, options) {
  try {
    const plan = planFigmaCommand(createAutoLayoutPlanningArgvFromRequest({
      name, direction: options.direction, gap: options.gap, padding: options.padding,
      x: options.x, y: options.y, fill: options.fill, radius: options.radius,
      spacing: options.spacing, parentId: options.parent, index: options.index,
    }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCreateAutoLayoutPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Create Auto Layout failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

async function runCreateText(content, options) {
  try {
    const plan = planFigmaCommand(createTextPlanningArgvFromRequest({
      content, x: options.x, y: options.y, size: options.size,
      color: options.color, weight: options.weight, font: options.font,
      width: options.width, spacing: options.spacing,
      parentId: options.parent, index: options.index,
    }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCreateTextPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Create Text failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

create
  .command('frame <name>')
  .description('Create a frame')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--smart', 'Auto-position to avoid overlaps (default if no -x)')
  .option('-g, --gap <n>', 'Gap for smart positioning', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const plan = planFigmaCommand(createFramePlanningArgvFromRequest({
        name,
        width: options.width,
        height: options.height,
        x: options.x,
        y: options.y,
        fill: options.fill,
        radius: options.radius,
        smart: options.smart === true,
        gap: options.gap,
        parentId: options.parent,
        index: options.index,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCreateFramePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Create Frame failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// (create icon removed: it fetched artwork from an external icon CDN.
// The no-network build gets real icons from the Figma file via `export assets`.)

create
  .command('image <url>')
  .description('Create an image from URL (PNG, JPG, GIF, WebP)')
  .option('-w, --width <n>', 'Width (auto if not set)')
  .option('-h, --height <n>', 'Height (auto if not set)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-n, --name <name>', 'Node name', 'Image')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .allowExcessArguments(false)
  .action(async (url, options) => {
    try {
      const plan = planFigmaCommand(createImageArgvFromRequest({
        url,
        width: options.width,
        height: options.height,
        x: options.x,
        y: options.y,
        name: options.name,
        spacing: options.spacing,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          const remainingMs = () => Math.max(0, deadline - Date.now());
          const prepared = await prepareCreateImagePlan(plan, { remainingMs });
          await ensurePluginReadiness({
            deadline, maxWaitMs: 8000, fileKey, expectedEditor,
          });
          return executeCreateImagePlan(plan, prepared, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, remainingMs())),
          });
        });
      console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      console.error(chalk.red('✗ Create Image failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// config.js continues to register subcommands on this group
export { create };

// ============ SHAPE PRIMITIVES ============
// (Moved here from commands/config.js, which defined `create` subcommands
// while importing the `create` group from this file.)

create
  .command('rect [name]')
  .alias('rectangle')
  .description('Create a rectangle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--opacity <n>', 'Opacity 0-1')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => runCreateShape('rect', name, options));

create
  .command('ellipse [name]')
  .alias('circle')
  .description('Create an ellipse/circle (auto-positions to avoid overlap)')
  .option('-w, --width <n>', 'Width (diameter)', '100')
  .option('-h, --height <n>', 'Height (same as width for circle)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
  .option('--stroke <color>', 'Stroke color (hex or var:name)')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => runCreateShape('ellipse', name, options));

function registerRadialPrimitive({ command, description, defaultName, extraOptions = [] }) {
  let primitive = create
    .command(`${command} [name]`)
    .description(description)
    .option('-w, --width <n>', 'Width', '100')
    .option('-h, --height <n>', 'Height', '100')
    .option('-x <n>', 'X position (auto if not set)')
    .option('-y <n>', 'Y position', '0')
    .option('--fill <color>', 'Fill color (hex or var:name)', '#D9D9D9')
    .option('--stroke <color>', 'Stroke color (hex or var:name)')
    .option('--parent <nodeId>', 'Create inside this existing parent')
    .option('--index <n>', 'Insert at this child index (default: append)');
  for (const option of extraOptions) primitive = primitive.option(...option);
  primitive.allowExcessArguments(false).action(async (name, options) => {
    await runCreateShape(command, name || defaultName, options);
  });
}

registerRadialPrimitive({
  command: 'polygon',
  description: 'Create a regular polygon',
  defaultName: 'Polygon',
  extraOptions: [['--points <n>', 'Number of sides (3 or more)', '3']],
});

registerRadialPrimitive({
  command: 'star',
  description: 'Create a star',
  defaultName: 'Star',
  extraOptions: [
    ['--points <n>', 'Number of outer points (3 or more)', '5'],
    ['--inner-radius <n>', 'Inner radius from 0 to 1', '0.382'],
  ],
});

create
  .command('vector [name]')
  .description('Create an empty vector, optionally with a validated VectorNetwork JSON value')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--network <json>', 'Figma VectorNetwork JSON')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => runCreateCanvasNode('vector', name, options));

create
  .command('slice [name]')
  .description('Create an export slice')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => runCreateCanvasNode('slice', name, options));

create
  .command('text <content>')
  .description('Create a text layer (smart positions by default)')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .option('-c, --color <color>', 'Text color (hex or var:name)', '#000000')
  .option('-w, --weight <weight>', 'Font weight: regular, medium, semibold, bold', 'regular')
  .option('--font <family>', 'Font family', 'Inter')
  .option('--width <n>', 'Text box width (auto-width if not set)')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (content, options) => runCreateText(content, options));

create
  .command('line')
  .description('Create a line (smart positions by default)')
  .option('--x1 <n>', 'Start X (auto if not set)')
  .option('--y1 <n>', 'Start Y', '0')
  .option('--x2 <n>', 'End X (auto + length if x1 not set)')
  .option('--y2 <n>', 'End Y', '0')
  .option('-l, --length <n>', 'Line length', '100')
  .option('-c, --color <color>', 'Line color (hex or var:name)', '#000000')
  .option('-w, --weight <n>', 'Stroke weight', '1')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (options) => runCreateLine(options));

create
  .command('component [name]')
  .description('Convert selection to component')
  .action(async (name) => {
    await checkConnection();
    const compName = name || 'Component';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length === 0) 'No selection';
else if (sel.length === 1) {
  const comp = figma.createComponentFromNode(sel[0]);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created: ' + comp.name;
} else {
  const group = figma.group(sel, figma.currentPage);
  const comp = figma.createComponentFromNode(group);
  comp.name = ${JSON.stringify(compName)};
  figma.currentPage.selection = [comp];
  'Component created from ' + sel.length + ' elements: ' + comp.name;
}
`;
    await evalPrint(code);
  });

create
  .command('group [name]')
  .description('Group current selection')
  .action(async (name) => {
    await checkConnection();
    const groupName = name || 'Group';
    let code = `
const sel = figma.currentPage.selection;
if (sel.length < 2) 'Select 2+ elements to group';
else {
  const group = figma.group(sel, figma.currentPage);
  group.name = ${JSON.stringify(groupName)};
  figma.currentPage.selection = [group];
  'Grouped ' + sel.length + ' elements';
}
`;
    await evalPrint(code);
  });

create
  .command('autolayout [name]')
  .alias('al')
  .description('Create an auto-layout frame (smart positions by default)')
  .option('-d, --direction <dir>', 'Direction: row, col', 'row')
  .option('-g, --gap <n>', 'Gap between items', '8')
  .option('-p, --padding <n>', 'Padding', '16')
  .option('-x <n>', 'X position (auto if not set)')
  .option('-y <n>', 'Y position', '0')
  .option('--fill <color>', 'Fill color (hex or var:name)')
  .option('--radius <n>', 'Corner radius')
  .option('--spacing <n>', 'Gap from other elements', '100')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index (default: append)')
  .allowExcessArguments(false)
  .action(async (name, options) => runCreateAutoLayout(name, options));
