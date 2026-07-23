// Commands: a11y (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import {
  program,
  checkConnection,
  fastEval
} from '../lib/cli-core.js';

// ============ ACCESSIBILITY (a11y) ============

const a11y = program
  .command('a11y')
  .description('Accessibility checks (contrast, vision, touch targets, audit)');

a11y
  .command('contrast [nodeId]')
  .description('Check WCAG contrast ratios for all text/background pairs')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const level = options.level.toUpperCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }

      function contrastRatio(l1, l2) {
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      function getSolidColor(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              const o = fill.opacity !== undefined ? fill.opacity : 1;
              return { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: o };
            }
          }
        }
        return null;
      }

      function getBgColor(node) {
        let current = node.parent;
        while (current) {
          const color = getSolidColor(current);
          if (color && color.a > 0.01) return color;
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1, a: 1 };
      }

      function blendOnWhite(fg, bg) {
        const a = fg.a;
        return {
          r: fg.r * a + bg.r * (1 - a),
          g: fg.g * a + bg.g * (1 - a),
          b: fg.b * a + bg.b * (1 - a)
        };
      }

      function toHex(c) {
        const r = Math.round(c.r * 255).toString(16).padStart(2, '0');
        const g = Math.round(c.g * 255).toString(16).padStart(2, '0');
        const b = Math.round(c.b * 255).toString(16).padStart(2, '0');
        return '#' + r + g + b;
      }

      const results = [];

      function traverse(node) {
        if (node.type === 'TEXT' && node.visible !== false) {
          const textColor = getSolidColor(node);
          if (!textColor) return;
          const bgColor = getBgColor(node);
          const fg = blendOnWhite(textColor, { r: 1, g: 1, b: 1 });
          const bg = blendOnWhite(bgColor, { r: 1, g: 1, b: 1 });
          const l1 = luminance(fg.r, fg.g, fg.b);
          const l2 = luminance(bg.r, bg.g, bg.b);
          const ratio = contrastRatio(l1, l2);
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 16;
          const fontWeight = node.fontWeight || 400;
          const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
          const aaPass = isLarge ? ratio >= 3 : ratio >= 4.5;
          const aaaPass = isLarge ? ratio >= 4.5 : ratio >= 7;
          results.push({
            id: node.id,
            name: node.name,
            text: node.characters ? node.characters.substring(0, 50) : '',
            fontSize: fontSize,
            isLarge: isLarge,
            fgColor: toHex(fg),
            bgColor: toHex(bg),
            ratio: Math.round(ratio * 100) / 100,
            aa: aaPass,
            aaa: aaaPass
          });
        }
        if ('children' in node) {
          for (const child of node.children) {
            if (child.visible !== false) traverse(child);
          }
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      } else {
        traverse(root);
      }

      const level = "${level}";
      const passing = results.filter(r => level === 'AAA' ? r.aaa : r.aa);
      const failing = results.filter(r => level === 'AAA' ? !r.aaa : !r.aa);
      return { level, total: results.length, passing: passing.length, failing: failing.length, issues: failing, all: results };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Contrast Check (WCAG ${result.level})\n`));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Fail:')} ${result.failing}/${result.total}\n`);

      if (result.issues.length > 0) {
        console.log(chalk.red('  Failing elements:\n'));
        result.issues.forEach(issue => {
          const ratioStr = issue.ratio.toFixed(2) + ':1';
          const needed = issue.isLarge ? (result.level === 'AAA' ? '4.5:1' : '3:1') : (result.level === 'AAA' ? '7:1' : '4.5:1');
          console.log(`  ${chalk.red('✗')} ${chalk.white(issue.name)} ${chalk.gray('- "' + issue.text + '"')}`);
          console.log(`    ${chalk.gray('Ratio:')} ${chalk.yellow(ratioStr)} ${chalk.gray('(need ' + needed + ')')}  ${chalk.gray('FG:')} ${issue.fgColor}  ${chalk.gray('BG:')} ${issue.bgColor}  ${chalk.gray('Size:')} ${issue.fontSize}px${issue.isLarge ? ' (large)' : ''}`);
          console.log(`    ${chalk.gray('ID:')} ${issue.id}\n`);
        });
      } else {
        console.log(chalk.green('  All text passes WCAG ' + result.level + '! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Contrast check failed: ' + e.message));
    }
  });

a11y
  .command('vision [nodeId]')
  .description('Simulate color blindness (protanopia, deuteranopia, tritanopia, achromatopsia)')
  .option('--type <type>', 'Type: protanopia, deuteranopia, tritanopia, achromatopsia, all', 'all')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const simType = options.type.toLowerCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage.selection[0];
      if (!root) return { error: 'Select a frame or provide a node ID' };

      // Color blindness simulation matrices (Brettel/Vienot models)
      const matrices = {
        protanopia: [
          0.152286, 1.052583, -0.204868,
          0.114503, 0.786281, 0.099216,
          -0.003882, -0.048116, 1.051998
        ],
        deuteranopia: [
          0.367322, 0.860646, -0.227968,
          0.280085, 0.672501, 0.047413,
          -0.011820, 0.042940, 0.968881
        ],
        tritanopia: [
          1.255528, -0.076749, -0.178779,
          -0.078411, 0.930809, 0.147602,
          0.004733, 0.691367, 0.303900
        ],
        achromatopsia: [
          0.2126, 0.7152, 0.0722,
          0.2126, 0.7152, 0.0722,
          0.2126, 0.7152, 0.0722
        ]
      };

      function applyMatrix(r, g, b, matrix) {
        return {
          r: Math.max(0, Math.min(1, matrix[0] * r + matrix[1] * g + matrix[2] * b)),
          g: Math.max(0, Math.min(1, matrix[3] * r + matrix[4] * g + matrix[5] * b)),
          b: Math.max(0, Math.min(1, matrix[6] * r + matrix[7] * g + matrix[8] * b))
        };
      }

      function toHex(c) {
        const r = Math.round(c.r * 255).toString(16).padStart(2, '0');
        const g = Math.round(c.g * 255).toString(16).padStart(2, '0');
        const b = Math.round(c.b * 255).toString(16).padStart(2, '0');
        return '#' + r + g + b;
      }

      const types = "${simType}" === 'all' ? Object.keys(matrices) : ["${simType}"];
      if (!types.every(t => matrices[t])) return { error: 'Unknown type. Use: protanopia, deuteranopia, tritanopia, achromatopsia, all' };

      // Collect all unique colors used in the selection
      const colorMap = new Map();
      function collectColors(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              const hex = toHex(fill.color);
              if (!colorMap.has(hex)) colorMap.set(hex, { ...fill.color });
            }
          }
        }
        if (node.strokes && Array.isArray(node.strokes)) {
          for (const stroke of node.strokes) {
            if (stroke.type === 'SOLID' && stroke.visible !== false) {
              const hex = toHex(stroke.color);
              if (!colorMap.has(hex)) colorMap.set(hex, { ...stroke.color });
            }
          }
        }
        if ('children' in node) {
          for (const child of node.children) collectColors(child);
        }
      }
      collectColors(root);

      // Simulate each type
      const simulations = {};
      for (const type of types) {
        const matrix = matrices[type];
        const colors = [];
        for (const [hex, color] of colorMap) {
          const sim = applyMatrix(color.r, color.g, color.b, matrix);
          colors.push({ original: hex, simulated: toHex(sim) });
        }
        // Find confusable pairs (colors that become too similar after simulation)
        const confusable = [];
        const entries = Array.from(colorMap.entries());
        for (let i = 0; i < entries.length; i++) {
          for (let j = i + 1; j < entries.length; j++) {
            const [hex1, c1] = entries[i];
            const [hex2, c2] = entries[j];
            const s1 = applyMatrix(c1.r, c1.g, c1.b, matrix);
            const s2 = applyMatrix(c2.r, c2.g, c2.b, matrix);
            const diff = Math.sqrt(
              Math.pow(s1.r - s2.r, 2) + Math.pow(s1.g - s2.g, 2) + Math.pow(s1.b - s2.b, 2)
            );
            if (diff < 0.05 && Math.sqrt(
              Math.pow(c1.r - c2.r, 2) + Math.pow(c1.g - c2.g, 2) + Math.pow(c1.b - c2.b, 2)
            ) > 0.1) {
              confusable.push({ color1: hex1, color2: hex2, simulated1: toHex(s1), simulated2: toHex(s2) });
            }
          }
        }
        simulations[type] = { colors, confusable };
      }

      // Create visual simulation copies
      const clones = [];
      const rootX = root.x;
      const rootWidth = root.width;
      let offsetX = rootX + rootWidth + 100;

      for (const type of types) {
        const clone = root.clone();
        clone.name = root.name + ' (' + type.charAt(0).toUpperCase() + type.slice(1) + ')';
        clone.x = offsetX;
        clone.y = root.y;

        function transformColors(node) {
          const matrix = matrices[type];
          if (node.fills && Array.isArray(node.fills)) {
            const newFills = node.fills.map(fill => {
              if (fill.type === 'SOLID' && fill.visible !== false) {
                const sim = applyMatrix(fill.color.r, fill.color.g, fill.color.b, matrix);
                return { ...fill, color: { r: sim.r, g: sim.g, b: sim.b } };
              }
              return fill;
            });
            node.fills = newFills;
          }
          if (node.strokes && Array.isArray(node.strokes)) {
            const newStrokes = node.strokes.map(stroke => {
              if (stroke.type === 'SOLID' && stroke.visible !== false) {
                const sim = applyMatrix(stroke.color.r, stroke.color.g, stroke.color.b, matrix);
                return { ...stroke, color: { r: sim.r, g: sim.g, b: sim.b } };
              }
              return stroke;
            });
            node.strokes = newStrokes;
          }
          if ('children' in node) {
            for (const child of node.children) transformColors(child);
          }
        }
        transformColors(clone);
        clones.push({ id: clone.id, name: clone.name, type });
        offsetX += rootWidth + 60;
      }

      return { original: root.name, totalColors: colorMap.size, types, simulations, clones };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Color Blindness Simulation\n'));
      console.log(`  Source: ${chalk.white(result.original)} (${result.totalColors} unique colors)\n`);
      console.log('  Created simulation copies:\n');

      for (const clone of result.clones) {
        const sim = result.simulations[clone.type];
        const issues = sim.confusable.length;
        const icon = issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
        console.log(`  ${icon} ${chalk.white(clone.name)}`);
        if (issues > 0) {
          console.log(`    ${chalk.yellow(issues + ' confusable color pair(s):')}`);
          sim.confusable.forEach(pair => {
            console.log(`    ${pair.color1} ↔ ${pair.color2} → both appear as ~${pair.simulated1}`);
          });
        } else {
          console.log(`    ${chalk.green('No confusable colors')}`);
        }
        console.log(`    ${chalk.gray('ID: ' + clone.id)}\n`);
      }
    } catch (e) {
      console.log(chalk.red('✗ Vision simulation failed: ' + e.message));
    }
  });

a11y
  .command('touch [nodeId]')
  .description('Check touch target sizes (WCAG 2.5.8: min 24x24, recommended 44x44)')
  .option('--min <size>', 'Minimum target size in px', '44')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const minSize = parseInt(options.min) || 44;
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const minSize = ${minSize};
      const results = [];
      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;

      function traverse(node) {
        if (node.visible === false) return;
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );

        if (isInteractive) {
          const w = Math.round(node.width);
          const h = Math.round(node.height);
          const pass = w >= minSize && h >= minSize;
          const wcag248 = w >= 24 && h >= 24;
          results.push({
            id: node.id,
            name: node.name,
            type: node.type,
            width: w,
            height: h,
            pass: pass,
            wcag248: wcag248,
            issue: !pass ? (w < minSize && h < minSize ? 'both' : w < minSize ? 'width' : 'height') : null
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const passing = results.filter(r => r.pass);
      const failing = results.filter(r => !r.pass);
      const critical = results.filter(r => !r.wcag248);
      return { minSize, total: results.length, passing: passing.length, failing: failing.length, critical: critical.length, issues: failing };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan(`\n  Touch Target Check (min ${result.minSize}x${result.minSize}px)\n`));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Fail:')} ${result.failing}/${result.total}   ${chalk.red('⚠ Critical (<24px):')} ${result.critical}\n`);

      if (result.issues.length > 0) {
        console.log(chalk.red('  Undersized targets:\n'));
        result.issues.forEach(issue => {
          const icon = !issue.wcag248 ? chalk.red('⚠') : chalk.yellow('✗');
          const sizeStr = `${issue.width}x${issue.height}px`;
          console.log(`  ${icon} ${chalk.white(issue.name)} ${chalk.gray('(' + issue.type + ')')}  ${chalk.yellow(sizeStr)}  ${chalk.gray('ID: ' + issue.id)}`);
        });
        console.log('');
      } else {
        console.log(chalk.green('  All interactive elements meet minimum size! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Touch target check failed: ' + e.message));
    }
  });

a11y
  .command('text [nodeId]')
  .description('Check text accessibility (min sizes, line height, paragraph spacing)')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const results = [];

      function traverse(node) {
        if (node.visible === false) return;
        if (node.type === 'TEXT') {
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : null;
          const lineHeight = node.lineHeight;
          let lineHeightValue = null;
          let lineHeightRatio = null;

          if (lineHeight && lineHeight.unit === 'PIXELS') {
            lineHeightValue = lineHeight.value;
            if (fontSize) lineHeightRatio = lineHeight.value / fontSize;
          } else if (lineHeight && lineHeight.unit === 'PERCENT') {
            lineHeightRatio = lineHeight.value / 100;
            if (fontSize) lineHeightValue = fontSize * lineHeightRatio;
          }

          const issues = [];

          // WCAG 1.4.4: text should be readable
          if (fontSize && fontSize < 12) {
            issues.push({ rule: 'min-size', message: 'Font size < 12px (hard to read)', severity: 'error' });
          } else if (fontSize && fontSize < 14) {
            issues.push({ rule: 'min-size', message: 'Font size < 14px (consider increasing for body text)', severity: 'warning' });
          }

          // WCAG 1.4.12: line height >= 1.5x for body text
          if (fontSize && fontSize <= 18 && lineHeightRatio && lineHeightRatio < 1.5) {
            issues.push({ rule: 'line-height', message: 'Line height < 1.5x for body text (WCAG 1.4.12)', severity: 'warning' });
          }

          // WCAG 1.4.12: paragraph spacing >= 2x font size
          if (node.paragraphSpacing !== undefined && fontSize) {
            if (node.paragraphSpacing > 0 && node.paragraphSpacing < fontSize * 2) {
              issues.push({ rule: 'paragraph-spacing', message: 'Paragraph spacing < 2x font size (WCAG 1.4.12)', severity: 'warning' });
            }
          }

          // WCAG 1.4.12: letter spacing >= 0.12x font size
          if (node.letterSpacing && node.letterSpacing.unit === 'PIXELS' && fontSize) {
            if (node.letterSpacing.value < fontSize * 0.12 && node.letterSpacing.value !== 0) {
              issues.push({ rule: 'letter-spacing', message: 'Letter spacing < 0.12x font size (WCAG 1.4.12)', severity: 'warning' });
            }
          }

          // Check for ALL CAPS on long text (readability concern)
          if (node.textCase === 'UPPER' && node.characters && node.characters.length > 20) {
            issues.push({ rule: 'all-caps', message: 'Long ALL CAPS text (> 20 chars) reduces readability', severity: 'warning' });
          }

          results.push({
            id: node.id,
            name: node.name,
            text: node.characters ? node.characters.substring(0, 40) : '',
            fontSize: fontSize,
            lineHeight: lineHeightValue ? Math.round(lineHeightValue * 10) / 10 : null,
            lineHeightRatio: lineHeightRatio ? Math.round(lineHeightRatio * 100) / 100 : null,
            issues: issues
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const withIssues = results.filter(r => r.issues.length > 0);
      const errors = withIssues.filter(r => r.issues.some(i => i.severity === 'error'));
      const warnings = withIssues.filter(r => r.issues.some(i => i.severity === 'warning') && !r.issues.some(i => i.severity === 'error'));
      return { total: results.length, errors: errors.length, warnings: warnings.length, passing: results.length - withIssues.length, issues: withIssues };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Text Accessibility Check\n'));
      console.log(`  ${chalk.green('✓ Pass:')} ${result.passing}/${result.total}   ${chalk.red('✗ Errors:')} ${result.errors}   ${chalk.yellow('⚠ Warnings:')} ${result.warnings}\n`);

      if (result.issues.length > 0) {
        result.issues.forEach(item => {
          const icon = item.issues.some(i => i.severity === 'error') ? chalk.red('✗') : chalk.yellow('⚠');
          console.log(`  ${icon} ${chalk.white(item.name)} ${chalk.gray('- "' + item.text + '"')}  ${chalk.gray(item.fontSize + 'px')}${item.lineHeightRatio ? chalk.gray(' / ' + item.lineHeightRatio + 'x') : ''}`);
          item.issues.forEach(issue => {
            const color = issue.severity === 'error' ? chalk.red : chalk.yellow;
            console.log(`    ${color(issue.message)}`);
          });
          console.log(`    ${chalk.gray('ID: ' + item.id)}\n`);
        });
      } else {
        console.log(chalk.green('  All text passes accessibility checks! ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Text check failed: ' + e.message));
    }
  });

a11y
  .command('focus [nodeId]')
  .description('Show reading/focus order of interactive elements')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage.selection[0] || figma.currentPage;
      if (!root) return { error: 'Node not found' };

      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;
      const elements = [];

      function getAbsolutePosition(node) {
        let x = node.x, y = node.y;
        let current = node.parent;
        while (current && current.type !== 'PAGE') {
          x += current.x;
          y += current.y;
          current = current.parent;
        }
        return { x, y };
      }

      function traverse(node) {
        if (node.visible === false) return;
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );
        const isText = node.type === 'TEXT';

        if (isInteractive || isText) {
          const pos = getAbsolutePosition(node);
          elements.push({
            id: node.id,
            name: node.name,
            type: node.type,
            role: isInteractive ? 'interactive' : 'text',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            width: Math.round(node.width),
            height: Math.round(node.height)
          });
        }
        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      // Sort by reading order: top-to-bottom, then left-to-right (with 20px row tolerance)
      elements.sort((a, b) => {
        const rowDiff = Math.abs(a.y - b.y);
        if (rowDiff < 20) return a.x - b.x;
        return a.y - b.y;
      });

      // Add order numbers
      let interactiveOrder = 0;
      elements.forEach(el => {
        if (el.role === 'interactive') {
          interactiveOrder++;
          el.tabOrder = interactiveOrder;
        }
      });

      // Check for reading order issues
      const issues = [];
      for (let i = 1; i < elements.length; i++) {
        const prev = elements[i - 1];
        const curr = elements[i];
        // Check if visual order matches DOM order (large backward jumps)
        if (curr.y < prev.y - 50 && curr.role === 'interactive' && prev.role === 'interactive') {
          issues.push({
            element: curr.name,
            message: 'May be reached before visually higher element "' + prev.name + '"',
            severity: 'warning'
          });
        }
      }

      const interactive = elements.filter(e => e.role === 'interactive');
      return { total: elements.length, interactive: interactive.length, order: elements, issues };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.cyan('\n  Focus / Reading Order\n'));
      console.log(`  Total elements: ${result.total}   Interactive: ${result.interactive}\n`);

      let tabIdx = 0;
      result.order.forEach(el => {
        if (el.role === 'interactive') {
          tabIdx++;
          console.log(`  ${chalk.cyan(String(tabIdx).padStart(3))}  ${chalk.white(el.name)} ${chalk.gray('(' + el.type + ')')}  ${chalk.gray('at ' + el.x + ',' + el.y)}  ${chalk.gray(el.width + 'x' + el.height + 'px')}`);
        } else {
          console.log(`  ${chalk.gray('  -')}  ${chalk.gray(el.name)}  ${chalk.gray('at ' + el.x + ',' + el.y)}`);
        }
      });

      if (result.issues.length > 0) {
        console.log(chalk.yellow('\n  Potential order issues:\n'));
        result.issues.forEach(issue => {
          console.log(`  ${chalk.yellow('⚠')} ${issue.message}`);
        });
      }
      console.log('');
    } catch (e) {
      console.log(chalk.red('✗ Focus order check failed: ' + e.message));
    }
  });

a11y
  .command('audit [nodeId]')
  .description('Full accessibility audit (contrast + touch targets + text + focus order)')
  .option('--level <level>', 'WCAG level: AA or AAA', 'AA')
  .option('--json', 'Output as JSON')
  .action(async (nodeId, options) => {
    await checkConnection();
    const level = options.level.toUpperCase();
    const code = `(async () => {
      const targetId = ${nodeId ? `"${nodeId}"` : 'null'};
      const root = targetId ? await figma.getNodeByIdAsync(targetId) : figma.currentPage;
      if (!root) return { error: 'Node not found' };

      // --- Helpers ---
      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function contrastRatio(l1, l2) {
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function getSolidColor(node) {
        if (node.fills && Array.isArray(node.fills)) {
          for (const fill of node.fills) {
            if (fill.type === 'SOLID' && fill.visible !== false) {
              return { r: fill.color.r, g: fill.color.g, b: fill.color.b, a: fill.opacity !== undefined ? fill.opacity : 1 };
            }
          }
        }
        return null;
      }
      function getBgColor(node) {
        let current = node.parent;
        while (current) {
          const color = getSolidColor(current);
          if (color && color.a > 0.01) return color;
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1, a: 1 };
      }
      function toHex(c) {
        return '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
      }

      const interactivePatterns = /button|btn|link|tab|toggle|switch|checkbox|radio|input|select|dropdown|menu|icon-btn|close|nav|click|tap|cta/i;
      const level = "${level}";
      const issues = [];
      let textCount = 0, interactiveCount = 0;

      function traverse(node) {
        if (node.visible === false) return;

        // Contrast check
        if (node.type === 'TEXT') {
          textCount++;
          const textColor = getSolidColor(node);
          if (textColor) {
            const bgColor = getBgColor(node);
            const l1 = luminance(textColor.r * textColor.a + (1 - textColor.a), textColor.g * textColor.a + (1 - textColor.a), textColor.b * textColor.a + (1 - textColor.a));
            const l2 = luminance(bgColor.r, bgColor.g, bgColor.b);
            const ratio = contrastRatio(l1, l2);
            const fontSize = typeof node.fontSize === 'number' ? node.fontSize : 16;
            const fontWeight = node.fontWeight || 400;
            const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
            const aaReq = isLarge ? 3 : 4.5;
            const aaaReq = isLarge ? 4.5 : 7;
            const req = level === 'AAA' ? aaaReq : aaReq;
            if (ratio < req) {
              issues.push({
                category: 'contrast',
                severity: ratio < (isLarge ? 3 : 4.5) ? 'error' : 'warning',
                id: node.id,
                name: node.name,
                message: 'Contrast ' + ratio.toFixed(2) + ':1 (need ' + req + ':1)',
                details: { ratio: Math.round(ratio * 100) / 100, required: req, fg: toHex(textColor), bg: toHex(bgColor), fontSize }
              });
            }
          }

          // Text size
          const fontSize = typeof node.fontSize === 'number' ? node.fontSize : null;
          if (fontSize && fontSize < 12) {
            issues.push({ category: 'text', severity: 'error', id: node.id, name: node.name, message: 'Font size ' + fontSize + 'px < 12px minimum' });
          }

          // Line height
          if (fontSize && fontSize <= 18 && node.lineHeight) {
            let ratio = null;
            if (node.lineHeight.unit === 'PIXELS') ratio = node.lineHeight.value / fontSize;
            else if (node.lineHeight.unit === 'PERCENT') ratio = node.lineHeight.value / 100;
            if (ratio && ratio < 1.5) {
              issues.push({ category: 'text', severity: 'warning', id: node.id, name: node.name, message: 'Line height ' + (ratio).toFixed(2) + 'x < 1.5x (WCAG 1.4.12)' });
            }
          }

          // ALL CAPS
          if (node.textCase === 'UPPER' && node.characters && node.characters.length > 20) {
            issues.push({ category: 'text', severity: 'warning', id: node.id, name: node.name, message: 'Long ALL CAPS text reduces readability' });
          }
        }

        // Touch targets
        const isInteractive = (
          node.type === 'INSTANCE' ||
          node.type === 'COMPONENT' ||
          interactivePatterns.test(node.name) ||
          (node.reactions && node.reactions.length > 0)
        );
        if (isInteractive) {
          interactiveCount++;
          const w = Math.round(node.width);
          const h = Math.round(node.height);
          if (w < 24 || h < 24) {
            issues.push({ category: 'touch', severity: 'error', id: node.id, name: node.name, message: 'Touch target ' + w + 'x' + h + 'px < 24x24 minimum (WCAG 2.5.8)' });
          } else if (w < 44 || h < 44) {
            issues.push({ category: 'touch', severity: 'warning', id: node.id, name: node.name, message: 'Touch target ' + w + 'x' + h + 'px < 44x44 recommended' });
          }
        }

        if ('children' in node) {
          for (const child of node.children) traverse(child);
        }
      }

      if ('children' in root) {
        for (const child of root.children) traverse(child);
      }

      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warning');
      const contrastIssues = issues.filter(i => i.category === 'contrast');
      const textIssues = issues.filter(i => i.category === 'text');
      const touchIssues = issues.filter(i => i.category === 'touch');

      const score = issues.length === 0 ? 'A+' : errors.length === 0 ? 'B' : errors.length <= 3 ? 'C' : 'D';

      return {
        score,
        level,
        summary: { textNodes: textCount, interactiveElements: interactiveCount, errors: errors.length, warnings: warnings.length },
        breakdown: {
          contrast: { issues: contrastIssues.length, errors: contrastIssues.filter(i => i.severity === 'error').length },
          text: { issues: textIssues.length, errors: textIssues.filter(i => i.severity === 'error').length },
          touch: { issues: touchIssues.length, errors: touchIssues.filter(i => i.severity === 'error').length }
        },
        issues
      };
    })()`;

    try {
      const result = await fastEval(code);
      if (result.error) { console.log(chalk.red('✗ ' + result.error)); return; }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const scoreColor = result.score === 'A+' ? chalk.green : result.score === 'B' ? chalk.yellow : chalk.red;

      console.log(chalk.cyan(`\n  Accessibility Audit (WCAG ${result.level})\n`));
      console.log(`  Score: ${scoreColor(result.score)}   ${chalk.gray('(' + result.summary.textNodes + ' text nodes, ' + result.summary.interactiveElements + ' interactive elements)')}\n`);

      // Breakdown
      const bd = result.breakdown;
      const contrastIcon = bd.contrast.errors > 0 ? chalk.red('✗') : bd.contrast.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
      const textIcon = bd.text.errors > 0 ? chalk.red('✗') : bd.text.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');
      const touchIcon = bd.touch.errors > 0 ? chalk.red('✗') : bd.touch.issues > 0 ? chalk.yellow('⚠') : chalk.green('✓');

      console.log(`  ${contrastIcon} Contrast     ${bd.contrast.issues === 0 ? chalk.green('Pass') : chalk.red(bd.contrast.errors + ' errors') + (bd.contrast.issues - bd.contrast.errors > 0 ? ', ' + chalk.yellow((bd.contrast.issues - bd.contrast.errors) + ' warnings') : '')}`);
      console.log(`  ${textIcon} Text         ${bd.text.issues === 0 ? chalk.green('Pass') : chalk.red(bd.text.errors + ' errors') + (bd.text.issues - bd.text.errors > 0 ? ', ' + chalk.yellow((bd.text.issues - bd.text.errors) + ' warnings') : '')}`);
      console.log(`  ${touchIcon} Touch Target ${bd.touch.issues === 0 ? chalk.green('Pass') : chalk.red(bd.touch.errors + ' errors') + (bd.touch.issues - bd.touch.errors > 0 ? ', ' + chalk.yellow((bd.touch.issues - bd.touch.errors) + ' warnings') : '')}`);

      if (result.issues.length > 0) {
        console.log(chalk.red('\n  Issues:\n'));
        // Group by category
        const categories = ['contrast', 'text', 'touch'];
        const categoryLabels = { contrast: 'Contrast', text: 'Text', touch: 'Touch Targets' };
        for (const cat of categories) {
          const catIssues = result.issues.filter(i => i.category === cat);
          if (catIssues.length === 0) continue;
          console.log(chalk.white('  ' + categoryLabels[cat] + ':\n'));
          catIssues.forEach(issue => {
            const icon = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
            console.log(`  ${icon} ${chalk.white(issue.name)} - ${issue.message}  ${chalk.gray('ID: ' + issue.id)}`);
          });
          console.log('');
        }
      } else {
        console.log(chalk.green('\n  Perfect score! No accessibility issues found. ✓\n'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Audit failed: ' + e.message));
    }
  });

