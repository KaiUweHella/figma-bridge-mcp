// Commands: tokens (extracted from index.js)
import chalk from 'chalk';
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
  executeTokenSyncPlan,
  tokenSyncPlanningArgvFromRequest,
  withTokenSyncPlanLock,
} from '../application/token-sync-command.js';
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
  daemonTypedRead,
  handleEvalError,
  hexToRgb,
  spinnerSucceed
} from '../lib/cli-core.js';
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
  .option('--only-if-empty', 'Delete only when the collection contains no variables')
  .allowExcessArguments(false)
  .action(async (collection, options) => {
    try {
      const plan = planFigmaCommand(collectionDeletePlanningArgvFromRequest({
        collection, onlyIfEmpty: options.onlyIfEmpty === true,
      }), {
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

tokens
  .command('sync <file>')
  .description('Two-way sync between a token file (DTCG JSON or CSS variables) and a Figma collection')
  .option('-c, --collection <name>', 'Figma collection to sync with', 'Design Tokens')
  .option('--apply', 'Actually write to Figma (default: show the plan only)')
  .option('--prune', 'Also delete Figma variables that sync created and code no longer has')
  .option('--ours', 'Resolve every conflict in favour of the code file')
  .option('--theirs', 'Resolve every conflict in favour of Figma (writes nothing to Figma)')
  .option('--lockfile <path>', 'Lockfile path (default: figma-tokens.lock.json beside the token file)')
  .allowExcessArguments(false)
  .action(async (file, options) => {
    try {
      const plan = planFigmaCommand(tokenSyncPlanningArgvFromRequest({
        file,
        collection: options.collection || 'Design Tokens',
        apply: options.apply === true,
        prune: options.prune === true,
        ours: options.ours === true,
        theirs: options.theirs === true,
        lockfile: options.lockfile || null,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const io = workspaceIO();
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          const remainingMs = () => Math.max(0, deadline - Date.now());
          return withTokenSyncPlanLock(plan, {
            workspaceIO: io,
            remainingMs,
          }, async (prepared) => {
            await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
            return executeTokenSyncPlan(plan, prepared, {
              workspaceIO: io,
              fileKey,
              remainingMs,
              evaluate: (code, context = {}) => daemonExec('eval', {
                code, ...(fileKey ? { fileKey } : {}),
              }, context.timeoutMs),
            });
          });
        });
      console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
      if (result.code !== 0) process.exitCode = result.code;
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
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
            typedRead: (operation, request, fallbackCode) => daemonTypedRead(
              operation, request, fallbackCode,
              fileKey ? { fileKey } : {}, Math.max(1, deadline - Date.now()),
            ),
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
          if (r.preserved) console.log(chalk.yellow(`  ⚠ ${r.preserved} existing composed color Alias value(s) preserved (legacy import cannot restore Alias opacity; use a Variable Snapshot v2)`));
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
