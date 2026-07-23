// Commands: figjam (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { FigJamClient } from '../figjam-client.js';
import { FigmaClient } from '../figma-client.js';
import {
  program,
  checkConnection,
  fastEval,
  isInSafeMode,
  runFigmaUse
} from '../lib/cli-core.js';

// ============ EXPORT ============

program
  .command('export-jsx [nodeId]')
  .description('Export node as JSX/React code')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .option('--pretty', 'Format output')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
        const nodes = targetId
          ? [await figma.getNodeByIdAsync(targetId)]
          : figma.currentPage.selection;

        if (!nodes.length || !nodes[0]) return 'No node selected';

        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }

        function nodeToJsx(node, indent = 0) {
          const prefix = '  '.repeat(indent);
          const props = [];

          // Name
          if (node.name && !node.name.startsWith('Frame') && !node.name.startsWith('Rectangle')) {
            props.push('name="' + node.name.replace(/"/g, '\\\\"') + '"');
          }

          // Size
          if (node.width) props.push('w={' + Math.round(node.width) + '}');
          if (node.height) props.push('h={' + Math.round(node.height) + '}');

          // Fill
          if (node.fills && node.fills.length > 0 && node.fills[0].type === 'SOLID') {
            const c = node.fills[0].color;
            props.push('bg="' + rgbToHex(c.r, c.g, c.b) + '"');
          }

          // Corner radius
          if (node.cornerRadius && node.cornerRadius > 0) {
            props.push('rounded={' + Math.round(node.cornerRadius) + '}');
          }

          // Auto-layout
          if (node.layoutMode === 'HORIZONTAL') props.push('flex="row"');
          if (node.layoutMode === 'VERTICAL') props.push('flex="col"');
          if (node.itemSpacing) props.push('gap={' + Math.round(node.itemSpacing) + '}');
          if (node.paddingTop) props.push('p={' + Math.round(node.paddingTop) + '}');

          // Text
          if (node.type === 'TEXT') {
            const textProps = [];
            if (node.fontSize) textProps.push('size={' + Math.round(node.fontSize) + '}');
            if (node.fills && node.fills[0] && node.fills[0].color) {
              const c = node.fills[0].color;
              textProps.push('color="' + rgbToHex(c.r, c.g, c.b) + '"');
            }
            return prefix + '<Text ' + textProps.join(' ') + '>' + (node.characters || '') + '</Text>';
          }

          // Frame with children
          if ('children' in node && node.children.length > 0) {
            const childJsx = node.children.map(c => nodeToJsx(c, indent + 1)).join('\\n');
            return prefix + '<Frame ' + props.join(' ') + '>\\n' + childJsx + '\\n' + prefix + '</Frame>';
          }

          return prefix + '<Frame ' + props.join(' ') + ' />';
        }

        return nodeToJsx(nodes[0]);
      })()`;

      try {
        const result = await fastEval(code);
        if (options.output) {
          writeFileSync(options.output, result);
          console.log(chalk.green(`✓ Exported to ${options.output}`));
        } else {
          console.log(result);
        }
      } catch (e) {
        console.log(chalk.red('✗ Export failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use export jsx';
      if (nodeId) cmd += ` "${nodeId}"`;
      if (options.pretty) cmd += ' --pretty';
      if (options.output) {
        cmd += ` > "${options.output}"`;
        runFigmaUse(cmd, { stdio: 'inherit' });
      } else {
        runFigmaUse(cmd);
      }
    }
  });

program
  .command('export-storybook [nodeId]')
  .description('Export components as Storybook stories')
  .option('-o, --output <file>', 'Output file (otherwise stdout)')
  .action(async (nodeId, options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const components = [];
        function findComponents(node) {
          if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
            components.push({
              id: node.id,
              name: node.name,
              type: node.type,
              width: Math.round(node.width),
              height: Math.round(node.height)
            });
          }
          if ('children' in node) node.children.forEach(c => findComponents(c));
        }
        figma.currentPage.children.forEach(c => findComponents(c));
        return components;
      })()`;

      try {
        const components = await fastEval(code);
        if (!components.length) {
          console.log(chalk.yellow('No components found on current page'));
          return;
        }

        let output = '// Storybook stories generated from Figma\n';
        output += 'import React from "react";\n\n';

        components.forEach(c => {
          const safeName = c.name.replace(/[^a-zA-Z0-9]/g, '');
          output += `export const ${safeName} = () => (\n`;
          output += `  <div style={{ width: ${c.width}, height: ${c.height} }}>\n`;
          output += `    {/* ${c.name} - ID: ${c.id} */}\n`;
          output += `  </div>\n`;
          output += `);\n\n`;
        });

        if (options.output) {
          writeFileSync(options.output, output);
          console.log(chalk.green(`✓ Exported ${components.length} components to ${options.output}`));
        } else {
          console.log(output);
        }
      } catch (e) {
        console.log(chalk.red('✗ Export failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use export storybook';
      if (nodeId) cmd += ` "${nodeId}"`;
      if (options.output) {
        cmd += ` > "${options.output}"`;
        runFigmaUse(cmd, { stdio: 'inherit' });
      } else {
        runFigmaUse(cmd);
      }
    }
  });

// ============ FIGJAM ============

const figjam = program
  .command('figjam')
  .alias('fj')
  .description('FigJam commands (sticky notes, shapes, connectors)');

// Helper: Get FigJam client
async function getFigJamClient(pageTitle) {
  const client = new FigJamClient();
  try {
    const pages = await FigJamClient.listPages();
    if (pages.length === 0) {
      console.log(chalk.red('\n✗ No FigJam pages open\n'));
      console.log(chalk.gray('  Open a FigJam file in Figma Desktop first.\n'));
      process.exit(1);
    }

    const targetPage = pageTitle || pages[0].title;
    await client.connect(targetPage);
    return client;
  } catch (error) {
    console.log(chalk.red('\n✗ ' + error.message + '\n'));
    process.exit(1);
  }
}

figjam
  .command('list')
  .description('List open FigJam pages')
  .action(async () => {
    try {
      const pages = await FigJamClient.listPages();
      if (pages.length === 0) {
        console.log(chalk.yellow('\n  No FigJam pages open\n'));
        return;
      }
      console.log(chalk.cyan('\n  Open FigJam Pages:\n'));
      pages.forEach((p, i) => {
        console.log(chalk.white(`  ${i + 1}. ${p.title}`));
      });
      console.log();
    } catch (error) {
      console.log(chalk.red('\n✗ Could not connect to Figma\n'));
      console.log(chalk.gray('  Make sure Figma is running with: figma-ds-cli connect\n'));
    }
  });

figjam
  .command('info')
  .description('Show current FigJam page info')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const info = await client.getPageInfo();
      console.log(chalk.cyan('\n  FigJam Page Info:\n'));
      console.log(chalk.white(`  Name: ${info.name}`));
      console.log(chalk.white(`  ID: ${info.id}`));
      console.log(chalk.white(`  Elements: ${info.childCount}`));
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('nodes')
  .description('List nodes on current FigJam page')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-l, --limit <n>', 'Limit number of nodes', '20')
  .action(async (options) => {
    const client = await getFigJamClient(options.page);
    try {
      const nodes = await client.listNodes(parseInt(options.limit));
      if (nodes.length === 0) {
        console.log(chalk.yellow('\n  No elements on this page\n'));
        return;
      }
      console.log(chalk.cyan('\n  FigJam Elements:\n'));
      nodes.forEach(n => {
        const type = n.type.padEnd(16);
        const name = (n.name || '(unnamed)').substring(0, 30);
        console.log(chalk.gray(`  ${n.id.padEnd(8)}`), chalk.white(type), chalk.gray(name), chalk.gray(`(${n.x}, ${n.y})`));
      });
      console.log();
    } finally {
      client.close();
    }
  });

figjam
  .command('sticky <text>')
  .description('Create a sticky note')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-c, --color <hex>', 'Background color')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating sticky note...').start();
    try {
      const result = await client.createSticky(text, parseFloat(options.x), parseFloat(options.y), options.color);
      spinner.succeed(`Sticky created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create sticky: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('shape <text>')
  .description('Create a shape with text')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-w, --width <n>', 'Width', '200')
  .option('-h, --height <n>', 'Height', '100')
  .option('-t, --type <type>', 'Shape type (ROUNDED_RECTANGLE, RECTANGLE, ELLIPSE, DIAMOND)', 'ROUNDED_RECTANGLE')
  .action(async (text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating shape...').start();
    try {
      const result = await client.createShape(
        text,
        parseFloat(options.x),
        parseFloat(options.y),
        parseFloat(options.width),
        parseFloat(options.height),
        options.type
      );
      spinner.succeed(`Shape created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create shape: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('text <content>')
  .description('Create a text node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .option('-x <n>', 'X position', '0')
  .option('-y <n>', 'Y position', '0')
  .option('-s, --size <n>', 'Font size', '16')
  .action(async (content, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating text...').start();
    try {
      const result = await client.createText(content, parseFloat(options.x), parseFloat(options.y), parseFloat(options.size));
      spinner.succeed(`Text created: ${result.id} at (${result.x}, ${result.y})`);
    } catch (error) {
      spinner.fail('Failed to create text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('connect <startId> <endId>')
  .description('Create a connector between two nodes')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (startId, endId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Creating connector...').start();
    try {
      const result = await client.createConnector(startId, endId);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Connector created: ${result.id}`);
      }
    } catch (error) {
      spinner.fail('Failed to create connector: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('delete <nodeId>')
  .description('Delete a node by ID')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Deleting node...').start();
    try {
      const result = await client.deleteNode(nodeId);
      if (result.deleted) {
        spinner.succeed(`Node ${nodeId} deleted`);
      } else {
        spinner.fail(result.error || 'Node not found');
      }
    } catch (error) {
      spinner.fail('Failed to delete node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('move <nodeId> <x> <y>')
  .description('Move a node to a new position')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, x, y, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Moving node...').start();
    try {
      const result = await client.moveNode(nodeId, parseFloat(x), parseFloat(y));
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} moved to (${result.x}, ${result.y})`);
      }
    } catch (error) {
      spinner.fail('Failed to move node: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('update <nodeId> <text>')
  .description('Update text content of a node')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (nodeId, text, options) => {
    const client = await getFigJamClient(options.page);
    const spinner = ora('Updating text...').start();
    try {
      const result = await client.updateText(nodeId, text);
      if (result.error) {
        spinner.fail(result.error);
      } else {
        spinner.succeed(`Node ${result.id} text updated`);
      }
    } catch (error) {
      spinner.fail('Failed to update text: ' + error.message);
    } finally {
      client.close();
    }
  });

figjam
  .command('eval <code>')
  .description('Execute JavaScript in FigJam context')
  .option('-p, --page <title>', 'Page title (partial match)')
  .action(async (code, options) => {
    const client = await getFigJamClient(options.page);
    try {
      const result = await client.eval(code);
      if (result !== undefined) {
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      }
    } catch (error) {
      console.log(chalk.red('Error: ' + error.message));
    } finally {
      client.close();
    }
  });

// List open Figma design files (used by fig-start script)
program
  .command('files')
  .description('List open Figma design files as JSON')
  .action(async () => {
    try {
      const pages = await FigmaClient.listPages();
      // Filter to actual design/board files only (exclude blobs, webpack, feed, tabs)
      const designFiles = pages.filter(p =>
        p.url && (p.url.includes('/design/') || p.url.includes('/board/'))
      );
      console.log(JSON.stringify(designFiles));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });

