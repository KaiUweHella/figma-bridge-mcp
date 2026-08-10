import chalk from 'chalk';
import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  importComponentCode, importStyleCode, importVariableCode, libraryCollectionsCode,
  libraryVariablesCode, parseLibraryVariableType,
} from '../lib/library-management.js';

const library = program.command('library').description('Discover enabled variable libraries and import published assets by key');
const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };

library.command('collections')
  .description('List variable collections from libraries enabled in the current Figma file')
  .action(async () => {
    try { print(await run(libraryCollectionsCode())); } catch (error) { handleEvalError(error); }
  });

library.command('variables <collection>')
  .description('List published variables in one enabled library collection')
  .option('-t, --type <type>', 'Filter by BOOLEAN, COLOR, EASING, FLOAT, STRING, or TIMING')
  .action(async (collection, options) => {
    try { print(await run(libraryVariablesCode({ collection, type: parseLibraryVariableType(options.type) }))); }
    catch (error) { handleEvalError(error); }
  });

library.command('import-variable <key>')
  .description('Import one published variable by key')
  .action(async (key) => {
    try { const result = await run(importVariableCode({ key })); console.log(chalk.green('✓'), `Imported variable ${result.name}.`); print(result); }
    catch (error) { handleEvalError(error); }
  });

library.command('import-style <key>')
  .description('Import one published paint, text, effect, or grid style by key')
  .action(async (key) => {
    try { const result = await run(importStyleCode({ key })); console.log(chalk.green('✓'), `Imported ${result.type} style ${result.name}.`); print(result); }
    catch (error) { handleEvalError(error); }
  });

library.command('import-component <key>')
  .description('Import one published component by key')
  .action(async (key) => {
    try { const result = await run(importComponentCode({ key })); console.log(chalk.green('✓'), `Imported component ${result.name}.`); print(result); }
    catch (error) { handleEvalError(error); }
  });

library.command('import-component-set <key>')
  .description('Import one published component set by key')
  .action(async (key) => {
    try { const result = await run(importComponentCode({ key, set: true })); console.log(chalk.green('✓'), `Imported component set ${result.name}.`); print(result); }
    catch (error) { handleEvalError(error); }
  });
