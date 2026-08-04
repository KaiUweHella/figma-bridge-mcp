// Commands: analyze (extracted from index.js)
import chalk from 'chalk';
import { join } from 'path';
import {
  program,
  checkConnection,
  fastEval,
  GENERIC_NAME_PATTERNS
} from '../lib/cli-core.js';
import { normalizeNodeId } from '../lib/node-id.js';

// ============ DESIGN ANALYSIS ============


// ============ LINT ============
//
// Rebuilt from the deleted `lint`, with one change that decides whether the
// output is usable at all: an unbound colour is only reported when a local
// variable ALREADY HOLDS THAT EXACT VALUE. The original flagged every solid
// fill in the file as "Hardcoded fill color", which on a real design is
// thousands of lines nobody reads. Reported this way each finding comes with
// the fix — the variable name to pass to `node bind`.
//
// The other checks are the ones a design-system review actually acts on:
// literal layer names, text with no style, text too small to read.
// `analyze colors|typography|spacing` still give the full census; this is the
// single pass that says whether anything needs doing.

/** Build the lint eval. Pure; exported so tests can parse it. */
export function lintCode({ rootId, generic }) {
  return `(async () => {
  ${rootId
    ? `const root = await figma.getNodeByIdAsync(${JSON.stringify(rootId)});
       if (!root) return { error: 'Node not found: ${rootId}' };
       const roots = [root];`
    : 'const roots = figma.currentPage.children.slice();'}

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const allVars = await figma.variables.getLocalVariablesAsync();
  const colName = (v) => {
    const c = collections.find(c => c.id === v.variableCollectionId);
    return c ? c.name : '(unknown)';
  };

  // value → variable, for COLOR variables only. Keyed on the rounded RGB of
  // each mode's value, so a token defined per-theme is matched in any of them.
  const byColor = new Map();
  const key = (c) => [c.r, c.g, c.b].map(n => Math.round(n * 255)).join(',');
  for (const v of allVars) {
    if (v.resolvedType !== 'COLOR') continue;
    for (const val of Object.values(v.valuesByMode || {})) {
      if (!val || typeof val !== 'object' || typeof val.r !== 'number') continue; // skip aliases
      const k = key(val);
      if (!byColor.has(k)) byColor.set(k, v);
    }
  }

  const GENERIC = new Set(${JSON.stringify(generic)});
  const issues = [];
  const seen = new Set();

  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);

    // A literal type name, alone or with Figma's auto-numbering ("Frame 12").
    // NOT a prefix test: "Frame Header" is a deliberate name.
    const bare = String(n.name).trim().replace(/\\s+\\d+$/, '').toLowerCase();
    if (GENERIC.has(bare)) {
      issues.push({ kind: 'naming', id: n.id, name: n.name, type: n.type,
                    detail: 'still carries its default layer name' });
    }

    for (const [prop, field] of [['fill', 'fills'], ['stroke', 'strokes']]) {
      const paints = n[field];
      if (!Array.isArray(paints)) continue;
      for (const p of paints) {
        if (!p || p.type !== 'SOLID' || p.visible === false) continue;
        if (p.boundVariables && p.boundVariables.color) continue;   // already bound
        const match = byColor.get(key(p.color));
        if (!match) continue;                                        // not a token colour — nothing to say
        issues.push({ kind: 'bindable', id: n.id, name: n.name, type: n.type,
                      detail: prop + ' is #' + [p.color.r, p.color.g, p.color.b]
                        .map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
                        + ', which is ' + match.name,
                      fix: 'node bind ' + n.id + ' ' + prop + ' ' + JSON.stringify(match.name)
                           + ' --collection ' + JSON.stringify(colName(match)) });
      }
    }

    if (n.type === 'TEXT') {
      if (!n.textStyleId) {
        issues.push({ kind: 'typography', id: n.id, name: n.name, type: n.type,
                      detail: 'no text style — its typography is loose' });
      }
      const size = typeof n.fontSize === 'number' ? n.fontSize : null;
      if (size !== null && size < 12) {
        issues.push({ kind: 'legibility', id: n.id, name: n.name, type: n.type,
                      detail: size + 'px is below the 12px readability floor' });
      }
    }

    if ('children' in n && n.children) for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);

  const counts = {};
  for (const i of issues) counts[i.kind] = (counts[i.kind] || 0) + 1;
  return { nodesWalked: seen.size, total: issues.length, counts, issues };
})()`;
}

const LINT_KINDS = {
  bindable:   { label: 'unbound token colour', color: 'yellow' },
  naming:     { label: 'default layer name',   color: 'gray' },
  typography: { label: 'text without a style', color: 'gray' },
  legibility: { label: 'text under 12px',      color: 'yellow' },
};

const analyze = program
  .command('analyze')
  .description('Analyze design (colors, typography, spacing, clusters)');

analyze
  .command('colors')
  .description('Analyze color usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
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
    }
  });

analyze
  .command('typography')
  .alias('type')
  .description('Analyze typography usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
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
    }
  });

analyze
  .command('spacing')
  .description('Analyze spacing (gap/padding) usage')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
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
    }
  });

analyze
  .command('clusters')
  .description('Find repeated patterns (potential components)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await checkConnection();

    // Plugin bridge is the only execution path in the Safe-Mode build.
    {
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
    }
  });

analyze
  .command('lint')
  .description('One pass over a subtree for the things a design-system review acts on: colours that match an existing variable but are not bound, default layer names, text without a style, text under 12px. `analyze colors|typography|spacing` give the full census; this says whether anything needs doing.')
  .option('-n, --node <id>', 'Root node (default: the whole current page)')
  .option('--kind <kinds>', 'Comma-separated subset: ' + Object.keys(LINT_KINDS).join(', '))
  .option('--limit <n>', 'How many findings to print per kind', '10')
  .option('--json', 'Machine-readable output (never truncated)')
  .option('--fail-on-issues', 'Exit 1 when anything is found — for CI')
  .action(async (options) => {
    await checkConnection();

    let kinds = Object.keys(LINT_KINDS);
    if (options.kind) {
      kinds = String(options.kind).split(',').map(s => s.trim()).filter(Boolean);
      const unknown = kinds.filter(k => !(k in LINT_KINDS));
      if (unknown.length) {
        console.error(chalk.red('✗'), `unknown kind(s): ${unknown.join(', ')}. Known: ${Object.keys(LINT_KINDS).join(', ')}`);
        process.exit(1);
      }
    }
    const limit = Math.max(1, parseInt(options.limit, 10) || 10);

    const code = lintCode({
      rootId: options.node ? normalizeNodeId(String(options.node)).id : null,
      generic: [...GENERIC_NAME_PATTERNS],
    });

    try {
      const r = await fastEval(code);
      if (r.error) {
        console.error(chalk.red('✗'), r.error);
        process.exit(1);
      }
      const wanted = r.issues.filter(i => kinds.includes(i.kind));

      if (options.json) {
        console.log(JSON.stringify({ ...r, issues: wanted }, null, 2));
      } else if (wanted.length === 0) {
        console.log(chalk.green('✓') + ` Nothing to fix across ${r.nodesWalked} node(s).`);
      } else {
        console.log(chalk.cyan(`${wanted.length} finding(s) across ${r.nodesWalked} node(s):`));
        for (const kind of kinds) {
          const group = wanted.filter(i => i.kind === kind);
          if (!group.length) continue;
          const meta = LINT_KINDS[kind];
          console.log(chalk[meta.color](`\n  ${meta.label} — ${group.length}`));
          for (const i of group.slice(0, limit)) {
            console.log(`    ${i.id.padEnd(10)} ${i.name}` + chalk.gray(`  ${i.detail}`));
            if (i.fix) console.log(chalk.gray(`      fix: ${i.fix}`));
          }
          if (group.length > limit) {
            console.log(chalk.gray(`    … ${group.length - limit} more (--limit ${group.length} to see them, or --json)`));
          }
        }
      }
      if (options.failOnIssues && wanted.length > 0) process.exitCode = 1;
    } catch (e) {
      console.error(chalk.red('✗ Lint failed: ' + e.message));
      process.exit(1);
    }
  });
