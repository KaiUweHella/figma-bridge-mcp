import chalk from 'chalk';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  executeLibraryImportPlan,
  libraryImportArgvFromRequest,
} from '../application/library-import-command.js';
import {
  executeLibraryReadPlan,
  libraryReadArgvFromRequest,
} from '../application/library-read-command.js';
import {
  daemonExec, handleEvalError, program,
} from '../lib/cli-core.js';

const library = program.command('library').description('Discover enabled variable libraries and import published assets by key');

async function runLibraryRead(request) {
  try {
    const plan = planFigmaCommand(libraryReadArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, expectedEditor, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
        return executeLibraryReadPlan(plan, {
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

async function runLibraryImport(request) {
  try {
    const plan = planFigmaCommand(libraryImportArgvFromRequest(request), {
      adapter: 'cli', fileKey: program.opts().figmaFile || null,
    });
    const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
      async ({ fileKey, deadline }) => {
        await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
        return executeLibraryImportPlan(plan, {
          evaluate: (code) => daemonExec('eval', {
            code, ...(fileKey ? { fileKey } : {}),
          }, Math.max(1, deadline - Date.now())),
        });
      });
    const resource = result.result.resource;
    const label = request.action === 'variable' ? 'variable'
      : request.action === 'style' ? `${resource.type} style`
        : request.action === 'component-set' ? 'component set' : 'component';
    console.log(chalk.green('✓'), `Imported ${label} ${resource.name}.`);
    console.log(result.stdout);
  } catch (error) {
    handleEvalError(error); process.exitCode = 1;
  }
}

library.command('collections')
  .description('List variable collections from libraries enabled in the current Figma file')
  .allowExcessArguments(false)
  .action(async () => runLibraryRead({ action: 'collections' }));

library.command('variables <collection>')
  .description('List published variables in one enabled library collection')
  .option('-t, --type <type>', 'Filter by BOOLEAN, COLOR, EASING, FLOAT, STRING, or TIMING')
  .allowExcessArguments(false)
  .action(async (collection, options) => runLibraryRead({
    action: 'variables', collection, type: options.type,
  }));

library.command('import-variable <key>')
  .description('Import one published variable by key')
  .allowExcessArguments(false)
  .action(async (key) => runLibraryImport({ action: 'variable', key }));

library.command('import-style <key>')
  .description('Import one published paint, text, effect, or grid style by key')
  .allowExcessArguments(false)
  .action(async (key) => runLibraryImport({ action: 'style', key }));

library.command('import-component <key>')
  .description('Import one published component by key')
  .allowExcessArguments(false)
  .action(async (key) => runLibraryImport({ action: 'component', key }));

library.command('import-component-set <key>')
  .description('Import one published component set by key')
  .allowExcessArguments(false)
  .action(async (key) => runLibraryImport({ action: 'component-set', key }));
