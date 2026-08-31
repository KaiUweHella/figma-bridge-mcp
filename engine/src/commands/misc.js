// Commands: misc (extracted from index.js)
import chalk from 'chalk';
import * as apiDocs from '../api-docs.js';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import {
  ensurePluginReadiness,
  runInProcessCommandPlan,
} from '../../../src/engine.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  program,
  checkConnection,
  daemonExec,
  getDaemonToken,
  handleEvalError
} from '../lib/cli-core.js';
import {
  componentMainPlanningArgvFromRequest,
  executeComponentMainPlan,
} from '../application/component-main-command.js';
import {
  componentCombineRequestFromArgv,
  executeComponentCombinePlan,
} from '../application/component-combine-command.js';
import { executeComponentAddVariantPlan } from '../application/component-add-variant-command.js';
import { parseComponentSetReferenceRequest } from '../application/component-set-reference-request.js';
import {
  componentPropertyAddPlanningArgvFromRequest,
  executeComponentPropertyAddPlan,
} from '../application/component-property-add-command.js';
import {
  componentPropertyDeletePlanningArgvFromRequest,
  executeComponentPropertyDeletePlan,
} from '../application/component-property-delete-command.js';
import {
  componentPropertyListPlanningArgvFromRequest,
  executeComponentPropertyListPlan,
} from '../application/component-property-list-command.js';
import {
  componentPropertySetPlanningArgvFromRequest,
  executeComponentPropertySetPlan,
} from '../application/component-property-set-command.js';
import {
  componentInstantiatePlanningArgvFromRequest,
  executeComponentInstantiatePlan,
} from '../application/component-instantiate-command.js';
import {
  componentCreatePlanningArgvFromRequest,
  executeComponentCreatePlan,
} from '../application/component-create-command.js';
import {
  componentSwapPlanningArgvFromRequest,
  executeComponentSwapPlan,
} from '../application/component-swap-command.js';
import {
  componentDetachPlanningArgvFromRequest,
  executeComponentDetachPlan,
} from '../application/component-detach-command.js';
import {
  componentOverridesPlanningArgvFromRequest,
  executeComponentOverridesPlan,
} from '../application/component-overrides-command.js';
import {
  componentInventoryPlanningArgvFromRequest,
  executeComponentInventoryPlan,
} from '../application/component-inventory-command.js';
import {
  executeLayoutGridFactsPlan,
  layoutGridFactsPlanningArgvFromRequest,
} from '../application/layout-grid-facts-command.js';
import {
  devResourceReadPlanningArgvFromRequest,
  executeDevResourceReadPlan,
} from '../application/dev-resource-read-command.js';
import {
  devResourceMutationPlanningArgvFromRequest,
  executeDevResourceMutationPlan,
} from '../application/dev-resource-mutation-command.js';
import {
  executeSectionInventoryPlan,
  sectionInventoryArgvFromRequest,
} from '../application/section-inventory-command.js';
import {
  executeSectionFitPlan,
  sectionFitPlanningArgvFromRequest,
} from '../application/section-fit-command.js';
import {
  executeSectionArrangePlan,
  sectionArrangePlanningArgvFromRequest,
} from '../application/section-arrange-command.js';
import {
  executeSectionAddPlan,
  sectionAddPlanningArgvFromRequest,
} from '../application/section-add-command.js';
import {
  annotationCategoryInventoryArgvFromRequest,
  executeAnnotationCategoryInventoryPlan,
} from '../application/annotation-category-inventory-command.js';
import {
  annotationReadPlanningArgvFromRequest,
  executeAnnotationReadPlan,
} from '../application/annotation-read-command.js';
import {
  annotationClearPlanningArgvFromRequest,
  executeAnnotationClearPlan,
} from '../application/annotation-clear-command.js';
import {
  annotationRemovePlanningArgvFromRequest,
  executeAnnotationRemovePlan,
} from '../application/annotation-remove-command.js';
import {
  annotationEditPlanningArgvFromRequest,
  executeAnnotationEditPlan,
} from '../application/annotation-edit-command.js';
import {
  annotationCategoryMutationArgvFromRequest,
  executeAnnotationCategoryMutationPlan,
} from '../application/annotation-category-mutation-command.js';
import {
  annotationAddPlanningArgvFromRequest,
  executeAnnotationAddPlan,
} from '../application/annotation-add-command.js';

// NOTE: there is deliberately NO `blocks` command — this tool ships no
// pre-built page content. Agents compose layouts themselves via `render`.


// ============ DEV RESOURCES ============
// Link Figma nodes to dev artifacts (Storybook, GitHub, docs, etc.)

async function runDevResourceMutationCommand(request) {
  try {
    const plan = planFigmaCommand(devResourceMutationPlanningArgvFromRequest(request), {
      adapter: 'cli',
      fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
        return executeDevResourceMutationPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stderr) console.error(chalk.yellow(result.stderr));
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Dev Resource Mutation failed: ' + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

const devCmd = program
  .command('dev')
  .description('Manage dev resources (Storybook/GitHub/doc links on nodes)');

devCmd
  .command('link <nodeId> <url>')
  .description('Add a dev resource link to a node')
  .option('-n, --name <name>', 'Display name for the link')
  .allowExcessArguments(false)
  .action(async (nodeId, url, options) => {
    await runDevResourceMutationCommand({
      action: 'link', nodeId, url, name: options.name || null,
    });
  });

devCmd
  .command('list [nodeId]')
  .description('List dev resources on a node (or current selection)')
  .allowExcessArguments(false)
  .action(async (nodeId) => {
    try {
      const plan = planFigmaCommand(devResourceReadPlanningArgvFromRequest({
        nodeId: nodeId || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeDevResourceReadPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Dev Resource Read failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

devCmd
  .command('unlink <nodeId> <url>')
  .description('Remove a dev resource link from a node')
  .allowExcessArguments(false)
  .action(async (nodeId, url) => {
    await runDevResourceMutationCommand({ action: 'unlink', nodeId, url });
  });

devCmd
  .command('edit <nodeId> <currentUrl> <newUrl>')
  .description('Edit an existing dev resource (replace URL and/or name)')
  .option('-n, --name <name>', 'New display name')
  .allowExcessArguments(false)
  .action(async (nodeId, currentUrl, newUrl, options) => {
    await runDevResourceMutationCommand({
      action: 'edit', nodeId, currentUrl, newUrl, name: options.name || null,
    });
  });

// ============ SECTIONS ============
// Group frames into named Figma sections for canvas organization.

const sectionCmd = program
  .command('section')
  .description('Manage Figma sections (organize frames into named groups)');

// The one place the section geometry lives: wrap section `s` around its
// children (relative coords) with PAD margin + HEADER allowance, shifting
// the children by the inverse so nothing moves on the canvas. Shared by
// `create` and `fit` — two copies of this math drift, and a drifted copy
// means sections that jump or overlap on every reflow.
const SECTION_HEADER = 40;
function sectionFitSnippet(padExpr) {
  return `
      const PAD = ${padExpr}, HEADER = ${SECTION_HEADER};
      const minX = Math.min(...s.children.map(c => c.x));
      const minY = Math.min(...s.children.map(c => c.y));
      const maxX = Math.max(...s.children.map(c => c.x + c.width));
      const maxY = Math.max(...s.children.map(c => c.y + c.height));
      const dx = minX - PAD;
      const dy = minY - PAD - HEADER;
      s.x += dx;
      s.y += dy;
      s.resizeWithoutConstraints(maxX - minX + 2 * PAD, maxY - minY + 2 * PAD + HEADER);
      for (const c of s.children) { c.x -= dx; c.y -= dy; }
`;
}

sectionCmd
  .command('create <name> [nodeIds]')
  .description('Create a section, optionally moving comma-separated node IDs into it')
  .action(async (name, nodeIds) => {
    await checkConnection();
    const ids = nodeIds ? JSON.stringify(nodeIds.split(',').map(s => s.trim())) : '[]';
    const code = `(async () => {
      const ids = ${ids};
      const s = figma.createSection();
      s.name = ${JSON.stringify(name)};
      for (const id of ids) {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) throw new Error('Node not found: ' + id);
        // Preserve the node's visual position across reparenting: appendChild
        // keeps x/y numbers, which become section-relative.
        const b = n.absoluteBoundingBox;
        s.appendChild(n);
        if (b) { n.x = b.x - s.x; n.y = b.y - s.y; }
      }
      if (s.children.length > 0) {
        ${sectionFitSnippet(64)}
      }
      return { id: s.id, name: s.name, count: ids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Created section "${r.name}" (${r.id}) with ${r.count} child(ren)`);
    } catch (e) {
      handleEvalError(e);
    }
  });

sectionCmd
  .command('fit <sectionId>')
  .description('Shrink/grow a section to wrap its children (children stay visually in place)')
  .option('--pad <n>', 'Padding around children', '64')
  .allowExcessArguments(false)
  .action(async (sectionId, options) => {
    try {
      const plan = planFigmaCommand(sectionFitPlanningArgvFromRequest({
        sectionId,
        pad: options.pad,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeSectionFitPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Section Fit failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

sectionCmd
  .command('arrange <sectionId>')
  .description('Arrange a section\'s children in a grid (reading order: current y, then x), then fit the bounds')
  .option('-c, --cols <n>', 'Number of columns', '4')
  .option('-g, --gap <n>', 'Gap between children', '48')
  .option('--pad <n>', 'Padding around children', '64')
  .option('--group-rows', 'Start a new row per node type (component sets, then components, instances, frames), sorted by name within each group')
  .allowExcessArguments(false)
  .action(async (sectionId, options) => {
    try {
      const plan = planFigmaCommand(sectionArrangePlanningArgvFromRequest({
        sectionId,
        cols: options.cols,
        gap: options.gap,
        pad: options.pad,
        groupRows: options.groupRows === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeSectionArrangePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Section Arrange failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

sectionCmd
  .command('list')
  .description('List all sections on the current page')
  .allowExcessArguments(false)
  .action(async () => {
    try {
      const plan = planFigmaCommand(sectionInventoryArgvFromRequest({}), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeSectionInventoryPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Section Inventory failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

sectionCmd
  .command('add <sectionId> <nodeIds>')
  .description('Add comma-separated nodes into an existing section')
  .allowExcessArguments(false)
  .action(async (sectionId, nodeIds) => {
    try {
      const plan = planFigmaCommand(sectionAddPlanningArgvFromRequest({
        sectionId, nodeIds: nodeIds.split(',').map((value) => value.trim()),
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeSectionAddPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Section Add failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// ============ LAYOUT GUIDES ============
// Manage Figma Layout Guides on frames (12-column guides, baseline guides, etc.).

const gridCmd = program
  .command('grid')
  .description('Manage Layout Guides on frames (not Auto Layout Grid)');

gridCmd
  .command('set <nodeId>')
  .description('Set a column or row Layout Guide on a frame')
  .option('-c, --columns <n>', 'Number of columns', parseInt)
  .option('-r, --rows <n>', 'Number of rows', parseInt)
  .option('-g, --gutter <n>', 'Gutter size in px', parseInt, 16)
  .option('-m, --margin <n>', 'Outer margin in px', parseInt, 0)
  .option('-a, --alignment <align>', 'Alignment: stretch|min|center|max', 'stretch')
  .option('--color <hex>', 'Grid color (hex)', '#FF008B')
  .option('--opacity <n>', 'Grid opacity (0-1)', parseFloat, 0.1)
  .option('--append', 'Append to existing grids instead of replacing')
  .action(async (nodeId, options) => {
    await checkConnection();
    if (!options.columns && !options.rows) {
      console.error(chalk.red('✗'), 'Specify at least --columns or --rows');
      process.exit(1);
    }
    const alignmentMap = { stretch: 'STRETCH', min: 'MIN', center: 'CENTER', max: 'MAX' };
    const alignment = alignmentMap[options.alignment.toLowerCase()] || 'STRETCH';
    const hex = options.color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const colorObj = `{r:${r.toFixed(4)},g:${g.toFixed(4)},b:${b.toFixed(4)},a:${options.opacity}}`;

    const grids = [];
    if (options.columns) {
      grids.push(`{pattern:'COLUMNS',alignment:'${alignment}',count:${options.columns},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    if (options.rows) {
      grids.push(`{pattern:'ROWS',alignment:'${alignment}',count:${options.rows},gutterSize:${options.gutter},offset:${options.margin},color:${colorObj},visible:true}`);
    }
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support Layout Guides (must be FRAME, COMPONENT, or COMPONENT_SET)');
      const newGrids = [${grids.join(',')}];
      n.layoutGrids = ${options.append ? '[...n.layoutGrids, ...newGrids]' : 'newGrids'};
      return { id: n.id, name: n.name, count: n.layoutGrids.length };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Set grid on ${r.name} (${r.id})`);
      console.log(chalk.gray(`  Total grids: ${r.count}`));
    } catch (e) {
      handleEvalError(e);
    }
  });

gridCmd
  .command('list [nodeId]')
  .description('List Layout Guides on a frame (or current selection)')
  .option('--json', 'Print exact structured Layout Guide facts')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(layoutGridFactsPlanningArgvFromRequest({
        nodeId: nodeId || null,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeLayoutGridFactsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Layout Grid Facts failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

gridCmd
  .command('clear <nodeId>')
  .description('Remove all Layout Guides from a frame')
  .action(async (nodeId) => {
    await checkConnection();
    const code = `(async () => {
      const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
      if (!n) throw new Error('Node not found: ${nodeId}');
      if (!('layoutGrids' in n)) throw new Error('Node does not support Layout Guides');
      n.layoutGrids = [];
      return { id: n.id, name: n.name };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      console.log(chalk.green('✓'), `Cleared grids on ${r.name} (${r.id})`);
    } catch (e) {
      handleEvalError(e);
    }
  });

// ============ COMPONENT PROPERTIES ============
// Manage variant/boolean/text/instance-swap properties on Figma components.

// (componentInventoryCode moved to lib/component-inventory.js — it is shared
// library code, and commands/map.js was importing a command file for it.)
const componentCmd = program
  .command('component')
  .description('Manage component properties and variants');

async function runComponentCreateCommand(request) {
  const argv = componentCreatePlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentCreatePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

componentCmd
  .command('create [name]')
  .description('Create an empty component with explicit geometry')
  .option('-w, --width <n>', 'Width', '100')
  .option('-h, --height <n>', 'Height', '100')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index')
  .option('--json', 'Output as JSON')
  .action(async (name, options) => {
    try {
      const result = await runComponentCreateCommand({
        name: name ?? 'Component',
        width: options.width,
        height: options.height,
        x: options.x,
        y: options.y,
        parentId: options.parent ?? null,
        index: options.index ?? null,
        json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Create failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runComponentAddVariantCommand(argv) {
  parseComponentSetReferenceRequest(argv);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentAddVariantPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runComponentPropertySetCommand(request) {
  const argv = componentPropertySetPlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentPropertySetPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runComponentPropertyAddCommand(request) {
  const argv = componentPropertyAddPlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentPropertyAddPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runComponentPropertyDeleteCommand(request) {
  const argv = componentPropertyDeletePlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentPropertyDeletePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runComponentPropertyListCommand(request) {
  const argv = componentPropertyListPlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentPropertyListPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

async function runComponentInstantiateCommand(request) {
  const argv = componentInstantiatePlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentInstantiatePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

componentCmd
  .command('instantiate <componentId>')
  .description('Create an instance from an explicit main component')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('--name <name>', 'Rename the instance layer')
  .option('--parent <nodeId>', 'Create inside this existing parent')
  .option('--index <n>', 'Insert at this child index')
  .option('--json', 'Output as JSON')
  .action(async (componentId, options) => {
    try {
      const result = await runComponentInstantiateCommand({
        componentId,
        parentId: options.parent ?? null,
        x: options.x,
        y: options.y,
        index: options.index ?? null,
        name: options.name ?? null,
        json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Instantiate failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

componentCmd
  .command('list')
  .description('List component sets (with variant axes) and standalone components')
  .option('--all-pages', 'Search every page, not just the current one (slower on big files)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(componentInventoryPlanningArgvFromRequest({
        allPages: options.allPages === true,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeComponentInventoryPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Inventory failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

componentCmd
  .command('main <instanceId>')
  .description('Resolve an instance to its main component (and variant set, if any)')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (instanceId, options) => {
    try {
      const plan = planFigmaCommand(componentMainPlanningArgvFromRequest({
        instanceId,
        json: options.json === true,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeComponentMainPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Main failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runComponentSwapCommand(request) {
  const argv = componentSwapPlanningArgvFromRequest(request);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentSwapPlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

componentCmd
  .command('swap <instanceId> <componentId>')
  .description('Swap an explicit instance to an explicit main component')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (instanceId, componentId, options) => {
    try {
      const result = await runComponentSwapCommand({
        instanceId,
        componentId,
        json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Swap failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

componentCmd
  .command('detach <instanceId>')
  .description('Detach an explicit instance into an editable frame')
  .option('--name <name>', 'Rename the detached frame')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (instanceId, options) => {
    try {
      const argv = componentDetachPlanningArgvFromRequest({
        instanceId,
        name: options.name ?? null,
        json: options.json === true,
      });
      const plan = planFigmaCommand(argv, {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeComponentDetachPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Detach failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

componentCmd
  .command('overrides <instanceId> <action>')
  .description('Remove all direct instance overrides (compatible action aliases: reset | remove)')
  .option('--json', 'Output as JSON')
  .allowExcessArguments(false)
  .action(async (instanceId, action, options) => {
    try {
      const argv = componentOverridesPlanningArgvFromRequest({
        instanceId,
        action,
        json: options.json === true,
      });
      const plan = planFigmaCommand(argv, {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeComponentOverridesPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Overrides failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

const propCmd = componentCmd
  .command('prop')
  .description('Manage component properties (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT)');

propCmd
  .command('add <componentId> <name> <type> <defaultValue>')
  .description('Add a property. Type: boolean | text | instance-swap | variant')
  .option('-o, --options <opts>', 'Comma-separated VARIANT options (e.g. "Small,Medium,Large")')
  .option('--json', 'Output as JSON')
  .action(async (componentId, name, type, defaultValue, options) => {
    try {
      const result = await runComponentPropertyAddCommand({
        componentId, name, type, defaultValue,
        options: options.options ?? null,
        json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Property Add failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

propCmd
  .command('list [componentId]')
  .description('List component properties on a component (or current selection)')
  .option('--json', 'Output as JSON')
  .action(async (componentId, options) => {
    try {
      const result = await runComponentPropertyListCommand({
        componentId: componentId ?? null,
        json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Property List failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

propCmd
  .command('set <instanceId> <name> <value>')
  .description('Set a VARIANT, BOOLEAN, TEXT, or INSTANCE_SWAP property on an instance')
  .option('--json', 'Output as JSON')
  .action(async (instanceId, name, value, options) => {
    try {
      const result = await runComponentPropertySetCommand({
        instanceId, name, value, json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Property Set failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

propCmd
  .command('delete <componentId> <propName>')
  .description('Delete a component property (use full name including #suffix)')
  .option('--json', 'Output as JSON')
  .action(async (componentId, propName, options) => {
    try {
      const result = await runComponentPropertyDeleteCommand({
        componentId, propName, json: options.json === true,
      });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Property Delete failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runComponentCombineCommand(argv) {
  componentCombineRequestFromArgv(argv);
  const plan = planFigmaCommand(argv, {
    adapter: 'cli',
    fileKey: program.opts().figmaFile || null,
  });
  return runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
      return executeComponentCombinePlan(plan, {
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
    });
}

componentCmd
  .command('combine [args...]')
  .usage('<id[,id...]> [moreIds...] [-n|--name <name>] [--json]')
  .description('Combine two or more standalone local components into a verified variant set')
  .allowUnknownOption(true)
  .addHelpText('after', [
    '',
    'Accepted syntax:',
    '  component combine 10:1,10:2 --name Button',
    '  component combine 10:1 10:2 --name Button --json',
  ].join('\n'))
  .action(async (args) => {
    try {
      const result = await runComponentCombineCommand(['component', 'combine', ...args]);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Combine failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

componentCmd
  .command('add-variant <set> <pairs>')
  .description('Add a variant to a node:/name: Component Set reference or compatible query')
  .option('--from <variantName>', 'Clone this variant instead of the nearest match')
  .option('--json', 'Output as JSON')
  .action(async (set, pairsArg, options) => {
    try {
      const argv = [
        'component', 'add-variant', set, pairsArg,
        ...(options.from === undefined ? [] : ['--from', options.from]),
        ...(options.json ? ['--json'] : []),
      ];
      const result = await runComponentAddVariantCommand(argv);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Component Add Variant failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// ============ ANNOTATIONS ============
// Inline notes / specs on Figma nodes (tokens, usage rules, etc.)

const annotateCmd = program
  .command('annotate')
  .description('Manage annotations (inline notes) on nodes');

annotateCmd
  .command('add')
  .description('Add an annotation. Pass --node <id> for one, or --query <pattern> for all matches.')
  .argument('<text>', 'Annotation text (or markdown if --markdown)')
  .option('-m, --markdown', 'Treat text as markdown')
  .option('-n, --node <id>', 'Node ID to annotate')
  .option('-q, --query <pattern>', 'Apply to all nodes whose name contains <pattern> (case-insensitive)')
  .option('-c, --category <idOrLabel>', 'Annotation category ID or label')
  .option('-p, --properties <list>', 'Comma-separated Figma annotation property names')
  .allowExcessArguments(false)
  .action(async (text, options) => {
    try {
      const plan = planFigmaCommand(annotationAddPlanningArgvFromRequest({
        text,
        markdown: options.markdown === true,
        nodeId: options.node || null,
        query: options.query,
        category: options.category,
        properties: options.properties,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationAddPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Add failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

annotateCmd.command('edit <nodeId> <index>')
  .description('Edit one zero-based annotation index')
  .option('-t, --text <text>').option('-m, --markdown').option('-c, --category <idOrLabel>', 'Pass an empty string to clear')
  .option('-p, --properties <list>', 'Comma-separated properties; pass an empty string to clear')
  .allowExcessArguments(false)
  .action(async (nodeId, index, options) => {
    try {
      const plan = planFigmaCommand(annotationEditPlanningArgvFromRequest({
        nodeId,
        index,
        text: options.text,
        markdown: options.markdown === true,
        category: options.category,
        properties: options.properties,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationEditPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Edit failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

annotateCmd.command('remove <nodeId> <index>')
  .description('Remove one zero-based annotation index')
  .allowExcessArguments(false)
  .action(async (nodeId, index) => {
    try {
      const plan = planFigmaCommand(annotationRemovePlanningArgvFromRequest({ nodeId, index }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationRemovePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Remove failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

annotateCmd.command('categories')
  .description('List annotation categories in the open file')
  .allowExcessArguments(false)
  .action(async () => {
    try {
      const plan = planFigmaCommand(annotationCategoryInventoryArgvFromRequest({}), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationCategoryInventoryPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Category Inventory failed: '
        + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

async function runAnnotationCategoryMutationCommand(request) {
  try {
    const plan = planFigmaCommand(annotationCategoryMutationArgvFromRequest(request), {
      adapter: 'cli',
      fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
        return executeAnnotationCategoryMutationPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    if (result.stderr) console.error(chalk.yellow(result.stderr));
    console.log(result.stdout);
  } catch (error) {
    console.error(chalk.red('✗ Annotation Category Mutation failed: '
      + (error?.message || String(error))));
    process.exitCode = 1;
  }
}

annotateCmd.command('category-add <label>')
  .requiredOption('--color <color>')
  .allowExcessArguments(false)
  .action(async (label, options) => {
    await runAnnotationCategoryMutationCommand({ action: 'add', label, color: options.color });
  });
annotateCmd.command('category-edit <category>')
  .option('--label <label>')
  .option('--color <color>')
  .allowExcessArguments(false)
  .action(async (category, options) => {
    await runAnnotationCategoryMutationCommand({
      action: 'edit', category, label: options.label, color: options.color,
    });
  });
annotateCmd.command('category-remove <category>')
  .allowExcessArguments(false)
  .action(async (category) => {
    await runAnnotationCategoryMutationCommand({ action: 'remove', category });
  });

annotateCmd
  .command('list [nodeId]')
  .description('List annotations on a node (or current selection)')
  .allowExcessArguments(false)
  .action(async (nodeId) => {
    try {
      const plan = planFigmaCommand(annotationReadPlanningArgvFromRequest({
        nodeId: nodeId || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationReadPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Read failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

annotateCmd
  .command('clear <nodeId>')
  .description('Remove all annotations from a node')
  .allowExcessArguments(false)
  .action(async (nodeId) => {
    try {
      const plan = planFigmaCommand(annotationClearPlanningArgvFromRequest({ nodeId }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey });
          return executeAnnotationClearPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      console.log(result.stdout);
    } catch (error) {
      console.error(chalk.red('✗ Annotation Clear failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// ============ PLUGINS ============
// The `plugins` command group (voice plugins etc.) was removed in
// figma-bridge-mcp — plugins.js and plugins/voice/ are not vendored.

// === API docs (offline Figma Plugin API reference) ===
const apiCmd = program
  .command('api [name]')
  .description('Look up Figma Plugin API interface or type (offline). Run `api setup` first.')
  .option('--full', 'Full official TypeScript declaration and prose (default is compact signatures)')
  .action((name, options) => apiDocs.show(name, { full: !!options.full }));

// `api show <name>` forces a reference lookup: unlike `api <name>`, a name that
// collides with a subcommand (setup/list/index/context/age/gap/search) is taken
// as the lookup argument, never dispatched. The MCP figma_reference tool uses
// this so no interface name can trigger a side-effecting subcommand.
apiCmd
  .command('show <name>')
  .description('Show a specific interface/type by name (never dispatches to a subcommand)')
  .option('--full', 'Full official TypeScript declaration and prose (default is compact signatures)')
  .action((name, options) => apiDocs.show(name, { full: !!options.full }));

apiCmd
  .command('setup')
  .description('Build the private offline reference from the reviewed official @figma/plugin-typings dependency (no network).')
  .option('--update', 'Revalidate and reactivate the official typings shipped with this Bridge version')
  .action((options) => apiDocs.setup({ update: !!options.update }));

apiCmd
  .command('index')
  .description('Revalidate the official private reference and print its compact index status.')
  .action(() => apiDocs.buildIndex());

apiCmd
  .command('context [topic]')
  .description('Print an LLM-ready context block. Without topic: the compact index. With topic: index + relevant interface bodies.')
  .action((topic) => {
    process.stdout.write(apiDocs.getContext(topic || ''));
  });

apiCmd
  .command('age')
  .description('Days since this reviewed official material was activated in private state.')
  .action(() => {
    const days = apiDocs.ageInDays();
    if (days === Infinity) {
      console.log('not installed');
      process.exit(1);
    }
    console.log(days.toFixed(1));
  });

apiCmd
  .command('list [filter]')
  .description('List all interfaces and types (optional substring filter)')
  .action((filter) => apiDocs.list(filter));

apiCmd
  .command('gap')
  .description('Compare engine coverage with the installed official @figma/plugin-typings')
  .action(() => apiDocs.gap());

apiCmd
  .command('search <keyword>')
  .description('Find Plugin API methods/properties whose name contains <keyword> (e.g. "scale", "resize")')
  .option('--json', 'Output as JSON (machine-readable, for the API-doc auto-fallback)')
  .option('-l, --limit <n>', 'Max results', '8')
  .action((keyword, options) => {
    const results = apiDocs.searchMethods(keyword);
    if (results.length === 0) {
      if (options.json) {
        console.log('[]');
      } else {
        console.error(`No Plugin API method matching "${keyword}".`);
      }
      return;
    }
    const top = results.slice(0, parseInt(options.limit) || 8);
    if (options.json) {
      console.log(JSON.stringify(top.map(r => ({
        method: r.method, signature: r.signature, interface: r.interface
      })), null, 2));
      return;
    }
    console.log(`Top Plugin API matches for "${keyword}":\n`);
    for (const r of top) {
      console.log(`  ${chalk.cyan(r.method)}  ${chalk.dim('on ' + r.interface)}`);
      if (r.signature) console.log(`    ${chalk.gray(r.signature)}`);
    }
    console.log('\nTip: these are the raw Figma API calls the commands above are built from.');
  });

// (Unknown-command handling lives inside the default program.action)
