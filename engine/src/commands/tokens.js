// Commands: tokens (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  program,
  checkConnection,
  daemonExec,
  fastEval,
  evalPrint,
  listCollections,
  createCollection,
  handleEvalError,
  hexToRgb,
  spinnerSucceed
} from '../lib/cli-core.js';

// ============ COLLECTIONS ============

const collections = program
  .command('collections')
  .alias('col')
  .description('Manage variable collections');

collections
  .command('list')
  .description('List all collections')
  .action(async () => {
    await checkConnection();
    listCollections();
  });

collections
  .command('create <name>')
  .description('Create a collection')
  .action(async (name) => {
    await checkConnection();
    createCollection(name);
  });

// ============ TOKENS (PRESETS) ============

const tokens = program
  .command('tokens')
  .description('Create design token presets');

// NOTE: there are deliberately NO third-party design-system presets here —
// no tailwind/shadcn/radix/material palettes, no branded starter kits. This
// tool ships neutral scales only (spacing, radii); bring your own system via
// `tokens import`, `tokens import-design-md` or
// `figma-cli import <tailwind.config|css|tokens|storybook>`.

tokens
  .command('spacing')
  .description('Create spacing scale (4px base)')
  .option('-c, --collection <name>', 'Collection name', 'Spacing')
  .action(async (options) => {
    await checkConnection();
    const spinner = ora('Creating spacing scale...').start();

    const spacings = {
      '0': 0, '0.5': 2, '1': 4, '1.5': 6, '2': 8, '2.5': 10,
      '3': 12, '3.5': 14, '4': 16, '5': 20, '6': 24, '7': 28,
      '8': 32, '9': 36, '10': 40, '11': 44, '12': 48,
      '14': 56, '16': 64, '20': 80, '24': 96, '28': 112,
      '32': 128, '36': 144, '40': 160, '44': 176, '48': 192
    };

    const code = `(async () => {
const spacings = ${JSON.stringify(spacings)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(spacings)) {
  const existing = existingVars.find(v => v.name === 'spacing/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('spacing/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' spacing variables';
})()`;

    try {
      const result = evalPrint(code, { silent: true });
      spinnerSucceed(spinner, result?.trim() || 'Created spacing scale');
    } catch (error) {
      spinner.fail('Failed to create spacing scale');
    }
  });

tokens
  .command('radii')
  .description('Create border radius scale')
  .option('-c, --collection <name>', 'Collection name', 'Radii')
  .action(async (options) => {
    await checkConnection();
    const spinner = ora('Creating border radii...').start();

    const radii = {
      'none': 0, 'sm': 2, 'default': 4, 'md': 6, 'lg': 8,
      'xl': 12, '2xl': 16, '3xl': 24, 'full': 9999
    };

    const code = `(async () => {
const radii = ${JSON.stringify(radii)};
const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;
const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;
for (const [name, value] of Object.entries(radii)) {
  const existing = existingVars.find(v => v.name === 'radius/' + name);
  if (!existing) {
    const v = figma.variables.createVariable('radius/' + name, col, 'FLOAT');
    v.setValueForMode(modeId, value);
    count++;
  }
}
return 'Created ' + count + ' radius variables';
})()
`;

    try {
      const result = evalPrint(code, { silent: true });
      spinnerSucceed(spinner, result?.trim() || 'Created border radii');
    } catch (error) {
      spinner.fail('Failed to create radii');
    }
  });

tokens
  .command('import <file>')
  .description('Import tokens from JSON file')
  .option('-c, --collection <name>', 'Collection name')
  .option('--force-slash', 'Allow "/" in --collection (bypasses the LLM-mistake guard)')
  .action(async (file, options) => {
    await checkConnection();
    // Guard against LLM-style mistakes: a "/" in the collection name almost
    // always means the caller split one DESIGN.md across multiple `tokens
    // import` runs (e.g. -c "stripe/colors", -c "stripe/radius"). Figma
    // treats "/" as a normal character — it does NOT nest collections — so
    // the result is fake siblings, not a hierarchy.
    if (options.collection && options.collection.includes('/')) {
      console.error(chalk.yellow(`⚠ Collection name "${options.collection}" contains "/".`));
      console.error(chalk.yellow('  Figma does not nest collections. "/" creates flat sibling collections.'));
      console.error(chalk.gray('  If this is a DESIGN.md file, use `figma-cli import <path>` instead — it imports the whole system into one collection atomically.'));
      console.error(chalk.gray('  To proceed anyway, re-run with --force-slash.'));
      if (!options.forceSlash) process.exit(1);
    }

    // Read JSON file
    let tokensData;
    try {
      const content = readFileSync(file, 'utf8');
      tokensData = JSON.parse(content);
    } catch (error) {
      console.log(chalk.red(`✗ Could not read file: ${file}`));
      process.exit(1);
    }

    const spinner = ora('Importing tokens...').start();

    // Detect format and convert
    // Support: { "colors": { "primary": "#xxx" } } or { "primary": { "value": "#xxx", "type": "color" } }
    const collectionName = options.collection || 'Imported Tokens';

    const code = `(async () => {
const data = ${JSON.stringify(tokensData)};
const collectionName = ${JSON.stringify(collectionName)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

function detectType(value) {
  if (typeof value === 'string' && value.startsWith('#')) return 'COLOR';
  if (typeof value === 'number') return 'FLOAT';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'STRING';
}

function flattenTokens(obj, prefix = '') {
  const result = [];
  for (const [key, val] of Object.entries(obj)) {
    const name = prefix ? prefix + '/' + key : key;
    if (val && typeof val === 'object' && !val.value && !val.type) {
      result.push(...flattenTokens(val, name));
    } else {
      const value = val?.value ?? val;
      const type = val?.type?.toUpperCase() || detectType(value);
      result.push({ name, value, type });
    }
  }
  return result;
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
const tokens = flattenTokens(data);
let count = 0;

for (const { name, value, type } of tokens) {
  // Scoped to the target collection — overlapping names across collections OK
  const existing = existingVars.find(v => v.name === name && v.variableCollectionId === col.id);
  if (!existing) {
    try {
      const figmaType = type === 'COLOR' ? 'COLOR' : type === 'FLOAT' || type === 'NUMBER' ? 'FLOAT' : type === 'BOOLEAN' ? 'BOOLEAN' : 'STRING';
      const v = figma.variables.createVariable(name, col, figmaType);
      let figmaValue = value;
      if (figmaType === 'COLOR') figmaValue = hexToRgb(value);
      if (figmaValue !== null) {
        v.setValueForMode(modeId, figmaValue);
        count++;
      }
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = evalPrint(code, { silent: true });
      spinnerSucceed(spinner, result?.trim() || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
    }
  });

tokens
  .command('overlap <collections...>')
  .description('Compare token names across N local variable collections. Shows common core (switchable subset) + per-collection unique names. Useful before `figma-cli use` to know which tokens swap cleanly.')
  .option('--json', 'Output as JSON')
  .action(async (collectionNames, options) => {
    await checkConnection();
    if (collectionNames.length < 2) {
      console.error(chalk.red('✗'), 'Pass at least two collection names. Example: figma-cli tokens overlap airbnb cursor stripe');
      process.exit(1);
    }
    const code = `(async () => {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      const allVars = await figma.variables.getLocalVariablesAsync();
      const targets = ${JSON.stringify(collectionNames)};
      const resolved = [];
      const missing = [];
      for (const q of targets) {
        const ql = q.toLowerCase();
        const c = cols.find(c => c.name.toLowerCase() === ql)
              || cols.find(c => c.name.toLowerCase().includes(ql));
        if (!c) { missing.push(q); continue; }
        const names = new Set(allVars.filter(v => v.variableCollectionId === c.id).map(v => v.name));
        resolved.push({ query: q, name: c.name, names: [...names] });
      }
      if (missing.length) {
        return { error: 'collections not found: ' + missing.join(', '),
                 available: cols.map(c => c.name) };
      }
      // Intersection: names present in EVERY resolved collection
      const sets = resolved.map(r => new Set(r.names));
      const intersection = [...sets[0]].filter(n => sets.every(s => s.has(n))).sort();
      // Per-collection: unique to this collection (in this set, not in any other)
      const unique = resolved.map((r, i) => ({
        collection: r.name,
        total: r.names.length,
        only_here: r.names.filter(n => resolved.every((r2, j) => i === j || !sets[j].has(n))).sort(),
        missing_here: [...intersection.length > 0 ? new Set() : new Set()].sort(),
      }));
      // For each collection, also compute "missing here that others have"
      const allNames = new Set();
      for (const r of resolved) for (const n of r.names) allNames.add(n);
      for (let i = 0; i < unique.length; i++) {
        const have = sets[i];
        unique[i].missing_here = [...allNames].filter(n => !have.has(n)).sort();
      }
      return { collections: resolved.map(r => r.name), commonCore: intersection, perCollection: unique };
    })()`;
    try {
      const r = await daemonExec('eval', { code });
      if (r.error) {
        console.error(chalk.red('✗'), r.error);
        console.error(chalk.gray('  Available: ' + (r.available || []).join(', ')));
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log();
      console.log(chalk.cyan(`Comparing ${r.collections.length} collections: ${r.collections.join(', ')}`));
      console.log();
      console.log(chalk.green(`✓ Common core — ${r.commonCore.length} tokens (switch cleanly across all):`));
      if (r.commonCore.length === 0) {
        console.log(chalk.gray('  (none — no shared token names)'));
      } else {
        console.log('  ' + r.commonCore.join(', '));
      }
      console.log();
      for (const c of r.perCollection) {
        console.log(chalk.cyan(`${c.collection}`) + chalk.gray(` (${c.total} tokens)`));
        if (c.only_here.length > 0) {
          console.log(chalk.yellow(`  only here (${c.only_here.length}):`));
          console.log('    ' + c.only_here.join(', '));
        }
        if (c.missing_here.length > 0) {
          console.log(chalk.gray(`  missing here (${c.missing_here.length}) — won't switch INTO this collection:`));
          console.log(chalk.gray('    ' + c.missing_here.join(', ')));
        }
        console.log();
      }
      console.log(chalk.gray('Tip: design with the common-core tokens for cleanest theme switching.'));
    } catch (e) {
      handleEvalError(e);
    }
  });

tokens
  .command('import-design-md <file>')
  .description('Import tokens from a DESIGN.md (Figma extraction format with `## 11. Machine-readable tokens` JSON block). Creates color, radius, and typography variables. Also prints a compact context summary for the agent.')
  .option('-c, --collection <name>', 'Collection name (defaults to the design system name)')
  .option('--print-context', 'Just print the agent context summary, do not create variables')
  .action(async (file, options) => {
    let parsed;
    try {
      const { parseDesignMd } = await import('../design-md.js');
      parsed = parseDesignMd(file);
    } catch (e) {
      console.error(chalk.red('✗'), e.message);
      process.exit(1);
    }

    if (options.printContext) {
      const { summarizeForLLM } = await import('../design-md.js');
      console.log(summarizeForLLM(parsed));
      return;
    }

    await checkConnection();
    const { toTokensImportJson, summarizeForLLM, variableImportCode } = await import('../design-md.js');

    // Authoritative path: the file carries real variable collections (from
    // `figma-cli extract`). Recreate them faithfully — names, modes, alias
    // chains — instead of the lossy single-mode palette derived from fills.
    const realVars = parsed.tokens.variables;
    if (realVars && Object.keys(realVars).length) {
      const collNames = Object.keys(realVars);
      const totalVars = collNames.reduce((a, n) => a + Object.keys(realVars[n].variables || {}).length, 0);
      if (options.collection) {
        console.log(chalk.yellow('⚠'), `--collection is ignored: this file carries ${collNames.length} named collection(s); using their real names.`);
      }
      const spinner = ora(`Recreating ${totalVars} variable(s) across ${collNames.length} collection(s)…`).start();
      try {
        const result = await daemonExec('eval', { code: variableImportCode(realVars) });
        const r = typeof result === 'string' ? (() => { try { return JSON.parse(result); } catch { return null; } })() : result;
        if (r) {
          spinnerSucceed(spinner, `Created ${r.createdCount} variable(s), wired ${r.aliasCount} alias(es) across ${r.collections} collection(s)`);
          if (r.unresolved) console.log(chalk.yellow(`  ⚠ ${r.unresolved} alias value(s) unresolved (target outside this file / type mismatch)`));
        } else {
          spinnerSucceed(spinner, 'Variables imported');
        }
      } catch (error) {
        spinner.fail('Failed to import variable collections');
        console.error(error.message);
        process.exit(1);
      }
      console.log();
      console.log(chalk.cyan('─── agent context summary ───────────'));
      console.log(summarizeForLLM(parsed));
      console.log(chalk.cyan('──────────────────────────────────────────────'));
      return;
    }

    const tokensData = toTokensImportJson(parsed);
    const collectionName = options.collection || parsed.meta.source || 'Imported Design System';
    const colorCount = Object.keys(tokensData.color || {}).length;
    const radiusCount = Object.keys(tokensData.radius || {}).length;
    const typoCount = Object.keys(tokensData.typography || {}).length;

    const spinner = ora(`Importing ${colorCount} colors, ${radiusCount} radii, ${typoCount} type styles from ${file}...`).start();

    const code = `(async () => {
const data = ${JSON.stringify({ ...tokensData.color, _radii: tokensData.radius })};
const collectionName = ${JSON.stringify(collectionName)};

function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === collectionName);
if (!col) col = figma.variables.createVariableCollection(collectionName);
const modeId = col.modes[0].modeId;

const existingVars = await figma.variables.getLocalVariablesAsync();
let count = 0;

// Colors. Skip-check scoped to the TARGET collection so multiple design
// systems can coexist with overlapping token names (Airbnb's primary AND
// Cursor's primary, switchable via "Apply variable mode" in Figma).
for (const [name, entry] of Object.entries(data)) {
  if (name === '_radii') continue;
  const value = entry?.value ?? entry;
  const rgb = typeof value === 'string' ? hexToRgb(value) : null;
  if (!rgb) continue;
  if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
  try {
    const v = figma.variables.createVariable(name, col, 'COLOR');
    v.setValueForMode(modeId, rgb);
    count++;
  } catch (e) {}
}
// Radii
if (data._radii) {
  for (const [name, entry] of Object.entries(data._radii)) {
    const num = typeof entry === 'object' ? entry.value : entry;
    if (typeof num !== 'number') continue;
    if (existingVars.find(v => v.name === name && v.variableCollectionId === col.id)) continue;
    try {
      const v = figma.variables.createVariable(name, col, 'FLOAT');
      v.setValueForMode(modeId, num);
      count++;
    } catch (e) {}
  }
}

return 'Imported ' + count + ' tokens into ' + collectionName;
})()`;

    try {
      const result = await daemonExec('eval', { code });
      spinnerSucceed(spinner, result || 'Tokens imported');
    } catch (error) {
      spinner.fail('Failed to import tokens');
      console.error(error.message);
      process.exit(1);
    }

    console.log();
    console.log(chalk.cyan('─── agent context summary ───────────'));
    console.log(summarizeForLLM(parsed));
    console.log(chalk.cyan('──────────────────────────────────────────────'));
  });

tokens
  .command('add <name> <value>')
  .description('Add a single token')
  .option('-c, --collection <name>', 'Collection name', 'Tokens')
  .option('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN (auto-detected if not set)')
  .action(async (name, value, options) => {
    await checkConnection();

    const code = `(async () => {
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  if (!r) return null;
  return { r: parseInt(r[1], 16) / 255, g: parseInt(r[2], 16) / 255, b: parseInt(r[3], 16) / 255 };
}

const value = ${JSON.stringify(value)};
let type = '${options.type || ''}';
if (!type) {
  if (value.startsWith('#')) type = 'COLOR';
  else if (!isNaN(parseFloat(value))) type = 'FLOAT';
  else if (value === 'true' || value === 'false') type = 'BOOLEAN';
  else type = 'STRING';
}

const cols = await figma.variables.getLocalVariableCollectionsAsync();
let col = cols.find(c => c.name === ${JSON.stringify(options.collection)});
if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(options.collection)});
const modeId = col.modes[0].modeId;

const v = figma.variables.createVariable(${JSON.stringify(name)}, col, type);
let figmaValue = value;
if (type === 'COLOR') figmaValue = hexToRgb(value);
else if (type === 'FLOAT') figmaValue = parseFloat(value);
else if (type === 'BOOLEAN') figmaValue = value === 'true';
v.setValueForMode(modeId, figmaValue);

return 'Created ' + type.toLowerCase() + ' token: ${name}';
})()`;

    try {
      const result = evalPrint(code, { silent: true });
      console.log(chalk.green(result?.trim() || `✓ Created token: ${name}`));
    } catch (error) {
      console.log(chalk.red(`✗ Failed to create token: ${name}`));
    }
  });

