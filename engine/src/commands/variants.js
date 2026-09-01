// Commands: variants (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  progress,
  program,
  checkConnection,
  daemonExec,
  fastEval,
  spinnerSucceed
} from '../lib/cli-core.js';
import {
  executeSizeVariantsPlan,
  sizeVariantsPlanningArgvFromRequest,
} from '../application/size-variants-command.js';

// ============ SIZES ============

program
  .command('sizes [nodeId]')
  .description('Generate Small/Medium/Large size variants from a component')
  .option('-b, --base <size>', 'Which size is the source: small, medium, large', 'medium')
  .option('-g, --gap <n>', 'Gap between variants', '40')
  .allowExcessArguments(false)
  .action(async (nodeId, options) => {
    try {
      const plan = planFigmaCommand(sizeVariantsPlanningArgvFromRequest({
        nodeId: nodeId || null,
        baseSize: options.base,
        gap: options.gap,
      }), {
        adapter: 'cli',
        fileKey: program.opts().figmaFile || null,
      });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, expectedEditor, deadline }) => {
          await ensurePluginReadiness({ deadline, maxWaitMs: 8000, fileKey, expectedEditor });
          return executeSizeVariantsPlan(plan, {
            evaluate: (code) => daemonExec('eval', {
              code,
              ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      console.error(chalk.red('✗ Size Variants failed: ' + (error?.message || String(error))));
      process.exitCode = 1;
    }
  });

// (The `variants from` group was removed: unreachable through the MCP
// allowlist, and `component combine <ids>` — which IS allowlisted — builds
// the same Component Set. `sizes` and `combos` below stay.)

// ============ COMBOS ============

program
  .command('combos [nodeId]')
  .description('Generate all component variant combinations in a labeled grid')
  .option('-g, --gap <n>', 'Gap between instances', '40')
  .option('--no-labels', 'Skip row/column labels')
  .option('--no-boolean', 'Skip boolean properties')
  .option('--dry-run', 'Show combinations without creating instances')
  .action(async (nodeId, options) => {
    await checkConnection();
    const spinner = progress('Analyzing component properties...').start();

    try {
      const includeBoolean = options.boolean !== false;
      const nodeIdStr = nodeId || '';

      const analysisCode = `(async () => {
        let node;
        if (${JSON.stringify(nodeIdStr)}) {
          node = await figma.getNodeByIdAsync(${JSON.stringify(nodeIdStr)});
        } else {
          node = figma.currentPage.selection[0];
        }

        if (!node) {
          return { error: 'No component selected. Select a component set or provide a node ID.' };
        }

        let componentSet = null;
        if (node.type === 'COMPONENT_SET') {
          componentSet = node;
        } else if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
          componentSet = node.parent;
        } else if (node.type === 'INSTANCE') {
          const main = await node.getMainComponentAsync();
          if (main?.parent?.type === 'COMPONENT_SET') {
            componentSet = main.parent;
          }
        }

        if (!componentSet) {
          return { error: 'Selected node is not a component set or variant. Select a component with variants.' };
        }

        const propDefs = componentSet.componentPropertyDefinitions;
        if (!propDefs || Object.keys(propDefs).length === 0) {
          return { error: 'Component has no properties defined.' };
        }

        const properties = [];
        for (const [name, def] of Object.entries(propDefs)) {
          if (def.type === 'VARIANT') {
            properties.push({ name, type: 'VARIANT', options: def.variantOptions || [] });
          } else if (def.type === 'BOOLEAN' && ${includeBoolean}) {
            properties.push({ name, type: 'BOOLEAN', options: [true, false] });
          }
        }

        if (properties.length === 0) {
          return { error: 'No variant or boolean properties found.' };
        }

        const defaultVariant = componentSet.defaultVariant;
        if (!defaultVariant) {
          return { error: 'Could not find default variant.' };
        }

        // Find max size across all variants (for proper grid spacing)
        let maxW = 0, maxH = 0;
        for (const child of componentSet.children) {
          if (child.type === 'COMPONENT') {
            maxW = Math.max(maxW, child.width);
            maxH = Math.max(maxH, child.height);
          }
        }

        return {
          componentSetId: componentSet.id,
          componentSetName: componentSet.name,
          defaultVariantId: defaultVariant.id,
          properties,
          instanceSize: { w: maxW || defaultVariant.width, h: maxH || defaultVariant.height }
        };
      })()`;

      const analysis = await fastEval(analysisCode);

      if (analysis.error) {
        spinner.fail(analysis.error);
        return;
      }

      // Calculate cartesian product of all options
      function cartesian(arrays) {
        return arrays.reduce((a, b) => a.flatMap(x => b.map(y => [...x, y])), [[]]);
      }

      const optionArrays = analysis.properties.map(p => p.options);
      const combinations = cartesian(optionArrays);
      const totalCombos = combinations.length;

      spinner.text = `Found ${totalCombos} combinations for ${analysis.properties.length} properties`;

      if (options.dryRun) {
        spinnerSucceed(spinner, `${totalCombos} combinations (dry run)`);
        console.log(chalk.cyan('\nProperties:'));
        analysis.properties.forEach(p => {
          console.log(`  ${p.name}: ${p.options.join(', ')}`);
        });
        console.log(chalk.cyan(`\nWould create ${totalCombos} instances`));
        return;
      }

      // Determine grid layout
      const gap = parseInt(options.gap) || 40;
      const labelHeight = options.labels !== false ? 30 : 0;
      const labelWidth = options.labels !== false ? 120 : 0;
      const colProp = analysis.properties[analysis.properties.length - 1];
      const rowProps = analysis.properties.slice(0, -1);
      const numCols = colProp.options.length;
      const numRows = rowProps.length > 0 ? rowProps.reduce((acc, p) => acc * p.options.length, 1) : 1;
      const instanceW = analysis.instanceSize.w;
      const instanceH = analysis.instanceSize.h;
      const showLabels = options.labels !== false;

      spinner.text = `Creating ${totalCombos} components in ${numRows}x${numCols} grid...`;

      const createCode = `(async () => {
        const componentSet = await figma.getNodeByIdAsync(${JSON.stringify(analysis.componentSetId)});
        const defaultVariant = await figma.getNodeByIdAsync(${JSON.stringify(analysis.defaultVariantId)});

        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
        await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });

        let startX = 0;
        figma.currentPage.children.forEach(n => { startX = Math.max(startX, n.x + n.width); });
        startX += 200;
        const startY = 100;

        const gap = ${gap};
        const instanceW = ${instanceW};
        const instanceH = ${instanceH};
        const baseName = ${JSON.stringify(analysis.componentSetName)};
        const showLabels = ${showLabels};
        const labelOffset = showLabels ? 120 : 0;
        const headerOffset = showLabels ? 40 : 0;

        const properties = ${JSON.stringify(analysis.properties)};
        const combinations = ${JSON.stringify(combinations)};
        const colProp = properties[properties.length - 1];
        const rowProps = properties.slice(0, -1);

        const createdComponents = [];
        const createdNodes = [];
        const createdLabels = [];
        const rowCombos = new Map();
        for (const combo of combinations) {
          const rowKey = combo.slice(0, -1).join('|');
          if (!rowCombos.has(rowKey)) rowCombos.set(rowKey, []);
          rowCombos.get(rowKey).push(combo);
        }

        // Create column headers (last property values)
        if (showLabels) {
          for (let colIndex = 0; colIndex < colProp.options.length; colIndex++) {
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Medium' };
            label.characters = String(colProp.options[colIndex]);
            label.fontSize = 14;
            label.fills = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }];
            label.x = startX + labelOffset + colIndex * (instanceW + gap) + instanceW / 2 - label.width / 2;
            label.y = startY;
            createdLabels.push(label);
          }
        }

        let rowIndex = 0;
        for (const [rowKey, combos] of rowCombos) {
          // Create row label (all properties except last)
          if (showLabels && rowProps.length > 0) {
            const rowValues = rowKey.split('|');
            const label = figma.createText();
            label.fontName = { family: 'Inter', style: 'Regular' };
            label.characters = rowValues.join(' / ');
            label.fontSize = 12;
            label.fills = [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }];
            label.x = startX;
            label.y = startY + headerOffset + rowIndex * (instanceH + gap) + instanceH / 2 - label.height / 2;
            createdLabels.push(label);
          }

          for (let colIndex = 0; colIndex < combos.length; colIndex++) {
            const combo = combos[colIndex];

            // Create instance and set properties
            const instance = defaultVariant.createInstance();
            const propsToSet = {};
            for (let i = 0; i < properties.length; i++) {
              propsToSet[properties[i].name] = combo[i];
            }
            try {
              instance.setProperties(propsToSet);
            } catch (e) {
              instance.remove();
              continue;
            }

            // Detach from component to get a frame
            const detached = instance.detachInstance();

            // Convert to component with proper name
            const compName = baseName + '/' + combo.join('/');
            const component = figma.createComponentFromNode(detached);
            component.name = compName;

            // Position on canvas (offset for labels)
            component.x = startX + labelOffset + colIndex * (instanceW + gap);
            component.y = startY + headerOffset + rowIndex * (instanceH + gap);

            createdComponents.push({ id: component.id, name: component.name });
            createdNodes.push(component);
          }
          rowIndex++;
        }

        const allNodes = [...createdNodes, ...createdLabels].filter(Boolean);
        figma.currentPage.selection = allNodes;
        if (allNodes.length > 0) {
          figma.viewport.scrollAndZoomIntoView(allNodes);
        }

        return { count: createdComponents.length, labels: createdLabels.length, gridSize: rowIndex + 'x' + colProp.options.length, components: createdComponents.slice(0, 3) };
      })()`;

      const result = await fastEval(createCode);

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const labelInfo = result.labels > 0 ? ` with ${result.labels} labels` : '';
      spinnerSucceed(spinner, `Created ${result.count} components in ${result.gridSize} grid${labelInfo}`);
      if (result.components && result.components.length > 0) {
        console.log(chalk.gray(`  ${result.components.map(c => c.name).join(', ')}${result.count > 3 ? ', ...' : ''}`));
      }

    } catch (error) {
      spinner.fail('Failed: ' + error.message);
      process.exitCode = 1;
    }
  });

// NOTE: there is deliberately NO `shadcn` generator here — this tool ships
// no third-party design-system content. `sizes`, `combos` and `variants`
// below stay: they operate on the USER's own components.
