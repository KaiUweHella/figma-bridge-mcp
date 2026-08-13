// Command adapter for the Design Link Registry.
import chalk from 'chalk';
import { resolve } from 'node:path';
import { program, checkConnection, daemonExec, handleEvalError } from '../lib/cli-core.js';
import { executeDesignLink } from '../application/design-link-command.js';
import { DESIGN_LINK_REGISTRY_FILE } from '../lib/design-link-registry.js';
import { formatProjectDesignContext, formatRoundTripPlan } from '../lib/round-trip-planner.js';

const link = program
  .command('link')
  .description('Link durable Design Entities across code, Storybook and Figma');

function manifest(options) {
  return resolve(options.manifest || DESIGN_LINK_REGISTRY_FILE);
}

function printEntity(entity) {
  if (!entity) return console.log(chalk.yellow('No Design Entity link found.'));
  console.log(chalk.bold(`${entity.id}  [${entity.kind}]`));
  if (entity.code?.path) console.log(`  code: ${entity.code.path}${entity.code.export ? `#${entity.code.export}` : ''}`);
  if (entity.storybook?.storyId) console.log(`  story: ${entity.storybook.storyId}`);
  if (entity.figma?.nodeId) console.log(`  figma: ${entity.figma.nodeId}${entity.figma.componentKey ? `  key ${entity.figma.componentKey}` : ''}`);
  if (entity.legacy) console.log(chalk.gray('  source: legacy figma-map.json adapter'));
}

link
  .command('set <nodeId> <entityId>')
  .description('Attach one repository-owned Design Entity id to a Figma node and figma-bridge.json')
  .option('--kind <kind>', 'component, screen or frame (default inferred from node)')
  .option('--source <path>', 'Repo-relative source file')
  .option('--export <name>', 'Exported code symbol')
  .option('--story <id>', 'Storybook story id')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (nodeId, entityId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignLink({
        action: 'set', nodeId, entityId, kind: options.kind,
        source: options.source, exportName: options.export, storyId: options.story,
        manifestPath: manifest(options),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(chalk.green('✓'), `Linked ${result.entity.id} to ${result.figma.name} (${result.figma.id})`);
      console.log(chalk.gray(`  Registry: ${result.path}`));
      printEntity(result.entity);
    } catch (error) {
      handleEvalError(error);
    }
  });

link
  .command('inspect [nodeId]')
  .description('Resolve a Figma node or current selection through the Design Link Registry')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (nodeId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignLink({
        action: 'inspect', nodeId, manifestPath: manifest(options),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(chalk.bold(`${result.figma.name} (${result.figma.id})`));
      if (result.plugin) console.log(`  plugin: ${result.plugin.id} [${result.plugin.kind}]`);
      printEntity(result.entity);
    } catch (error) {
      handleEvalError(error);
    }
  });

link
  .command('list')
  .description('List repository Design Entities without contacting Figma')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (options) => {
    try {
      const result = await executeDesignLink({ action: 'list', manifestPath: manifest(options) });
      if (!result.entities.length) {
        console.log(chalk.gray(`No Design Entities in ${result.path}.`));
        return;
      }
      for (const entity of result.entities) printEntity(entity);
      console.log(chalk.gray(`\n${result.entities.length} Design Entity link(s) from ${result.path}${result.legacy ? ' + legacy map' : ''}.`));
    } catch (error) {
      console.error(chalk.red('✗'), error.message);
      process.exitCode = 1;
    }
  });

link
  .command('configure')
  .description('Configure project design documents used by the context projection')
  .option('--design-doc <path>', 'Repo-relative DESIGN.md path')
  .option('--tokens <path>', 'Repo-relative design-token file')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (options) => {
    try {
      const result = await executeDesignLink({
        action: 'configure', designDoc: options.designDoc, tokens: options.tokens,
        manifestPath: manifest(options),
      });
      console.log(chalk.green('✓'), `Configured Project Design Context in ${result.path}`);
      for (const [key, value] of Object.entries(result.project)) console.log(`  ${key}: ${value}`);
    } catch (error) {
      console.error(chalk.red('✗'), error.message);
      process.exitCode = 1;
    }
  });

link
  .command('status [entityId]')
  .description('Report which side changed since the accepted Design Entity baseline')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (entityId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignLink({
        action: 'status', entityId, manifestPath: manifest(options),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(formatRoundTripPlan(result.entity, result.plan, { baseline: result.entity.baseline }));
    } catch (error) {
      handleEvalError(error);
    }
  });

link
  .command('accept [entityId]')
  .description('Record the reviewed code/Figma baseline; screens require a passing visual comparison')
  .option('--compare <file>', 'Browser screenshot used as visual proof (required for screens)')
  .option('--max-diff <percent>', 'Maximum allowed differing pixels (default 5)', '5')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (entityId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignLink({
        action: 'accept', entityId, comparePath: options.compare ? resolve(options.compare) : undefined,
        maxDiff: options.maxDiff, manifestPath: manifest(options),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(chalk.green('✓'), `Accepted current code and Figma state for ${result.entity.id}`);
      console.log(formatRoundTripPlan(result.entity, result.plan, { baseline: result.baseline }));
    } catch (error) {
      handleEvalError(error);
    }
  });

link
  .command('context [entityId]')
  .description('Project the smallest relevant code, Figma, Storybook and sync context')
  .option('--manifest <file>', 'Design Link Registry file', DESIGN_LINK_REGISTRY_FILE)
  .action(async (entityId, options) => {
    await checkConnection();
    try {
      const result = await executeDesignLink({
        action: 'context', entityId, manifestPath: manifest(options),
      }, { evaluate: (code) => daemonExec('eval', { code }) });
      console.log(formatProjectDesignContext(result.context));
    } catch (error) {
      handleEvalError(error);
    }
  });
