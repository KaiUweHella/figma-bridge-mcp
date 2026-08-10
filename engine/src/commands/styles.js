import chalk from 'chalk';
import { checkConnection, fastEval, handleEvalError, program } from '../lib/cli-core.js';
import {
  parseStyleProperties, parseStyleType, styleApplyCode, styleConsumersCode,
  styleCreateCode, styleDeleteCode, styleListCode, stylePublishStatusCode,
  styleShowCode, styleUpdateCode,
} from '../lib/style-management.js';

const print = (value) => console.log(JSON.stringify(value, null, 2));
const run = async (code) => { await checkConnection(); return fastEval(code); };
const styles = program.command('style').description('Manage local paint, text, effect, and grid styles');

styles.command('list').option('-t, --type <type>', 'PAINT, TEXT, EFFECT, or GRID').action(async (options) => {
  try { print(await run(styleListCode({ type: options.type }))); } catch (error) { handleEvalError(error); }
});
styles.command('show <style>').action(async (style) => {
  try { print(await run(styleShowCode({ style }))); } catch (error) { handleEvalError(error); }
});
styles.command('create <type> <name>')
  .option('-d, --description <text>').option('-p, --properties <json>', 'Type-specific properties as JSON')
  .action(async (type, name, options) => {
    try {
      const normalized = parseStyleType(type);
      const result = await run(styleCreateCode({ type: normalized, name, description: options.description, properties: parseStyleProperties(options.properties, normalized) }));
      console.log(chalk.green('✓'), `Created ${normalized} style ${result.name}.`); print(result);
    } catch (error) { handleEvalError(error); }
  });
styles.command('update <style>')
  .option('-t, --type <type>', 'Required when using --properties')
  .option('-n, --name <name>').option('-d, --description <text>').option('-p, --properties <json>')
  .action(async (style, options) => {
    try {
      if (options.name === undefined && options.description === undefined && options.properties === undefined) throw new Error('Provide --name, --description, or --properties');
      if (options.properties !== undefined && !options.type) throw new Error('--type is required with --properties');
      const type = options.type ? parseStyleType(options.type) : undefined;
      const properties = options.properties === undefined ? undefined : parseStyleProperties(options.properties, type);
      print(await run(styleUpdateCode({ style, type, name: options.name, description: options.description, properties })));
    } catch (error) { handleEvalError(error); }
  });
styles.command('apply <style> <nodeIds>')
  .requiredOption('-f, --field <field>', 'fill, stroke, text, effect, or grid')
  .action(async (style, nodeIds, options) => {
    try { print(await run(styleApplyCode({ style, nodeIds, field: options.field }))); } catch (error) { handleEvalError(error); }
  });
styles.command('consumers <style>').action(async (style) => {
  try { print(await run(styleConsumersCode({ style }))); } catch (error) { handleEvalError(error); }
});
styles.command('publish-status <style>').action(async (style) => {
  try { print(await run(stylePublishStatusCode({ style }))); } catch (error) { handleEvalError(error); }
});
styles.command('delete <style>').action(async (style) => {
  try { const result = await run(styleDeleteCode({ style })); console.log(chalk.green('✓'), `Deleted ${result.type} style ${result.name}.`); } catch (error) { handleEvalError(error); }
});
