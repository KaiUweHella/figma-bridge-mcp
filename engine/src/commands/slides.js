// Command: slides — a bounded first vertical slice for Figma Slides.
//
// This is explicitly beta. It covers deck structure and native slide
// properties, not interactive elements or a second content renderer.
import chalk from 'chalk';
import {
  program,
  checkConnection,
  fastEval,
  handleEvalError,
} from '../lib/cli-core.js';
import * as snippets from '../lib/slides-snippets.js';

const slides = program
  .command('slides')
  .description('Figma Slides beta: inspect, create, duplicate, move, transition, skip, delete');

async function run(code, onOk) {
  await checkConnection();
  let result;
  try {
    result = await fastEval(code);
  } catch (error) {
    handleEvalError(error);
    return;
  }
  if (result && result.error === 'WRONG_EDITOR') {
    console.error(chalk.red(`✗ This is a ${result.editor} file, not a Figma Slides deck.`));
    console.error(chalk.yellow('  Open a Slides file in Figma Desktop and relaunch the Figma Bridge plugin there.'));
    process.exit(1);
  }
  if (result && result.error) {
    console.error(chalk.red(`✗ ${result.error}`));
    process.exit(1);
  }
  onOk(result);
}

function index(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(chalk.red(`✗ ${label} must be a zero-based non-negative integer.`));
    process.exit(1);
  }
  return parsed;
}

slides
  .command('inspect [slide]')
  .description('Read the slide grid, or one slide by id, native name or durable Bridge label')
  .action(async (slide) => {
    await run(snippets.inspect(slide), (result) => console.log(JSON.stringify(result, null, 2)));
  });

slides
  .command('create [label]')
  .description('Create and focus a slide with a durable Bridge label, optionally at a grid coordinate')
  .option('--row <n>', 'Zero-based grid row')
  .option('--col <n>', 'Zero-based grid column (requires --row)')
  .action(async (label, options) => {
    const row = index(options.row, 'row', { optional: true });
    const col = index(options.col, 'col', { optional: true });
    if (col !== null && row === null) {
      console.error(chalk.red('✗ --col requires --row.'));
      process.exit(1);
    }
    await run(snippets.create(label, { row, col }), (result) => {
      const labelled = result.label ? ` [${result.label}]` : '';
      console.log(chalk.green('✓'), `Slide ${result.id}${labelled} at ${result.row},${result.col} (Figma name: "${result.name}")`);
    });
  });

slides
  .command('duplicate <slide>')
  .description('Duplicate a slide and move the copy to the end or a grid coordinate')
  .option('--label <label>', 'Durable Bridge label for the copy')
  .option('--row <n>', 'Zero-based target row')
  .option('--col <n>', 'Zero-based target column (requires --row)')
  .action(async (slide, options) => {
    const row = index(options.row, 'row', { optional: true });
    const col = index(options.col, 'col', { optional: true });
    if (col !== null && row === null) {
      console.error(chalk.red('✗ --col requires --row.'));
      process.exit(1);
    }
    await run(snippets.duplicate(slide, { label: options.label, row, col }), (result) => {
      const labelled = result.slide.label ? ` [${result.slide.label}]` : '';
      console.log(chalk.green('✓'), `Slide ${result.sourceId} duplicated as ${result.slide.id}${labelled}`);
    });
  });

slides
  .command('move <slide> <row> <col>')
  .description('Move one slide to a zero-based grid coordinate')
  .action(async (slide, rowValue, colValue) => {
    const row = index(rowValue, 'row');
    const col = index(colValue, 'col');
    await run(snippets.move(slide, row, col), (result) => {
      console.log(chalk.green('✓'), `Slide ${result.id} moved to ${result.row},${result.col}`);
    });
  });

slides
  .command('transition <slide> <style>')
  .description('Set a native slide transition')
  .option('--duration <seconds>', 'Duration in seconds', '0.3')
  .option('--curve <curve>', `One of: ${snippets.TRANSITION_CURVES.join(', ')}`, 'EASE_IN_AND_OUT')
  .option('--timing <timing>', `One of: ${snippets.TRANSITION_TIMINGS.join(', ')}`, 'ON_CLICK')
  .option('--delay <seconds>', 'Delay for AFTER_DELAY timing', '0')
  .action(async (slide, styleValue, options) => {
    const style = String(styleValue).toUpperCase();
    const curve = String(options.curve).toUpperCase();
    const timing = String(options.timing).toUpperCase();
    const duration = Number(options.duration);
    const delay = Number(options.delay);
    if (!snippets.TRANSITION_STYLES.includes(style)) {
      console.error(chalk.red(`✗ Unknown transition style "${styleValue}".`));
      process.exit(1);
    }
    if (!snippets.TRANSITION_CURVES.includes(curve)) {
      console.error(chalk.red(`✗ Unknown transition curve "${options.curve}".`));
      process.exit(1);
    }
    if (!snippets.TRANSITION_TIMINGS.includes(timing)) {
      console.error(chalk.red(`✗ Unknown transition timing "${options.timing}".`));
      process.exit(1);
    }
    if (!Number.isFinite(duration) || duration < 0 || !Number.isFinite(delay) || delay < 0) {
      console.error(chalk.red('✗ Duration and delay must be non-negative numbers.'));
      process.exit(1);
    }
    const transition = {
      style,
      duration,
      curve,
      timing: timing === 'AFTER_DELAY' ? { type: timing, delay } : { type: timing },
    };
    await run(snippets.transition(slide, transition), (result) => {
      console.log(chalk.green('✓'), `Slide ${result.id} transition: ${result.transition.style}`);
    });
  });

slides
  .command('skip <slide> [state]')
  .description('Include or skip a slide in presentation playback (on/off; default on)')
  .action(async (slide, state = 'on') => {
    const normalized = String(state).toLowerCase();
    if (!['on', 'off', 'true', 'false'].includes(normalized)) {
      console.error(chalk.red('✗ State must be on or off.'));
      process.exit(1);
    }
    const skipped = normalized === 'on' || normalized === 'true';
    await run(snippets.skip(slide, skipped), (result) => {
      console.log(chalk.green('✓'), `Slide ${result.id} is ${result.skipped ? 'skipped' : 'included'}`);
    });
  });

slides
  .command('delete <slide>')
  .description('Delete exactly one slide resolved by id, exact native name or durable Bridge label')
  .action(async (slide) => {
    await run(snippets.remove(slide), (result) => {
      const labelled = result.label ? ` [${result.label}]` : '';
      console.log(chalk.green('✓'), `Deleted slide ${result.id}${labelled} (Figma name: "${result.name}")`);
    });
  });
