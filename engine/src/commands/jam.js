// Command: jam — FigJam boards over the same plugin bridge as everything else.
//
// FigJam support was dropped from the fork because the upstream commands drove
// the deleted CDP transport, not because FigJam needs one: the plugin API
// covers stickies, shapes, connectors, tables and sections natively. So this
// group is plain eval snippets — engine → daemon → plugin — with no second code
// path and no new trust boundary.
//
// The snippets themselves live in lib/jam-snippets.js so they can be parsed by
// a test: a syntax error inside a generated eval string is invisible to
// `node --check`, which only ever sees a template literal.
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import * as snippets from '../lib/jam-snippets.js';

const jam = program
  .command('jam')
  .description('FigJam boards: stickies, shapes, connectors, tables, sections');

/** Run a snippet, translate the two error shapes, hand the result to `onOk`. */
async function run(code, onOk) {
  await checkConnection();
  let res;
  try {
    res = await fastEval(code);
  } catch (e) {
    handleEvalError(e);
    return;
  }
  if (res && res.error === 'WRONG_EDITOR') {
    console.error(chalk.red(`✗ This is a ${res.editor} file, not a FigJam board.`));
    console.error(chalk.yellow('  Open a FigJam file in Figma Desktop and relaunch the Figma Bridge plugin there.'));
    process.exit(1);
  }
  if (res && res.error) {
    console.error(chalk.red(`✗ ${res.error}`));
    process.exit(1);
  }
  onOk(res);
}

jam
  .command('sticky <text>')
  .description('Add a sticky note')
  .option('--color <name>', `Fill: ${Object.keys(snippets.STICKY_COLORS).join(', ')}, or a hex value`)
  .option('--at <x,y>', 'Place at absolute coordinates (default: right of existing content)')
  .action(async (text, options) => {
    await run(
      snippets.sticky(text, { color: options.color, at: options.at }),
      (r) => console.log(chalk.green('✓'), `Sticky ${r.id} at ${Math.round(r.x)},${Math.round(r.y)}`),
    );
  });

jam
  .command('stickies <items>')
  .description('Add many stickies at once: JSON array, or newline/semicolon-separated text')
  .option('--color <name>', 'Fill for all of them')
  .option('--at <x,y>', 'Top-left of the grid')
  .option('--columns <n>', 'Stickies per row', '4')
  .action(async (items, options) => {
    const trimmed = items.trim();
    let list;
    if (trimmed.startsWith('[')) {
      try { list = JSON.parse(trimmed); } catch (e) {
        console.error(chalk.red(`✗ --items is not valid JSON: ${e.message}`));
        process.exit(1);
      }
    } else {
      list = trimmed.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
    }
    // Entries may be plain strings or {text, color} objects.
    const normalized = (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string'
      ? { text: item, color: options.color || null }
      : { text: String(item?.text ?? ''), color: item?.color || options.color || null }));
    if (!normalized.length) {
      console.error(chalk.red('✗ Nothing to add.'));
      process.exit(1);
    }
    await run(
      snippets.stickies(normalized, { at: options.at, columns: options.columns }),
      (r) => console.log(chalk.green('✓'), `${r.count} stickies added`),
    );
  });

jam
  .command('shape <text>')
  .description('Add a shape with text')
  .option('--type <shape>', `One of: ${snippets.SHAPE_TYPES.join(', ')}`, 'ROUNDED_RECTANGLE')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .option('--size <w,h>', 'Size in px', '200,140')
  .action(async (text, options) => {
    const type = String(options.type).toUpperCase();
    if (!snippets.SHAPE_TYPES.includes(type)) {
      console.error(chalk.red(`✗ Unknown shape "${options.type}".`));
      console.error(chalk.yellow(`  Available: ${snippets.SHAPE_TYPES.join(', ')}`));
      process.exit(1);
    }
    const [w, h] = String(options.size).split(',').map((n) => parseFloat(n));
    await run(
      snippets.shape(text, {
        type, at: options.at,
        width: Number.isFinite(w) ? w : 200,
        height: Number.isFinite(h) ? h : 140,
      }),
      (r) => console.log(chalk.green('✓'), `Shape ${r.id}`),
    );
  });

jam
  .command('connector <fromId> <toId>')
  .description('Connect two nodes with an arrow')
  .option('--text <label>', 'Label on the connector')
  .option('--line <type>', 'ELBOWED or STRAIGHT', 'ELBOWED')
  .action(async (fromId, toId, options) => {
    const line = String(options.line).toUpperCase() === 'STRAIGHT' ? 'STRAIGHT' : 'ELBOWED';
    await run(
      snippets.connector(fromId, toId, { text: options.text, line }),
      (r) => console.log(chalk.green('✓'), `Connector ${r.id}`),
    );
  });

jam
  .command('table <rows> <cols>')
  .description('Add a table, optionally filled from a JSON array of rows')
  .option('--data <json>', 'JSON array of rows, e.g. [["a","b"],["c","d"]]')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .action(async (rows, cols, options) => {
    const r = Math.max(1, parseInt(rows, 10) || 1);
    const c = Math.max(1, parseInt(cols, 10) || 1);
    let data = [];
    if (options.data) {
      try { data = JSON.parse(options.data); } catch (e) {
        console.error(chalk.red(`✗ --data is not valid JSON: ${e.message}`));
        process.exit(1);
      }
      if (!Array.isArray(data)) {
        console.error(chalk.red('✗ --data must be an array of rows, e.g. [["a","b"],["c","d"]].'));
        process.exit(1);
      }
    }
    await run(
      snippets.table(r, c, { data, at: options.at }),
      (res) => console.log(chalk.green('✓'), `Table ${res.id} (${res.rows}×${res.cols})`),
    );
  });

jam
  .command('section <name>')
  .description('Add a section (a titled region of the board)')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .option('--size <w,h>', 'Size in px', '800,600')
  .action(async (name, options) => {
    const [w, h] = String(options.size).split(',').map((n) => parseFloat(n));
    await run(
      snippets.section(name, {
        at: options.at,
        width: Number.isFinite(w) ? w : 800,
        height: Number.isFinite(h) ? h : 600,
      }),
      (r) => console.log(chalk.green('✓'), `Section ${r.id}`),
    );
  });

jam
  .command('code <source>')
  .description('Add a code block')
  .option('--lang <language>', 'Syntax highlighting language', 'TYPESCRIPT')
  .option('--at <x,y>', 'Place at absolute coordinates')
  .action(async (source, options) => {
    await run(
      snippets.codeBlock(source, { lang: options.lang, at: options.at }),
      (r) => console.log(chalk.green('✓'), `Code block ${r.id}`),
    );
  });

jam
  .command('board')
  .description('Read the board: every sticky, shape, table and section with its text')
  .option('--json', 'Emit JSON instead of the text listing')
  .action(async (options) => {
    await run(snippets.board(), (r) => {
      if (options.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(chalk.white(`${r.page} — ${r.count} node(s)\n`));
      for (const n of r.nodes) {
        const label = n.text ? ` "${n.text.replace(/\s+/g, ' ')}"` : '';
        console.log(`  ${chalk.gray(n.id.padEnd(12))} ${n.type.padEnd(16)} ${String(n.x).padStart(6)},${String(n.y).padStart(6)}${label}`);
      }
      if (r.connectors.length) {
        console.log(chalk.white(`\n${r.connectors.length} connector(s)`));
        for (const c of r.connectors) {
          console.log(`  ${chalk.gray(c.id.padEnd(12))} ${c.from} → ${c.to}${c.text ? ` "${c.text}"` : ''}`);
        }
      }
    });
  });

jam
  .command('arrange')
  .description('Lay loose top-level nodes out on a grid (connectors and sections stay put)')
  .option('--columns <n>', 'Nodes per row', '5')
  .option('--gap <px>', 'Gap between nodes', '48')
  .action(async (options) => {
    await run(
      snippets.arrange({ columns: options.columns, gap: options.gap }),
      (r) => console.log(chalk.green('✓'), r.moved ? `${r.moved} node(s) arranged` : 'Nothing to arrange'),
    );
  });
