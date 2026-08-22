import chalk from 'chalk';
import { resolve } from 'node:path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { runInProcessCommandPlan } from '../../../src/engine.js';
import { program, checkConnection, daemonExec, handleEvalError } from '../lib/cli-core.js';
import { DESIGN_LINK_REGISTRY_FILE } from '../lib/design-link-registry.js';
import { workspaceIO } from '../lib/workspace-io.js';
import {
  designContractArgvFromRequest,
  designContractFileKeyFromArgv,
  designContractResultRows,
  executeDesignContractPlan,
  formatDesignContractAdapterResult,
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

function renderResultRows(rows) {
  for (const row of rows) {
    const marker = row.markerTone === 'success' ? chalk.green(row.marker) : chalk.red(row.marker);
    console.log(marker, row.text);
  }
}

async function runContract(request) {
  const io = workspaceIO();
  const plan = planFigmaCommand(designContractArgvFromRequest(request), {
    adapter: 'cli',
    workspaceDir: io.roots[0],
    workspaceIO: io,
    fileKey: program.opts().figmaFile || null,
    registryFileKey: (argv) => designContractFileKeyFromArgv([...argv], { io }),
  });
  let domainResult = null;
  const execution = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
    async ({ fileKey, deadline }) => {
      await checkConnection();
      domainResult = await executeDesignContractPlan(plan, {
        workspaceIO: io,
        evaluate: (code) => daemonExec('eval', {
          code,
          ...(fileKey ? { fileKey } : {}),
        }, Math.max(1, deadline - Date.now())),
      });
      return {
        stdout: formatDesignContractAdapterResult(domainResult),
        stderr: '',
        code: domainResult.action === 'check' && !domainResult.check.ok ? 1 : 0,
      };
    });
  return { domainResult, execution };
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
    try {
      const request = {
        action: 'capture', ...optionsFor(entityId, options),
        geometryTolerance: Number(options.geometryTolerance),
      };
      const { domainResult } = await runContract(request);
      renderResultRows(designContractResultRows(domainResult));
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
    try {
      const { domainResult, execution } = await runContract({
        action: 'check', ...optionsFor(entityId, options),
        maxDiffs: Number.parseInt(options.maxDiffs, 10),
      });
      renderResultRows(designContractResultRows(domainResult));
      if (execution.code !== 0) process.exitCode = execution.code;
    } catch (error) {
      handleEvalError(error);
    }
  });
