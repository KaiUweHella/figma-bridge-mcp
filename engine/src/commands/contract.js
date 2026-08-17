import chalk from 'chalk';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { program, checkConnection, daemonExec, handleEvalError } from '../lib/cli-core.js';
import { DESIGN_LINK_REGISTRY_FILE } from '../lib/design-link-registry.js';
import {
  executeDesignContract,
  formatDesignContractResult,
} from '../application/design-contract-command.js';

const contract = program
  .command('contract')
  .description('Capture and check canonical Design Contracts for linked Design Entities');

function defaultPath(entityId) {
  return resolve('design-contracts', `${String(entityId).replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`);
}

function optionsFor(entityId, options) {
  return {
    entityId,
    manifestPath: resolve(options.manifest || DESIGN_LINK_REGISTRY_FILE),
    contractPath: resolve(options.file || defaultPath(entityId)),
    depth: Number.parseInt(options.depth, 10),
    includeHidden: options.includeHidden === true,
  };
}

contract
  .command('capture <entityId>')
  .description('Write the reviewed live Design Capture as a deterministic contract')
  .option('--file <path>', 'Contract JSON file (default: design-contracts/<entity>.json)')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .option('--depth <n>', 'Maximum capture depth', '12')
  .option('--include-hidden', 'Include hidden Figma layers')
  .option('--geometry-tolerance <px>', 'Allowed geometry noise in semantic rules', '0.5')
  .action(async (entityId, options) => {
    await checkConnection();
    try {
      const request = {
        action: 'capture', ...optionsFor(entityId, options),
        geometryTolerance: Number(options.geometryTolerance),
      };
      mkdirSync(dirname(request.contractPath), { recursive: true });
      const result = await executeDesignContract(request, {
        evaluate: (code) => daemonExec('eval', { code }),
      });
      console.log(chalk.green('✓'), formatDesignContractResult(result));
    } catch (error) {
      handleEvalError(error);
    }
  });

contract
  .command('check <entityId>')
  .description('Compare live Figma with the canonical contract and enforce its semantic rules')
  .option('--file <path>', 'Contract JSON file (default: design-contracts/<entity>.json)')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .option('--depth <n>', 'Maximum capture depth', '12')
  .option('--include-hidden', 'Include hidden Figma layers')
  .option('--max-diffs <n>', 'Maximum canonical differences to collect', '200')
  .action(async (entityId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignContract({
        action: 'check', ...optionsFor(entityId, options),
        maxDiffs: Number.parseInt(options.maxDiffs, 10),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(result.check.ok ? chalk.green('✓') : chalk.red('✗'), formatDesignContractResult(result));
      if (!result.check.ok) process.exitCode = 1;
    } catch (error) {
      handleEvalError(error);
    }
  });
