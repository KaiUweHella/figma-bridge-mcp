// Commands: analyze (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import {
  program,
  checkConnection,
  fastEval,
  isInSafeMode,
  runFigmaUse
} from '../lib/cli-core.js';

// ============ DESIGN ANALYSIS ============


program
  .command('lint')
  .description('Lint design for issues')
  .option('--fix', 'Auto-fix issues where possible')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      // Safe Mode: native implementation
      const code = `(async () => {
        const issues = [];
        const page = figma.currentPage;

        function checkNode(node, depth = 0) {
          // Check for missing names
          if (node.name.startsWith('Frame') || node.name.startsWith('Rectangle') || node.name.startsWith('Group')) {
            issues.push({ type: 'naming', severity: 'warning', node: node.id, name: node.name, message: 'Generic name, consider renaming' });
          }

          // Check for hardcoded colors (not bound to variables)
          if (node.fills && Array.isArray(node.fills)) {
            const hasFillBinding = node.boundVariables && node.boundVariables.fills;
            if (!hasFillBinding && node.fills.some(f => f.type === 'SOLID')) {
              issues.push({ type: 'color', severity: 'info', node: node.id, name: node.name, message: 'Hardcoded fill color' });
            }
          }

          // Check text for missing styles
          if (node.type === 'TEXT' && !node.textStyleId) {
            issues.push({ type: 'typography', severity: 'info', node: node.id, name: node.name, message: 'Text without style' });
          }

          // Check for tiny text
          if (node.type === 'TEXT' && node.fontSize < 12) {
            issues.push({ type: 'accessibility', severity: 'warning', node: node.id, name: node.name, message: 'Text size < 12px may be hard to read' });
          }

          // Recurse
          if ('children' in node) {
            node.children.forEach(c => checkNode(c, depth + 1));
          }
        }

        page.children.forEach(c => checkNode(c));
        return { total: issues.length, issues: issues.slice(0, 50) }; // Limit output
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan(`\nFound ${result.total} issues:\n`));
          result.issues.forEach(i => {
            const color = i.severity === 'warning' ? chalk.yellow : chalk.gray;
            console.log(color(`  [${i.type}] ${i.name}: ${i.message}`));
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Lint failed: ' + e.message));
      }
    } else {
      // Yolo Mode: use figma-use
      let cmd = 'npx figma-use lint';
      if (options.fix) cmd += ' --fix';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

const analyze = program
  .command('analyze')
  .description('Analyze design (colors, typography, spacing, clusters)');

analyze
  .command('colors')
  .description('Analyze color usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const colors = new Map();
        function rgbToHex(r, g, b) {
          return '#' + [r, g, b].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
        }
        function checkNode(node) {
          if (node.fills && Array.isArray(node.fills)) {
            node.fills.forEach(f => {
              if (f.type === 'SOLID' && f.color) {
                const hex = rgbToHex(f.color.r, f.color.g, f.color.b);
                colors.set(hex, (colors.get(hex) || 0) + 1);
              }
            });
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(colors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([hex, count]) => ({ hex, count }));
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nTop colors used:\n'));
          result.forEach(c => {
            console.log(`  ${chalk.hex(c.hex)('██')} ${c.hex} (${c.count}x)`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze colors';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('typography')
  .alias('type')
  .description('Analyze typography usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const styles = new Map();
        function checkNode(node) {
          if (node.type === 'TEXT') {
            const key = node.fontName.family + '/' + node.fontSize + '/' + node.fontName.style;
            styles.set(key, (styles.get(key) || 0) + 1);
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(styles.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([key, count]) => {
            const [family, size, style] = key.split('/');
            return { family, size: parseInt(size), style, count };
          });
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nTypography usage:\n'));
          result.forEach(t => {
            console.log(`  ${t.family} ${t.size}px ${t.style} (${t.count}x)`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze typography';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('spacing')
  .description('Analyze spacing (gap/padding) usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const gaps = new Map();
        const paddings = new Map();
        function checkNode(node) {
          if (node.layoutMode && node.layoutMode !== 'NONE') {
            if (node.itemSpacing !== undefined) {
              gaps.set(node.itemSpacing, (gaps.get(node.itemSpacing) || 0) + 1);
            }
            const p = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].filter(x => x > 0);
            p.forEach(v => paddings.set(v, (paddings.get(v) || 0) + 1));
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return {
          gaps: Array.from(gaps.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({ value: v, count: c })),
          paddings: Array.from(paddings.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, c]) => ({ value: v, count: c }))
        };
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nGap values:\n'));
          result.gaps.forEach(g => console.log(`  ${g.value}px (${g.count}x)`));
          console.log(chalk.cyan('\nPadding values:\n'));
          result.paddings.forEach(p => console.log(`  ${p.value}px (${p.count}x)`));
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze spacing';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

analyze
  .command('clusters')
  .description('Find repeated patterns (potential components)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    if (await isInSafeMode()) {
      const code = `(async () => {
        const patterns = new Map();
        function getSignature(node) {
          if (node.type === 'FRAME' || node.type === 'GROUP') {
            const childTypes = ('children' in node) ? node.children.map(c => c.type).sort().join(',') : '';
            return node.type + ':' + childTypes;
          }
          return node.type;
        }
        function checkNode(node) {
          if (node.type === 'FRAME' || node.type === 'GROUP') {
            const sig = getSignature(node);
            if (!patterns.has(sig)) patterns.set(sig, []);
            patterns.get(sig).push({ id: node.id, name: node.name });
          }
          if ('children' in node) node.children.forEach(c => checkNode(c));
        }
        figma.currentPage.children.forEach(c => checkNode(c));
        return Array.from(patterns.entries())
          .filter(([_, nodes]) => nodes.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 10)
          .map(([sig, nodes]) => ({ pattern: sig, count: nodes.length, examples: nodes.slice(0, 3) }));
      })()`;

      try {
        const result = await fastEval(code);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.cyan('\nRepeated patterns (potential components):\n'));
          result.forEach(p => {
            console.log(`  ${p.count}x: ${p.examples.map(e => e.name).join(', ')}`);
          });
        }
      } catch (e) {
        console.log(chalk.red('✗ Analyze failed: ' + e.message));
      }
    } else {
      let cmd = 'npx figma-use analyze clusters';
      if (options.json) cmd += ' --json';
      runFigmaUse(cmd);
    }
  });

