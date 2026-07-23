// Command: spec — read the authoritative spec for a component out of an
// extracted DESIGN.md (axes, sizes) and optionally ENFORCE it against a built
// node. All markdown reading happens here in code, so checking conformance
// costs zero LLM tokens — the CLI returns a compact digest / verdict, not the
// 600-line structure dump.
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { program, checkConnection, fastEval } from '../lib/cli-core.js';
import { findComponentSpec, checkConformance, formatReuseDigest } from '../lib/design-spec.js';
import { locateDesignMd } from '../lib/design-md-locate.js';

// Measure a built node for conformance: type, variant property names, each
// variant's name + size, and a DEEP tree (layout/gap/padding/children) of the
// variant that matches the spec sample — so every md instruction can be checked.
function measureCode(nodeId, sampleName) {
  return `(async () => {
    const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
    if (!n) return { error: 'node not found' };
    const tree = (node, depth) => {
      const o = { name: node.name, type: node.type, w: Math.round(node.width || 0), h: Math.round(node.height || 0) };
      if ('layoutMode' in node && node.layoutMode !== 'NONE') {
        o.lm = node.layoutMode;
        o.gap = node.itemSpacing || 0;
        o.pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
      }
      if (depth > 0 && 'children' in node && node.children.length) o.children = node.children.map(c => tree(c, depth - 1));
      return o;
    };
    const norm = s => String(s).replace(/\\s+/g, '').toLowerCase().split(',').sort().join(',');
    const out = { type: n.type, name: n.name };
    if (n.type === 'COMPONENT_SET') {
      out.variantProps = Object.keys(n.variantGroupProperties || {});
      out.variants = n.children.map(c => ({ name: c.name, w: Math.round(c.width), h: Math.round(c.height) }));
      const want = ${JSON.stringify(sampleName || '')};
      const match = want ? n.children.find(c => norm(c.name) === norm(want)) : n.children[0];
      if (match) out.sampleTree = tree(match, 6);
    } else {
      out.variants = [{ name: n.name, w: Math.round(n.width || 0), h: Math.round(n.height || 0) }];
      out.sampleTree = tree(n, 6);
    }
    return out;
  })()`;
}

program
  .command('spec <component>')
  .description('Read a component\'s authoritative spec (axes, sizes) from an extracted DESIGN.md; --check enforces it against a built node')
  .option('-f, --file <path>', 'DESIGN.md to read (default: auto-locate in cwd / subdirs)')
  .option('--check <nodeId>', 'Measure this node and ENFORCE the spec (exit 1 on violation)')
  .option('--tolerance <px>', 'Dimension tolerance in px for --check', '2')
  .action(async (component, options) => {
    const file = locateDesignMd(options.file);
    if (!file) {
      console.error(chalk.red('✗ No DESIGN.md found.'), 'Pass --file <path> or run from a folder that has one (try `figma-cli extract` first).');
      process.exit(1);
    }
    const md = readFileSync(file, 'utf8');
    const spec = findComponentSpec(md, component);
    if (!spec) {
      console.error(chalk.red(`✗ No component matching "${component}" in ${file}.`));
      process.exit(1);
    }

    if (!options.check) {
      // Digest mode — compact authoritative spec, no structure dump.
      const axisLines = Object.entries(spec.axes).map(([k, v]) => `  ${k}: ${v.join(', ')}`);
      console.log(chalk.bold(spec.name) + chalk.gray(`  (${spec.variants} variants${spec.page ? ` · ${spec.page}` : ''})`));
      const reuseLines = formatReuseDigest(spec);
      if (reuseLines.length) console.log(chalk.gray(reuseLines.join('\n')));
      if (axisLines.length) {
        console.log(chalk.gray('axes:'));
        console.log(axisLines.join('\n'));
      }
      if (spec.sample) {
        const s = spec.sample;
        const meta = [s.lm === 'HORIZONTAL' ? 'row' : s.lm === 'VERTICAL' ? 'col' : null, s.gap != null ? `gap ${s.gap}` : null, s.pad ? `pad ${s.pad.join('/')}` : null, s.children?.length ? `${s.children.length} children` : null].filter(Boolean).join(', ');
        console.log(chalk.gray(`sample: ${s.name} → ${s.w}×${s.h}${meta ? ` (${meta})` : ''}`));
      }
      console.log(chalk.gray(`\nbuild to this, then enforce: figma-cli spec "${spec.name}" --check <nodeId>`));
      // Also emit JSON on the last line for programmatic use.
      console.log(JSON.stringify({ spec }));
      return;
    }

    // Check mode — measure + enforce. Hard rule: exit 1 on any violation.
    await checkConnection();
    let measured = await fastEval(measureCode(options.check, spec.sample ? spec.sample.name : ''));
    if (typeof measured === 'string') { try { measured = JSON.parse(measured); } catch {} }
    if (!measured || measured.error) {
      console.error(chalk.red('✗ Could not measure node:'), measured?.error || 'unknown');
      process.exit(1);
    }
    const { pass, rules } = checkConformance(spec, measured, { tolerance: parseFloat(options.tolerance) });
    console.log(chalk.bold(`Conformance: ${spec.name} vs ${options.check}`));
    for (const r of rules) {
      const mark = r.ok ? chalk.green('✓') : r.warn ? chalk.yellow('⚠') : chalk.red('✗');
      console.log(`  ${mark} ${r.warn ? chalk.yellow(r.msg) : r.msg}`);
    }
    if (!rules.length) console.log(chalk.gray('  (no enforceable rules for this component)'));
    const warns = rules.filter(r => !r.ok && r.warn).length;
    if (!pass) {
      console.log(chalk.red('\n✗ Build does NOT conform to the DESIGN.md spec.'));
      process.exit(1);
    }
    console.log(chalk.green(`\n✓ Conforms to spec.${warns ? chalk.yellow(` (${warns} advisory hint${warns > 1 ? 's' : ''})`) : ''}`));
  });
