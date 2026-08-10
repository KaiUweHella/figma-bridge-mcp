// Commands: variables (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import {
  progress,
  program,
  checkConnection,
  daemonExec,
  fastEval,
  figmaEvalSync,
  evalPrint,
  listVariables,
  findVariables,
  handleEvalError,
  hexToRgb,
  spinnerSucceed
} from '../lib/cli-core.js';
import {
  parseBoolean, parseScopes, variableCodeSyntaxCode, variablePublishStatusCode,
  variableResolveCode, variableSetValueCode, variableShowCode, variableUpdateCode,
} from '../lib/variable-management.js';

// ============ VARIABLES ============

const variables = program
  .command('variables')
  .alias('var')
  .description('Manage design tokens/variables');

variables
  .command('list')
  .description('List all variables')
  .action(async () => {
    await checkConnection();
    listVariables();
  });

variables
  .command('create <name>')
  .description('Create a variable')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .requiredOption('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN')
  .option('-v, --value <value>', 'Initial value')
  .action(async (name, options) => {
    await checkConnection();
    const type = options.type.toUpperCase();
    const code = `(async () => {
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === ${JSON.stringify(options.collection)} || c.name === ${JSON.stringify(options.collection)});
if (!col) return 'Collection not found: ' + ${JSON.stringify(options.collection)};
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255
  } : null;
}

const v = figma.variables.createVariable(${JSON.stringify(name)}, col, ${JSON.stringify(type)});
${options.value ? `
let figmaValue = ${JSON.stringify(options.value)};
if (${JSON.stringify(type)} === 'COLOR') figmaValue = hexToRgb(${JSON.stringify(options.value)});
else if (${JSON.stringify(type)} === 'FLOAT') figmaValue = parseFloat(${JSON.stringify(options.value)});
else if (${JSON.stringify(type)} === 'BOOLEAN') figmaValue = ${JSON.stringify(options.value)} === 'true';
v.setValueForMode(modeId, figmaValue);
` : ''}
return 'Created ${type.toLowerCase()} variable: ${name}';
})()`;
    evalPrint(code);
  });

variables
  .command('find <pattern>')
  .description('Find variables by name pattern')
  .action(async (pattern) => {
    await checkConnection();
    findVariables(pattern);
  });

variables.command('show <variable>')
  .option('-c, --collection <collection>')
  .action(async (variable, options) => {
    try { await checkConnection(); console.log(JSON.stringify(await fastEval(variableShowCode({ variable, collection: options.collection })), null, 2)); }
    catch (error) { handleEvalError(error); }
  });

variables.command('update <variable>')
  .option('-c, --collection <collection>').option('-n, --name <name>')
  .option('-d, --description <text>').option('--hidden <boolean>').option('--scopes <list>', 'Comma-separated Figma variable scopes')
  .action(async (variable, options) => {
    try {
      if (options.name === undefined && options.description === undefined && options.hidden === undefined && options.scopes === undefined) throw new Error('Provide --name, --description, --hidden, or --scopes');
      const hidden = options.hidden === undefined ? undefined : parseBoolean(options.hidden, '--hidden');
      const scopes = options.scopes === undefined ? undefined : parseScopes(options.scopes);
      await checkConnection();
      console.log(JSON.stringify(await fastEval(variableUpdateCode({ variable, collection: options.collection, name: options.name, description: options.description, hidden, scopes })), null, 2));
    } catch (error) { handleEvalError(error); }
  });

variables.command('set-value <variable> [value]')
  .requiredOption('-m, --mode <mode>', 'Mode ID or name').option('-c, --collection <collection>')
  .option('--alias <variable>', 'Set a variable alias instead of a literal value')
  .action(async (variable, value, options) => {
    try {
      if (value === undefined && !options.alias) throw new Error('Provide a value or --alias');
      await checkConnection();
      console.log(JSON.stringify(await fastEval(variableSetValueCode({ variable, value, alias: options.alias, mode: options.mode, collection: options.collection })), null, 2));
    } catch (error) { handleEvalError(error); }
  });

variables.command('code-syntax <variable> <platform> [value]')
  .option('-c, --collection <collection>').option('--remove', 'Remove the platform definition')
  .action(async (variable, platform, value, options) => {
    try {
      if (!options.remove && value === undefined) throw new Error('Provide a syntax value or --remove');
      await checkConnection();
      console.log(JSON.stringify(await fastEval(variableCodeSyntaxCode({ variable, collection: options.collection, platform, value, remove: options.remove })), null, 2));
    } catch (error) { handleEvalError(error); }
  });

variables.command('resolve <variable> <nodeId>')
  .option('-c, --collection <collection>')
  .action(async (variable, nodeId, options) => {
    try { await checkConnection(); console.log(JSON.stringify(await fastEval(variableResolveCode({ variable, nodeId, collection: options.collection })), null, 2)); }
    catch (error) { handleEvalError(error); }
  });

variables.command('publish-status <variable>')
  .option('-c, --collection <collection>')
  .action(async (variable, options) => {
    try { await checkConnection(); console.log(JSON.stringify(await fastEval(variablePublishStatusCode({ variable, collection: options.collection })), null, 2)); }
    catch (error) { handleEvalError(error); }
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
    }
  });

variables
  .command('create-batch <json>')
  .description('Create multiple variables at once (faster than individual calls)')
  .requiredOption('-c, --collection <id>', 'Collection ID or name')
  .action(async (json, options) => {
    await checkConnection();
    let vars;
    try {
      vars = JSON.parse(json);
    } catch {
      console.log(chalk.red('Invalid JSON. Expected: [{"name": "color/red", "type": "COLOR", "value": "#ff0000"}, ...]'));
      return;
    }
    if (!Array.isArray(vars)) {
      console.log(chalk.red('Expected JSON array'));
      return;
    }

    const code = `(async () => {
const vars = ${JSON.stringify(vars)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.id === ${JSON.stringify(options.collection)} || c.name === ${JSON.stringify(options.collection)});
if (!col) return 'Collection not found: ' + ${JSON.stringify(options.collection)};
const modeId = col.modes[0].modeId;

function hexToRgb(hex) {
  const result = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16) / 255, g: parseInt(result[2], 16) / 255, b: parseInt(result[3], 16) / 255 } : null;
}

let created = 0;
for (const v of vars) {
  const type = (v.type || 'COLOR').toUpperCase();
  const variable = figma.variables.createVariable(v.name, col, type);
  if (v.value !== undefined) {
    let figmaValue = v.value;
    if (type === 'COLOR') figmaValue = hexToRgb(v.value);
    else if (type === 'FLOAT') figmaValue = parseFloat(v.value);
    else if (type === 'BOOLEAN') figmaValue = v.value === true || v.value === 'true';
    variable.setValueForMode(modeId, figmaValue);
  }
  created++;
}
return 'Created ' + created + ' variables';
})()`;

    const result = figmaEvalSync(code);
    console.log(chalk.green(result || `✓ Created ${vars.length} variables`));
  });

variables
  .command('delete <names...>')
  .description('Delete specific variables by exact name (e.g. "space/7px"). Safer counterpart to delete-all.')
  .action(async (names) => {
    await checkConnection();
    const code = `(async () => {
const want = ${JSON.stringify(names)};
const vars = await figma.variables.getLocalVariablesAsync();
const deleted = [], missing = [];
for (const name of want) {
  const v = vars.find(x => x.name === name);
  if (!v) { missing.push(name); continue; }
  try { v.remove(); deleted.push(name); }
  catch (e) { missing.push(name + ' (' + e.message + ')'); }
}
return { deleted, missing };
})()`;
    const result = figmaEvalSync(code);
    if (result.deleted?.length) console.log(chalk.green('✓'), `Deleted: ${result.deleted.join(', ')}`);
    if (result.missing?.length) console.log(chalk.yellow('⚠'), `Not deleted: ${result.missing.join(', ')}`);
  });

variables
  .command('delete-all')
  .description('Delete all local variables and collections')
  .option('-c, --collection <name>', 'Only delete variables in this collection')
  .action(async (options) => {
    await checkConnection();
    const spinner = progress('Deleting variables...').start();

    const filterCode = options.collection
      ? `cols = cols.filter(c => c.name.includes(${JSON.stringify(options.collection)}));`
      : '';

    const code = `(async () => {
let cols = await figma.variables.getLocalVariableCollectionsAsync();
${filterCode}
let deleted = 0;
for (const col of cols) {
  const vars = await figma.variables.getLocalVariablesAsync();
  const colVars = vars.filter(v => v.variableCollectionId === col.id);
  for (const v of colVars) {
    v.remove();
    deleted++;
  }
  col.remove();
}
return 'Deleted ' + deleted + ' variables and ' + cols.length + ' collections';
})()`;

    try {
      const result = figmaEvalSync(code);
      spinnerSucceed(spinner, result);
    } catch (error) {
      spinner.fail('Failed to delete variables');
      console.error(chalk.red(error.message));
    }
  });

// (The batch operations `delete-batch`, `bind-batch`, `set-batch` and
// `rename-batch` were removed. All four were registered TOP-LEVEL rather
// than under `variables`, so the allowlisted `var` alias never reached
// them — nothing could ever call them. `node delete <ids...>` and
// `node rename` cover the two that had no other home; the binding ones
// are listed for a proper rebuild in docu/FUNDLISTE-toter-code.md.)
