// Command: font — truthful range inspection plus metadata-only variable axes.
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';
import {
  fontAxesCode,
  fontInspectCode,
  forgetAxesCode,
  parseAxisSpec,
  parseOptionalIndex,
  rememberAxesCode,
} from '../lib/font-introspection.js';

const font = program
  .command('font')
  .description('Inspect range typography and preserve variable-font axis intent as metadata');

const rangeOptions = (command) => command
  .option('--start <index>', 'Start character index (inclusive)')
  .option('--end <index>', 'End character index (exclusive)');

const parsedRange = (options) => ({
  start: parseOptionalIndex(options.start, '--start'),
  end: parseOptionalIndex(options.end, '--end'),
});

const print = (value) => console.log(JSON.stringify(value, null, 2));

rangeOptions(font
  .command('inspect <nodeId>')
  .description('Read Figma-reported range fonts, numeric weights, OpenType features and bindings'))
  .option('--all-open-type', 'Include false OpenType feature values as well as enabled tags')
  .action(async (nodeId, options) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      const range = parsedRange(options);
      await checkConnection();
      const result = await fastEval(fontInspectCode({
        nodeId: id, ...range, allOpenType: options.allOpenType === true,
      }));
      print(result);
    } catch (error) {
      handleEvalError(error);
    }
  });

font
  .command('axes <nodeId>')
  .description('Read metadata-only variable-font axis intent (does not describe Figma rendering)')
  .action(async (nodeId) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      await checkConnection();
      print(await fastEval(fontAxesCode({ nodeId: id })));
    } catch (error) {
      handleEvalError(error);
    }
  });

rangeOptions(font
  .command('remember-axes <nodeId> <axes>')
  .description('Store range axis intent such as wght=357,wdth=82; does NOT change glyph rendering'))
  .action(async (nodeId, axesSpec, options) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      const axes = parseAxisSpec(axesSpec);
      const range = parsedRange(options);
      await checkConnection();
      const result = await fastEval(rememberAxesCode({ nodeId: id, axes, ...range }));
      console.log(chalk.green('✓'), 'Variable-font axis intent stored as plugin metadata.');
      print(result);
    } catch (error) {
      handleEvalError(error);
    }
  });

rangeOptions(font
  .command('forget-axes <nodeId>')
  .description('Remove one exact range or all stored variable-font axis metadata'))
  .action(async (nodeId, options) => {
    try {
      const id = normalizeNodeId(nodeId).id;
      const range = parsedRange(options);
      await checkConnection();
      const result = await fastEval(forgetAxesCode({ nodeId: id, ...range }));
      console.log(chalk.green('✓'), 'Variable-font axis metadata removed.');
      print(result);
    } catch (error) {
      handleEvalError(error);
    }
  });
