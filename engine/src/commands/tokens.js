// Commands: tokens (extracted from index.js)
import chalk from 'chalk';
import { existsSync } from 'fs';
import { join, resolve as resolvePath, dirname } from 'path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  collectionCatalogPlanningArgvFromRequest,
  executeCollectionCatalogPlan,
} from '../application/collection-catalog-command.js';
import {
  collectionFactsArgvFromRequest,
  executeCollectionFactsPlan,
} from '../application/collection-facts-command.js';
import {
  collectionCreatePlanningArgvFromRequest,
  executeCollectionCreatePlan,
} from '../application/collection-create-command.js';
import {
  collectionUpdatePlanningArgvFromRequest,
  executeCollectionUpdatePlan,
} from '../application/collection-update-command.js';
import {
  collectionModePlanningArgvFromRequest,
  executeCollectionModePlan,
} from '../application/collection-mode-command.js';
import {
  collectionDeletePlanningArgvFromRequest,
  executeCollectionDeletePlan,
} from '../application/collection-delete-command.js';
import {
  collectionExtendPlanningArgvFromRequest,
  executeCollectionExtendPlan,
} from '../application/collection-extend-command.js';
import {
  executeTokenPublishStatusPlan,
  tokenPublishStatusPlanningArgvFromRequest,
} from '../application/token-publish-status-command.js';
import {
  executeTokenPresetPlan,
  tokenPresetPlanningArgvFromRequest,
} from '../application/token-preset-command.js';
import {
  executeTokenAddPlan,
  tokenAddPlanningArgvFromRequest,
} from '../application/token-add-command.js';
import {
  executeTokenOverlapPlan,
  tokenOverlapPlanningArgvFromRequest,
} from '../application/token-overlap-command.js';
import {
  executeTokenRebindPlan,
  tokenRebindPlanningArgvFromRequest,
} from '../application/token-rebind-command.js';
import {
  executeTokenImportPlan,
  prepareTokenImportPlan,
  tokenImportPlanningArgvFromRequest,
} from '../application/token-import-command.js';
import {
  designMdPlanningArgvFromRequest,
  executeDesignMdContextPlan,
} from '../application/design-md-context-command.js';
import {
  executeDesignMdImportPlan,
  prepareDesignMdImportPlan,
} from '../application/design-md-import-command.js';
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
import {
  LOCKFILE_NAME,
  parseTokenFile,
  parseLock,
  buildLock,
  planSync,
  planTouchesFigma,
  formatPlan,
  resolveConflicts,
  canonicalValue,
  hexToFigmaRgb,
} from '../lib/token-sync.js';
import { variableScopePolicyCode, variableScopeQuestions } from '../lib/variable-scope-policy.js';
import { workspaceIO } from '../lib/workspace-io.js';

// ============ COLLECTIONS ============

const collections = program
  .command('col')
  .alias('collections')
  .description('Manage variable collections');

collections
  .command('list')
  .description('List all collections')
  .option('-l, --limit <count>', 'Maximum collections returned')
  .option('--json', 'Return bounded identity facts as JSON')
  .allowExcessArguments(false)
  .action(async (options) => {
    try {
      const plan = planFigmaCommand(collectionCatalogPlanningArgvFromRequest({
        limit: options.limit || null,
        json: options.json === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionCatalogPlan(plan, {
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

collections
  .command('create <name>')
  .description('Create a collection')
  .option('--allow-duplicate', 'Intentionally allow an exact duplicate name')
  .allowExcessArguments(false)
  .action(async (name, options) => {
    try {
      const plan = planFigmaCommand(collectionCreatePlanningArgvFromRequest({
        name, allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionCreatePlan(plan, {
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

collections.command('show <collection>')
  .allowExcessArguments(false)
  .action(async (collection) => {
    try {
      const plan = planFigmaCommand(collectionFactsArgvFromRequest({ collection }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionFactsPlan(plan, {
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

collections.command('update <collection>')
  .option('-n, --name <name>').option('--hidden <boolean>')
  .allowExcessArguments(false)
  .action(async (collection, options) => {
    try {
      const plan = planFigmaCommand(collectionUpdatePlanningArgvFromRequest({
        collection,
        name: options.name,
        hidden: options.hidden,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionUpdatePlan(plan, {
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

async function runCollectionMode(request) {
  try {
    const plan = planFigmaCommand(collectionModePlanningArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeCollectionModePlan(plan, {
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

collections.command('mode-add <collection> <name>')
  .allowExcessArguments(false)
  .action(async (collection, name) => runCollectionMode({ action: 'add', collection, name }));
collections.command('mode-rename <collection> <mode> <name>')
  .allowExcessArguments(false)
  .action(async (collection, mode, name) => runCollectionMode({
    action: 'rename', collection, mode, name,
  }));
collections.command('mode-remove <collection> <mode>')
  .allowExcessArguments(false)
  .action(async (collection, mode) => runCollectionMode({ action: 'remove', collection, mode }));
collections.command('publish-status <collection>')
  .allowExcessArguments(false)
  .action(async (collection) => {
    try {
      const plan = planFigmaCommand(tokenPublishStatusPlanningArgvFromRequest({
        kind: 'collection', query: collection,
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
collections.command('delete <collection>')
  .description('Delete one explicit local collection and its variables')
  .allowExcessArguments(false)
  .action(async (collection) => {
    try {
      const plan = planFigmaCommand(collectionDeletePlanningArgvFromRequest({ collection }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionDeletePlan(plan, {
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
collections.command('extend <collection> <name>')
  .description('Create an Enterprise collection extension from a local collection or published collection key')
  .allowExcessArguments(false)
  .action(async (collection, name) => {
    try {
      const plan = planFigmaCommand(collectionExtendPlanningArgvFromRequest({ collection, name }), {
        adapter: 'cli', fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeCollectionExtendPlan(plan, {
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

// ============ TOKENS (PRESETS) ============

const tokens = program
  .command('tokens')
  .description('Create design token presets');

function printVariableScopeQuestions(questions) {
  if (!questions?.length) return;
  console.log(chalk.yellow(`\n⚠ SCOPE DECISION REQUIRED for ${questions.length} new variable(s).`));
  console.log(chalk.yellow('  Ask the user before choosing a narrower Figma scope; do not infer it from an ambiguous name.'));
  for (const item of questions) {
    console.log(chalk.gray(`  - ${item.collection ? item.collection + '/' : ''}${item.name} (${item.resolvedType})`));
    console.log(chalk.gray(`    compatible: ${item.allowedScopes.join(', ')}`));
  }
  console.log(chalk.gray('  Scope reference: figma_reference {name:"variable-scopes"}'));
}

// NOTE: there are deliberately NO third-party design-system presets here —
// no tailwind/shadcn/radix/material palettes, no branded starter kits. This
// tool ships neutral scales only (spacing, radii); bring your own system via
// `tokens import`, `tokens import-design-md` or
// `import <tailwind.config|css|tokens|storybook>`.

async function runTokenPreset(preset, collection) {
  try {
    const plan = planFigmaCommand(tokenPresetPlanningArgvFromRequest({ preset, collection }), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeTokenPresetPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code,
            ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    console.log(result.stdout);
    if (result.stderr) console.error(chalk.yellow(result.stderr));
  } catch (error) {
    handleEvalError(error);
    process.exitCode = 1;
  }
}

tokens.command('spacing')
  .description('Create spacing scale (4px base)')
  .option('-c, --collection <name>', 'Collection name', 'Spacing')
  .allowExcessArguments(false)
  .action(async (options) => runTokenPreset('spacing', options.collection));

tokens.command('radii')
  .description('Create border radius scale')
  .option('-c, --collection <name>', 'Collection name', 'Radii')
  .allowExcessArguments(false)
  .action(async (options) => runTokenPreset('radii', options.collection));

tokens
  .command('import <file>')
  .description('Import tokens from JSON file')
  .option('-c, --collection <name>', 'Collection name')
  .option('--force-slash', 'Allow "/" in --collection (bypasses the LLM-mistake guard)')
  .allowExcessArguments(false)
  .action(async (file, options) => {
    try {
      const plan = planFigmaCommand(tokenImportPlanningArgvFromRequest({
        file, collection: options.collection || 'Imported Tokens',
        forceSlash: options.forceSlash === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      // Workspace authority and the complete source preflight happen before
      // any Plugin connection or design write is requested.
      const prepared = prepareTokenImportPlan(plan, { workspaceIO: workspaceIO() });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenImportPlan(plan, prepared, {
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(chalk.green(result.stdout));
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

// ============ SYNC (two-way, lockfile-mediated) ============
//
// `tokens import` only ever creates: a value edited in code never reaches an
// existing Figma variable, and a value edited in Figma never reaches code.
// `tokens sync` closes the loop, and refuses to guess when both sides moved.
// See lib/token-sync.js for the decision table — this command only supplies
// the three inputs and applies the resulting plan.

/** Read the collection's variables out of Figma in the sync shape. */
async function readFigmaTokens(collectionName) {
  const code = `(async () => {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col = cols.find(c => c.name === ${JSON.stringify(collectionName)});
  if (!col) return { missing: true };
  const modeId = col.modes[0].modeId;
  const vars = await figma.variables.getLocalVariablesAsync();
  const out = [];
  // Names that live in OTHER collections. export dtcg flattens every local
  // variable into one file, while sync targets a single collection — so the
  // obvious round-trip (export, then sync) otherwise reports "create
  // everything" and would duplicate a whole design system into the wrong place.
  const elsewhere = {};
  for (const v of vars) {
    if (v.variableCollectionId !== col.id) {
      const owner = cols.find(c => c.id === v.variableCollectionId);
      if (owner) (elsewhere[v.name] = owner.name);
      continue;
    }
    const value = v.valuesByMode[modeId];
    // An alias points at another variable rather than holding a value; there
    // is no scalar to compare, so it is surfaced instead of silently synced.
    if (value && typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
      out.push({ name: v.name, id: v.id, type: v.resolvedType, alias: true });
      continue;
    }
    out.push({
      name: v.name,
      id: v.id,
      type: v.resolvedType,
      value,
      scopes: Array.isArray(v.scopes) ? Array.from(v.scopes) : [],
      codeSyntax: v.codeSyntax && typeof v.codeSyntax === 'object' ? v.codeSyntax : {},
    });
  }
  return { collectionId: col.id, modeId, modes: col.modes.length, variables: out, elsewhere };
})()`;
  return fastEval(code);
}

/** Apply a plan. Returns the per-operation counts Figma actually performed. */
async function applyPlan(plan, collectionName) {
  const ops = {
    create: plan.create.map((t) => ({ name: t.name, type: t.type, value: encodeForFigma(t),
      ...(Object.hasOwn(t, 'scopes') ? { scopes: t.scopes } : {}),
      ...(Object.hasOwn(t, 'codeSyntax') ? { codeSyntax: t.codeSyntax } : {}) })),
    // Figma variables cannot change resolvedType in place, so a type change is
    // a delete-and-recreate. It is listed separately because it DOES drop the
    // bindings pointing at that variable — the report warns about it.
    update: plan.update.filter((t) => !t.typeChange)
      .map((t) => ({ id: t.id, name: t.name, type: t.type, value: encodeForFigma(t),
        ...(Object.hasOwn(t, 'scopes') ? { scopes: t.scopes } : {}),
        ...(Object.hasOwn(t, 'codeSyntax') ? { codeSyntax: t.codeSyntax } : {}) })),
    retype: plan.update.filter((t) => t.typeChange)
      .map((t) => ({ id: t.id, name: t.name, type: t.type, value: encodeForFigma(t),
        ...(Object.hasOwn(t, 'scopes') ? { scopes: t.scopes } : {}),
        ...(Object.hasOwn(t, 'codeSyntax') ? { codeSyntax: t.codeSyntax } : {}) })),
    rename: plan.rename.map((t) => ({ id: t.id, name: t.name })),
    remove: plan.delete.filter((d) => d.willDelete).map((d) => ({ id: d.id, name: d.name })),
  };

  const code = `(async () => {
  const ops = ${JSON.stringify(ops)};
  ${variableScopePolicyCode()}
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  let col = cols.find(c => c.name === ${JSON.stringify(collectionName)});
  if (!col) col = figma.variables.createVariableCollection(${JSON.stringify(collectionName)});
  const modeId = col.modes[0].modeId;
  const done = { created: 0, updated: 0, retyped: 0, renamed: 0, deleted: 0 };
  const failed = [];

  const byId = new Map();
  for (const v of await figma.variables.getLocalVariablesAsync()) byId.set(v.id, v);
  const applyMetadata = (v, op) => {
    if ('scopes' in op) v.scopes = op.scopes;
    if ('codeSyntax' in op && typeof v.setVariableCodeSyntax === 'function') {
      const current = v.codeSyntax && typeof v.codeSyntax === 'object' ? v.codeSyntax : {};
      if (typeof v.removeVariableCodeSyntax === 'function') {
        for (const platform of Object.keys(current)) {
          if (!(platform in op.codeSyntax)) v.removeVariableCodeSyntax(platform);
        }
      }
      for (const platform of Object.keys(op.codeSyntax)) v.setVariableCodeSyntax(platform, op.codeSyntax[platform]);
    }
  };

  for (const op of ops.rename) {
    try { const v = byId.get(op.id); if (v) { v.name = op.name; done.renamed++; } }
    catch (e) { failed.push(op.name + ': rename failed — ' + e.message); }
  }
  for (const op of ops.update) {
    try { const v = byId.get(op.id); if (v) { v.setValueForMode(modeId, op.value); applyMetadata(v, op); done.updated++; } }
    catch (e) { failed.push(op.name + ': update failed — ' + e.message); }
  }
  for (const op of ops.retype) {
    try {
      const old = byId.get(op.id);
      if (old) old.remove();
      const v = figma.variables.createVariable(op.name, col, op.type);
      if (!('scopes' in op)) __scopeTokenVariable(v, op.name, op.type);
      v.setValueForMode(modeId, op.value);
      applyMetadata(v, op);
      done.retyped++;
    } catch (e) { failed.push(op.name + ': retype failed — ' + e.message); }
  }
  for (const op of ops.create) {
    try {
      const v = figma.variables.createVariable(op.name, col, op.type);
      if (!('scopes' in op)) __scopeTokenVariable(v, op.name, op.type);
      v.setValueForMode(modeId, op.value);
      applyMetadata(v, op);
      done.created++;
    } catch (e) { failed.push(op.name + ': create failed — ' + e.message); }
  }
  for (const op of ops.remove) {
    try { const v = byId.get(op.id); if (v) { v.remove(); done.deleted++; } }
    catch (e) { failed.push(op.name + ': delete failed — ' + e.message); }
  }
  return { done, failed };
})()`;
  return fastEval(code);
}

/** Token value in the form Figma's setValueForMode expects. */
function encodeForFigma(token) {
  if (token.type === 'COLOR') return hexToFigmaRgb(token.value);
  if (token.type === 'FLOAT') return Number(canonicalValue('FLOAT', token.value));
  if (token.type === 'BOOLEAN') return canonicalValue('BOOLEAN', token.value);
  return String(token.value ?? '');
}

tokens
  .command('sync <file>')
  .description('Two-way sync between a token file (DTCG JSON or CSS variables) and a Figma collection')
  .option('-c, --collection <name>', 'Figma collection to sync with', 'Design Tokens')
  .option('--apply', 'Actually write to Figma (default: show the plan only)')
  .option('--prune', 'Also delete Figma variables that sync created and code no longer has')
  .option('--ours', 'Resolve every conflict in favour of the code file')
  .option('--theirs', 'Resolve every conflict in favour of Figma (writes nothing to Figma)')
  .option('--lockfile <path>', `Lockfile path (default: ${LOCKFILE_NAME} beside the token file)`)
  .action(async (file, options) => {
    await checkConnection();

    if (options.ours && options.theirs) {
      console.error(chalk.red('✗ --ours and --theirs are mutually exclusive.'));
      process.exitCode = 1;
      return;
    }

    const filePath = resolvePath(file);
    if (!existsSync(filePath)) {
      console.error(chalk.red(`✗ Token file not found: ${filePath}`));
      process.exitCode = 1;
      return;
    }
    const lockPath = options.lockfile
      ? resolvePath(options.lockfile)
      : join(dirname(filePath), LOCKFILE_NAME);

    let codeTokens;
    try {
      codeTokens = parseTokenFile(filePath, workspaceIO().readText(filePath, { role: 'token-file' }));
    } catch (e) {
      console.error(chalk.red(`✗ ${e.message}`));
      process.exitCode = 1;
      return;
    }
    const declaredElsewhere = [];
    for (const [name, token] of codeTokens) {
      if (token.collection
        && token.collection.localeCompare(options.collection, undefined, { sensitivity: 'accent' }) !== 0) {
        declaredElsewhere.push({ name, collection: token.collection });
        codeTokens.delete(name);
      }
    }
    if (declaredElsewhere.length) {
      console.log(chalk.gray(`  Ignoring ${declaredElsewhere.length} token(s) whose exported collection metadata targets another collection.`));
    }
    if (!codeTokens.size) {
      console.error(chalk.yellow(`⚠ No tokens found in ${filePath}.`));
      console.error(chalk.gray('  Syncing an empty file would look like "delete everything" — stopping instead.'));
      process.exitCode = 1;
      return;
    }

    const lock = existsSync(lockPath)
      ? parseLock(workspaceIO().readText(lockPath, { role: 'token-lockfile' }))
      : null;
    if (existsSync(lockPath) && !lock) {
      console.log(chalk.yellow(`⚠ ${lockPath} is unreadable or from a newer version — treating this as a first sync.`));
    }

    let figmaSide;
    try {
      figmaSide = await readFigmaTokens(options.collection);
    } catch (e) {
      handleEvalError(e);
    }

    const aliases = [];
    const figmaTokens = new Map();
    if (!figmaSide.missing) {
      for (const v of figmaSide.variables) {
        if (v.alias) { aliases.push(v.name); continue; }
        figmaTokens.set(v.name, {
          type: v.type, value: v.value, id: v.id,
          scopes: v.scopes || [], codeSyntax: v.codeSyntax || {},
        });
      }
    }

    let plan = planSync(codeTokens, figmaTokens, lock, { prune: !!options.prune });
    if (options.ours) plan = resolveConflicts(plan, 'ours');
    if (options.theirs) plan = resolveConflicts(plan, 'theirs');

    console.log(formatPlan(plan, {
      collection: options.collection + (figmaSide.missing ? ' (will be created)' : ''),
      file: filePath,
      apply: !!options.apply,
      prune: !!options.prune,
    }));

    const plannedScopeQuestions = variableScopeQuestions([
      ...plan.create,
      ...plan.update.filter((token) => token.typeChange),
    ], options.collection);
    printVariableScopeQuestions(plannedScopeQuestions);

    // A plan that is ALL creates, for names that already exist in another
    // collection, is almost always the wrong --collection rather than a genuine
    // new design system. Applying it would duplicate everything.
    const misplaced = plan.create
      .map((t) => [t.name, (figmaSide.elsewhere || {})[t.name]])
      .filter(([, owner]) => owner);
    if (misplaced.length && misplaced.length >= plan.create.length / 2) {
      const owners = [...new Set(misplaced.map(([, owner]) => owner))];
      console.log(chalk.yellow(`\n⚠ ${misplaced.length} of these names already exist in `
        + `${owners.map((o) => `"${o}"`).join(', ')}, not in "${options.collection}".`));
      console.log(chalk.yellow('  Applying this would duplicate them. Did you mean '
        + `--collection ${JSON.stringify(owners[0])}?`));
      console.log(chalk.gray('  (`export dtcg` writes every local variable into one file, '
        + 'while sync targets a single collection.)'));
    }

    if (figmaSide.modes > 1) {
      console.log(chalk.yellow(`\n⚠ "${options.collection}" has ${figmaSide.modes} modes; sync reads and writes the first one only.`));
    }
    if (aliases.length) {
      console.log(chalk.yellow(`\n⚠ ${aliases.length} alias variable(s) skipped (they point at other variables, not values):`));
      console.log(chalk.gray('  ' + aliases.slice(0, 8).join(', ') + (aliases.length > 8 ? ', …' : '')));
    }

    if (plan.conflict.length) {
      console.log(chalk.red(`\n✗ ${plan.conflict.length} conflict(s) — nothing was applied.`));
      process.exitCode = 1;
      return;
    }

    if (!options.apply) {
      if (planTouchesFigma(plan)) {
        console.log(chalk.gray('\n  Dry run. Re-run with --apply to write these changes to Figma.'));
        process.exitCode = 1;
      } else {
        console.log(chalk.green('\n✓ Figma is already in sync with this file.'));
      }
      return;
    }

    const retypes = plan.update.filter((t) => t.typeChange);
    if (retypes.length) {
      console.log(chalk.yellow(`\n⚠ ${retypes.length} variable(s) change type. Figma cannot retype a variable in place,`));
      console.log(chalk.yellow('  so these are recreated — any layer bound to them loses that binding.'));
    }

    const spinner = progress('Applying to Figma…').start();
    let result;
    try {
      result = await applyPlan(plan, options.collection);
    } catch (e) {
      spinner.fail('Sync failed');
      handleEvalError(e);
    }
    const d = result.done || {};
    spinnerSucceed(spinner,
      `${d.created || 0} created, ${d.updated || 0} updated, ${d.retyped || 0} retyped, `
      + `${d.renamed || 0} renamed, ${d.deleted || 0} deleted`);

    if (result.failed && result.failed.length) {
      console.log(chalk.red(`\n✗ ${result.failed.length} operation(s) failed:`));
      for (const f of result.failed.slice(0, 10)) console.log(chalk.red('  ' + f));
      console.log(chalk.yellow('\n  The lockfile was NOT updated — fix these and re-run, or the next'));
      console.log(chalk.yellow('  sync would treat the failed writes as deliberate Figma edits.'));
      process.exitCode = 1;
      return;
    }

    // Only now, after every write succeeded, does the lock advance — a lock
    // written after a partial failure would record a state Figma is not in,
    // and the next run would read the difference as a designer edit.
    const synced = new Map();
    for (const [name, t] of codeTokens) {
      const existing = figmaTokens.get(name);
      synced.set(name, {
        type: t.type,
        value: t.value,
        id: existing?.id || t.variableId,
        ...(Object.hasOwn(t, 'scopes') ? { scopes: t.scopes } : {}),
        ...(Object.hasOwn(t, 'codeSyntax') ? { codeSyntax: t.codeSyntax } : {}),
      });
    }
    // A token dropped from the code file but NOT pruned is still in Figma and
    // still sync's responsibility. Letting it fall out of the lock here would
    // demote it to an untracked variable on the next run — which sync refuses
    // to prune, so it could never be removed again.
    for (const d of plan.delete) {
      if (d.willDelete) continue;
      synced.set(d.name, { type: d.type, value: d.value, id: d.id });
    }
    for (const t of plan.pull) {
      // Figma is ahead here and the code file was not changed by us, so the
      // lock must keep pointing at the last AGREED state, not at either side.
      synced.delete(t.name);
    }
    // A rename moved the entry to its new name; the old key must not linger,
    // or the next run would see a tracked variable that no longer exists.
    for (const r of plan.rename) synced.delete(r.from);
    workspaceIO().write(lockPath, JSON.stringify(buildLock({
      collection: options.collection,
      fileKey: figmaSide.fileKey || null,
      tokens: synced,
    }), null, 2) + '\n', { role: 'token-lockfile', createParents: true });
    console.log(chalk.gray(`  lockfile: ${lockPath}`));

    if (plan.pull.length) {
      console.log(chalk.yellow(`\n⚠ ${plan.pull.length} token(s) are newer in Figma. Update ${filePath} to match,`));
      console.log(chalk.yellow('  then re-run sync so the lockfile can record them as agreed.'));
    }
  });

tokens
  .command('overlap <collections...>')
  .description('Compare token names across N local variable collections. Shows common core (switchable subset) + per-collection unique names. Useful before a theme switch, to know which tokens swap cleanly.')
  .option('--json', 'Output as JSON')
  .option('-l, --limit <count>', 'Maximum names returned per list', '200')
  .allowExcessArguments(false)
  .action(async (collectionNames, options) => {
    try {
      const plan = planFigmaCommand(tokenOverlapPlanningArgvFromRequest({
        queries: collectionNames, limit: options.limit, json: options.json === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenOverlapPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

tokens
  .command('import-design-md <file>')
  .description('Import exact portable Variable Snapshot v2 data or simple color, radius, and spacing tokens from DESIGN.md. Typography and shadows stay explicit context; legacy snapshots retain bounded compatibility behavior.')
  .option('-c, --collection <name>', 'Collection name (defaults to the design system name)')
  .option('--print-context', 'Just print the agent context summary, do not create variables')
  .option('--force-slash', 'Allow "/" in --collection for a simple single-Collection import')
  .allowExcessArguments(false)
  .action(async (file, options) => {
    if (options.printContext) {
      try {
        const plan = planFigmaCommand(designMdPlanningArgvFromRequest({
          file,
          collection: options.collection ?? null,
          printContext: true,
          forceSlash: options.forceSlash === true,
        }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
        const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
          async () => executeDesignMdContextPlan(plan, { workspaceIO: workspaceIO() }));
        console.log(result.stdout);
      } catch (error) {
        handleEvalError(error);
        process.exitCode = 1;
      }
      return;
    }
    let plan;
    let prepared;
    try {
      plan = planFigmaCommand(designMdPlanningArgvFromRequest({
        file,
        collection: options.collection ?? null,
        printContext: false,
        forceSlash: options.forceSlash === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      prepared = prepareDesignMdImportPlan(plan, { workspaceIO: workspaceIO() });
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
      return;
    }

    if (prepared.kind !== 'legacy-variable-snapshot') {
      try {
        const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
          async ({ fileKey, deadline }) => {
            if (prepared.kind === 'single-collection'
              || prepared.kind === 'variable-snapshot-v2') {
              await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
            }
            return executeDesignMdImportPlan(plan, prepared, {
              evaluate: (code) => daemonExec('eval', {
                code, ...(fileKey ? { fileKey } : {}),
              }, Math.max(1, deadline - Date.now())),
            });
          });
        console.log(result.stdout);
        if (result.stderr) console.error(chalk.yellow(result.stderr));
      } catch (error) {
        handleEvalError(error);
        process.exitCode = 1;
      }
      return;
    }

    const parsed = prepared.parsed;
    await checkConnection();
    const { summarizeForLLM, variableImportCode } = await import('../design-md.js');

    // Authoritative path: the file carries real variable collections (from
    // the `extract` command). Recreate them faithfully — names, modes, alias
    // chains — instead of the lossy single-mode palette derived from fills.
    const realVars = parsed.tokens.variables;
    if (realVars && Object.keys(realVars).length) {
      const collNames = Object.keys(realVars);
      const totalVars = collNames.reduce((a, n) => a + Object.keys(realVars[n].variables || {}).length, 0);
      if (options.collection) {
        console.log(chalk.yellow('⚠'), `--collection is ignored: this file carries ${collNames.length} named collection(s); using their real names.`);
      }
      const spinner = progress(`Recreating ${totalVars} variable(s) across ${collNames.length} collection(s)…`).start();
      try {
        const result = await daemonExec('eval', { code: variableImportCode(realVars) });
        const r = typeof result === 'string' ? (() => { try { return JSON.parse(result); } catch { return null; } })() : result;
        if (r) {
          spinnerSucceed(spinner, `Created ${r.createdCount} variable(s), wired ${r.aliasCount} alias(es) across ${r.collections} collection(s)`);
          if (r.unresolved) console.log(chalk.yellow(`  ⚠ ${r.unresolved} alias value(s) unresolved (target outside this file / type mismatch)`));
          printVariableScopeQuestions(r.scopeQuestions);
        } else {
          spinnerSucceed(spinner, 'Variables imported');
        }
      } catch (error) {
        spinner.fail('Failed to import variable collections');
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      console.log();
      console.log(chalk.cyan('─── agent context summary ───────────'));
      console.log(summarizeForLLM(parsed));
      console.log(chalk.cyan('──────────────────────────────────────────────'));
      return;
    }
  });

tokens
  .command('add <name> <value>')
  .description('Add a single token')
  .option('-c, --collection <name>', 'Collection name', 'Tokens')
  .option('-t, --type <type>', 'Type: COLOR, FLOAT, STRING, BOOLEAN, EASING, TIMING (auto-detected if not set)')
  .option('--allow-duplicate', 'Intentionally allow an exact duplicate name in the Collection')
  .allowExcessArguments(false)
  .action(async (name, value, options) => {
    try {
      const plan = planFigmaCommand(tokenAddPlanningArgvFromRequest({
        name, value, collection: options.collection, type: options.type,
        allowDuplicate: options.allowDuplicate === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenAddPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(chalk.green(result.stdout));
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });


// ============ REBIND (switch a subtree to another collection) ============
//
// Rebuilt from the deleted `use <collection>` / `theme` command. Same idea —
// walk every variable binding under a node and repoint it at the same-named
// variable in a target collection — with three changes:
//
//   1. It takes a node id. The original walked figma.currentPage.selection,
//      which no MCP caller can set, which is why it was unreachable.
//   2. It plans by default and writes only under --apply, like `tokens sync`.
//      The original rebound a whole page on the first try.
//   3. It reports which nodes changed, not just how many bindings did.
//
// This is what `tokens sync` cannot do: sync writes VALUES into a collection,
// rebind changes WHICH collection a design points at. Neither replaces the
// other.

tokens
  .command('rebind <collection>')
  .description('Repoint every variable binding under a node at the same-named variable in <collection> — the theme switch. Plans only unless --apply. Complements `tokens sync`, which writes values rather than changing which collection a design follows.')
  .option('-n, --node <id>', 'Root node (its whole subtree is walked)')
  .option('--page', 'Walk the entire current page instead of one node')
  .option('--apply', 'Actually rebind (default: show the plan only)')
  .allowExcessArguments(false)
  .action(async (collection, options) => {
    try {
      const plan = planFigmaCommand(tokenRebindPlanningArgvFromRequest({
        collection, nodeId: options.node || null, page: options.page === true,
        apply: options.apply === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          return executeTokenRebindPlan(plan, {
            evaluate: (code) => daemonExec('eval', { code, ...(fileKey ? { fileKey } : {}) },
              Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });
