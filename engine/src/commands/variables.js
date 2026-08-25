// Commands: variables (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeVariableDiscoveryPlan,
  variableDiscoveryPlanningArgvFromRequest,
} from '../application/variable-discovery-command.js';
import {
  executeVariableFactsPlan,
  variableFactsArgvFromRequest,
} from '../application/variable-facts-command.js';
import {
  executeVariableCreatePlan,
  variableCreatePlanningArgvFromRequest,
} from '../application/variable-create-command.js';
import {
  executeVariableCreateBatchPlan,
  variableCreateBatchPlanningArgvFromRequest,
} from '../application/variable-create-batch-command.js';
import {
  executeVariableSetValuePlan,
  variableSetValuePlanningArgvFromRequest,
} from '../application/variable-set-value-command.js';
import {
  executeVariableCodeSyntaxPlan,
  variableCodeSyntaxPlanningArgvFromRequest,
} from '../application/variable-code-syntax-command.js';
import {
  executeVariableUpdatePlan,
  variableUpdatePlanningArgvFromRequest,
} from '../application/variable-update-command.js';
import {
  executeVariableResolutionPlan,
  variableResolutionPlanningArgvFromRequest,
} from '../application/variable-resolution-command.js';
import {
  executeTokenPublishStatusPlan,
  tokenPublishStatusPlanningArgvFromRequest,
} from '../application/token-publish-status-command.js';
import {
  executeVariableDeletePlan,
  variableDeletePlanningArgvFromRequest,
} from '../application/variable-delete-command.js';
import {
  progress,
  program,
  checkConnection,
  daemonExec,
  fastEval,
  handleEvalError,
  hexToRgb,
  spinnerSucceed
} from '../lib/cli-core.js';
// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

async function runVariableDiscovery(action, pattern, options) {
  try {
    const plan = planFigmaCommand(variableDiscoveryPlanningArgvFromRequest({
      action,
      pattern,
      limit: options.limit || null,
      json: options.json === true,
    }), {
      adapter: 'cli',
      fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeVariableDiscoveryPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error);
    process.exitCode = 1;
  }
}

variables
  .command('list')
  .description('List all variables')
  .option('-l, --limit <count>', 'Maximum variables returned')
  .option('--json', 'Return bounded identity facts as JSON')
  .allowExcessArguments(false)
  .action(async (options) => runVariableDiscovery('list', null, options));

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN, EASING, TIMING')
  .option('-v, --value <value>', 'Initial value; EASING accepts a name or MotionEasing JSON, TIMING uses seconds')
  .option('--allow-duplicate', 'Intentionally allow an exact duplicate name in the Collection')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const plan = planFigmaCommand(variableCreatePlanningArgvFromRequest({
        name,
        collection: options.collection,
        type: options.type,
        value: options.value,
        allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCreatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .option('-l, --limit <count>', 'Maximum variables returned')
  .option('--json', 'Return bounded identity facts as JSON')
  .allowExcessArguments(false)
  .action(async (pattern, options) => runVariableDiscovery('find', pattern, options));

variables.command('show <variable>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(variableFactsArgvFromRequest({
        variable,
        collection: options.collection || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableFactsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('update <variable>')
  .option('-c, --collection <collection>').option('-n, --name <name>')
  .option('-d, --description <text>').option('--hidden <boolean>').option('--scopes <list>', 'Comma-separated Figma variable scopes')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(variableUpdatePlanningArgvFromRequest({
        variable,
        collection: options.collection || null,
        name: options.name,
        description: options.description,
        hidden: options.hidden,
        scopes: options.scopes,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableUpdatePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('set-value <variable> [value]')
  .requiredOption('-m, --mode <mode>', 'Mode ID or name').option('-c, --collection <collection>')
  .option('--alias <variable>', 'Set a variable alias instead of a literal value')
  .allowExcessArguments(false)
  .action(async (variable, value, options) => {
    try {
      const plan = planFigmaCommand(variableSetValuePlanningArgvFromRequest({
        variable,
        value,
        alias: options.alias || null,
        mode: options.mode,
        collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableSetValuePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('code-syntax <variable> <platform> [value]')
  .option('-c, --collection <collection>').option('--remove', 'Remove the platform definition')
  .allowExcessArguments(false)
  .action(async (variable, platform, value, options) => {
    try {
      const plan = planFigmaCommand(variableCodeSyntaxPlanningArgvFromRequest({
        variable,
        platform,
        value,
        collection: options.collection || null,
        remove: options.remove === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCodeSyntaxPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('resolve <variable> <nodeId>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, nodeId, options) => {
    try {
      const plan = planFigmaCommand(variableResolutionPlanningArgvFromRequest({
        variable,
        nodeId,
        collection: options.collection || null,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableResolutionPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables.command('publish-status <variable>')
  .option('-c, --collection <collection>')
  .allowExcessArguments(false)
  .action(async (variable, options) => {
    try {
      const plan = planFigmaCommand(tokenPublishStatusPlanningArgvFromRequest({
        kind: 'variable', query: variable, collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenPublishStatusPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('visualize [collection]')
  .description('Create color swatches on canvas (grouped palette layout)')
  .action(async (collection, options) => {
    await checkConnection();
    const spinner = progress('Creating color palette...').start();

    const code = `(async () => {
await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

const collections = await figma.variables.getLocalVariableCollectionsAsync();
const colorVars = await figma.variables.getLocalVariablesAsync('COLOR');

const targetCols = ${collection ? `collections.filter(c => c.name.toLowerCase().includes(${JSON.stringify(collection)}.toLowerCase()))` : 'collections'};
if (targetCols.length === 0) return 'No collections found';

// Skip semantic collections (they're aliases, colors already shown in primitives)
const filteredCols = targetCols.filter(c => !c.name.toLowerCase().includes('semantic'));
if (filteredCols.length === 0) return 'No color collections found (only semantic)';

let startX = 0;
figma.currentPage.children.forEach(n => {
  startX = Math.max(startX, n.x + (n.width || 0));
});
startX += 100;

let totalSwatches = 0;

// Common palette family names, in display order (only used for stable
// sorting when these names happen to exist — no palette is created here).
const colorOrder = ['slate','gray','zinc','neutral','stone','red','orange','amber','yellow','lime','green','emerald','teal','cyan','sky','blue','indigo','violet','purple','fuchsia','pink','rose','white','black'];

for (const col of filteredCols) {
  const colVars = colorVars.filter(v => v.variableCollectionId === col.id);
  if (colVars.length === 0) continue;

  // Group by prefix (handles both "blue/500" and semantic names)
  const groups = {};
  const semanticGroups = {
    'background': 'base', 'foreground': 'base', 'border': 'base', 'input': 'base', 'ring': 'base',
    'primary': 'primary', 'primary-foreground': 'primary',
    'secondary': 'secondary', 'secondary-foreground': 'secondary',
    'muted': 'muted', 'muted-foreground': 'muted',
    'accent': 'accent', 'accent-foreground': 'accent',
    'card': 'card', 'card-foreground': 'card',
    'popover': 'popover', 'popover-foreground': 'popover',
    'destructive': 'destructive', 'destructive-foreground': 'destructive',
    'chart-1': 'chart', 'chart-2': 'chart', 'chart-3': 'chart', 'chart-4': 'chart', 'chart-5': 'chart',
  };
  colVars.forEach(v => {
    const parts = v.name.split('/');
    let prefix;
    if (parts.length > 1) {
      prefix = parts[0];
    } else if (v.name.startsWith('sidebar-')) {
      prefix = 'sidebar';
    } else {
      prefix = semanticGroups[v.name] || 'other';
    }
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(v);
  });

  // Sort groups
  const semanticOrder = ['base','primary','secondary','muted','accent','card','popover','destructive','chart','sidebar'];
  const sortedGroups = Object.entries(groups).sort((a, b) => {
    const aColorIdx = colorOrder.indexOf(a[0]);
    const bColorIdx = colorOrder.indexOf(b[0]);
    const aSemanticIdx = semanticOrder.indexOf(a[0]);
    const bSemanticIdx = semanticOrder.indexOf(b[0]);
    if (aColorIdx !== -1 && bColorIdx !== -1) return aColorIdx - bColorIdx;
    if (aColorIdx !== -1) return -1;
    if (bColorIdx !== -1) return 1;
    if (aSemanticIdx !== -1 && bSemanticIdx !== -1) return aSemanticIdx - bSemanticIdx;
    return a[0].localeCompare(b[0]);
  });

  // Create container
  const container = figma.createFrame();
  container.name = col.name;
  container.x = startX;
  container.y = 0;
  container.layoutMode = 'VERTICAL';
  container.primaryAxisSizingMode = 'AUTO';
  container.counterAxisSizingMode = 'AUTO';
  container.itemSpacing = 8;
  container.paddingTop = 32;
  container.paddingBottom = 32;
  container.paddingLeft = 32;
  container.paddingRight = 32;
  container.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  container.cornerRadius = 16;

  // Title
  const title = figma.createText();
  title.characters = col.name;
  title.fontSize = 20;
  title.fontName = { family: 'Inter', style: 'Medium' };
  title.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
  container.appendChild(title);

  // Spacer
  const spacer = figma.createFrame();
  spacer.resize(1, 16);
  spacer.fills = [];
  container.appendChild(spacer);

  const modeId = col.modes[0].modeId;
  const swatchesToBind = [];

  for (const [groupName, vars] of sortedGroups) {
    // Row container with label
    const rowContainer = figma.createFrame();
    rowContainer.name = groupName;
    rowContainer.layoutMode = 'HORIZONTAL';
    rowContainer.primaryAxisSizingMode = 'AUTO';
    rowContainer.counterAxisSizingMode = 'AUTO';
    rowContainer.itemSpacing = 16;
    rowContainer.counterAxisAlignItems = 'CENTER';
    rowContainer.fills = [];
    container.appendChild(rowContainer);

    // Label
    const label = figma.createText();
    label.characters = groupName;
    label.fontSize = 13;
    label.fontName = { family: 'Inter', style: 'Medium' };
    label.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
    label.resize(80, label.height);
    label.textAlignHorizontal = 'RIGHT';
    rowContainer.appendChild(label);

    // Swatches row
    const swatchRow = figma.createFrame();
    swatchRow.layoutMode = 'HORIZONTAL';
    swatchRow.primaryAxisSizingMode = 'AUTO';
    swatchRow.counterAxisSizingMode = 'AUTO';
    swatchRow.itemSpacing = 0;
    swatchRow.fills = [];
    swatchRow.cornerRadius = 6;
    swatchRow.clipsContent = true;
    rowContainer.appendChild(swatchRow);

    // Sort shades
    vars.sort((a, b) => {
      const aNum = parseInt(a.name.split('/').pop()) || 0;
      const bNum = parseInt(b.name.split('/').pop()) || 0;
      return aNum - bNum;
    });

    for (const v of vars) {
      const swatch = figma.createFrame();
      swatch.name = v.name;
      swatch.resize(48, 32);
      swatch.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
      swatchRow.appendChild(swatch);
      swatchesToBind.push({ swatch, variable: v, modeId });
      totalSwatches++;
    }
  }

  // Bind after appending
  for (const { swatch, variable, modeId } of swatchesToBind) {
    try {
      let value = variable.valuesByMode[modeId];
      if (value && value.type === 'VARIABLE_ALIAS') {
        const resolved = await figma.variables.getVariableByIdAsync(value.id);
        if (resolved) value = resolved.valuesByMode[Object.keys(resolved.valuesByMode)[0]];
      }
      if (value && value.r !== undefined) {
        swatch.fills = [figma.variables.setBoundVariableForPaint(
          { type: 'SOLID', color: { r: value.r, g: value.g, b: value.b } }, 'color', variable
        )];
      }
    } catch (e) {}
  }

  startX += container.width + 60;
}

figma.viewport.scrollAndZoomIntoView(figma.currentPage.children.slice(-filteredCols.length));
return 'Created ' + totalSwatches + ' color swatches';
})()`;

    try {
      const result = await fastEval(code);
      spinnerSucceed(spinner, result || 'Created color palette');
    } catch (error) {
      spinner.fail('Failed to create palette');
      console.error(chalk.red(error.message));
      process.exitCode = 1;
    }
  });

variables
  .command('create-batch <json>')
  .description('Create multiple variables at once (faster than individual calls)')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .option('-m, --mode <mode>', 'Mode ID or name; defaults to the Collection default mode')
  .option('--allow-duplicate', 'Allow exact duplicate names intentionally')
  .allowExcessArguments(false)
  .action(async (json, options) => {
    try {
      const items = JSON.parse(json);
      const plan = planFigmaCommand(variableCreateBatchPlanningArgvFromRequest({
        items,
        collection: options.collection,
        mode: options.mode || null,
        allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableCreateBatchPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('delete <names...>')
  .description('Delete exact local Variables by id or name; use --collection to scope duplicate names')
  .option('-c, --collection <collection>', 'Scope exact names to one Collection id or name')
  .allowExcessArguments(false)
  .action(async (names, options) => {
    try {
      const plan = planFigmaCommand(variableDeletePlanningArgvFromRequest({
        names, collection: options.collection || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeVariableDeletePlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

variables
  .command('delete-all')
  .description('Disabled unsafe legacy bulk deletion; use exact var delete or col delete')
  .option('-c, --collection <name>', 'Only delete variables in this collection')
  .action(async () => {
    console.error(chalk.red('✗ var delete-all is disabled.'));
    console.error(chalk.gray('  Use var delete <exact names...> or col delete <exact collection>.'));
    process.exitCode = 1;
  });

// (The batch operations `delete-batch`, `bind-batch`, `set-batch` and
// `rename-batch` were removed. All four were registered TOP-LEVEL rather
// than under `variables`, so the allowlisted `var` alias never reached
// them — nothing could ever call them. `node delete <ids...>` and
// `node rename` cover the two that had no other home; the binding ones
// are listed for a proper rebuild in docu/FUNDLISTE-toter-code.md.)
