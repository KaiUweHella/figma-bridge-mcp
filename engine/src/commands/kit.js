// Command: kit — get an existing design system agent-ready in one step.
//
// The answer to "but figma-cli ships shadcn" is not to ship a design system of
// our own. It is to make the user's OWN system usable by an agent quickly:
// a DESIGN.md to read, tokens to bind, a component inventory with stable
// publish keys, and — if there is a Storybook — the Figma↔code mapping.
//
// Every step here already exists as its own command. What was missing was the
// clamp: knowing which four to run, in which order, and what the result means.
// So this orchestrates rather than reimplements, and reports what each step
// produced plus what is still missing.
//
// Read-only with respect to Figma. Everything it writes lands in the project
// directory the user names.
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve as resolvePath, join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { program, checkConnection } from '../lib/cli-core.js';

const execFileAsync = promisify(execFile);
const ENTRY = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

const kit = program
  .command('kit')
  .description('Set an existing design system up for agent use (extract + tokens + inventory + Storybook map)');

/**
 * Run one engine command as a child process.
 *
 * In-process orchestration is not an option: several of these commands end
 * with process.exit(0) so no stray timer keeps the event loop alive, which
 * would take the whole kit run down after the first step. A child per step
 * also means one failure is a reported failure rather than the end of the run.
 */
async function step(label, args, { optional = false, globals = [] } = {}) {
  process.stdout.write(chalk.gray(`  · ${label}… `));
  try {
    const { stdout } = await execFileAsync(process.execPath, [ENTRY, ...globals, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    console.log(chalk.green('ok'));
    return { label, ok: true, stdout: stdout || '' };
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').trim().split('\n').filter(Boolean);
    console.log(optional ? chalk.yellow('skipped') : chalk.red('failed'));
    // Show the command's own message — it is far more actionable than
    // "exited with code 1".
    for (const line of detail.slice(-3)) console.log(chalk.gray(`    ${line}`));
    return { label, ok: false, optional, error: detail.join(' ') };
  }
}

kit
  .command('init [projectDir]')
  .description('Write DESIGN.md, tokens, a component inventory and (optionally) figma-map.json')
  .option('--storybook <urlOrDir>', 'Storybook URL or static build to map components against')
  .option('--out <dir>', 'Where to write the files, relative to projectDir', 'design')
  .option('--node <id>', 'Scope tokens to a subtree (default: all local variables)')
  .action(async (projectDir, options) => {
    await checkConnection();

    const root = resolvePath(projectDir || '.');
    if (!existsSync(root)) {
      console.error(chalk.red(`✗ Project directory not found: ${root}`));
      console.error(chalk.yellow('  Pass the path to your code project, e.g. figma-cli kit init ./my-app'));
      process.exit(1);
    }
    const outDir = resolvePath(join(root, options.out));
    mkdirSync(outDir, { recursive: true });

    const designMd = join(outDir, 'DESIGN.md');
    const tokensFile = join(outDir, 'tokens.json');
    const mapFile = join(root, 'figma-map.json');

    console.log(chalk.white(`\n  Setting up ${root}\n`));

    // Carry the global --file through, so kit works when several windows are
    // connected exactly like every other command.
    const targetFile = program.opts().file;
    const globals = targetFile ? ['--file', String(targetFile)] : [];

    const results = [];
    results.push(await step('DESIGN.md — structure, tokens, variant matrices',
      ['extract', designMd], { globals }));
    results.push(await step('tokens.json — DTCG design tokens',
      options.node ? ['export', 'dtcg', tokensFile, options.node] : ['export', 'dtcg', tokensFile],
      { globals }));
    // --all-pages: kit is setting up a whole design system, and a library's
    // components are rarely all on the page that happens to be open.
    const inventory = await step('component inventory (stable publish keys)',
      ['component', 'list', '--all-pages'], { globals });
    results.push(inventory);

    if (options.storybook) {
      results.push(await step(`figma-map.json — matched against ${options.storybook}`,
        ['map', 'storybook', options.storybook, '-o', mapFile], { optional: true, globals }));
    }

    // ---- Report ------------------------------------------------------------
    console.log('');
    const failed = results.filter((r) => !r.ok && !r.optional);
    if (failed.length) {
      console.log(chalk.red(`  ${failed.length} step(s) failed — the setup is incomplete.\n`));
    }

    const wrote = [];
    for (const [label, file] of [['DESIGN.md', designMd], ['tokens', tokensFile], ['Storybook map', mapFile]]) {
      if (existsSync(file)) wrote.push([label, file]);
    }
    if (wrote.length) {
      console.log(chalk.white('  Written:'));
      for (const [label, file] of wrote) {
        console.log(`    ${chalk.cyan(relative(root, file))}  ${chalk.gray(label)}`);
      }
    }

    // The inventory has no file of its own — it is the one step whose value is
    // the output itself, so it is echoed here rather than silently discarded.
    if (inventory.ok && inventory.stdout.trim()) {
      const lines = inventory.stdout.trim().split('\n');
      console.log(chalk.white('\n  Components:'));
      for (const line of lines.slice(0, 15)) console.log(`    ${line}`);
      if (lines.length > 15) {
        console.log(chalk.gray(`    … ${lines.length - 15} more — figma-cli component list`));
      }
    }

    // What is still missing is the more useful half of the report: a setup
    // that silently lacks a Storybook mapping looks finished until an agent
    // needs it.
    const gaps = [];
    if (!options.storybook) {
      gaps.push('No Storybook mapped. Re-run with --storybook <url|dir> so components '
        + 'resolve to their stories in figma_spec and figma_selection.');
    } else if (existsSync(mapFile)) {
      try {
        const map = JSON.parse(readFileSync(mapFile, 'utf8'));
        const entries = Object.keys(map.components || map.matched || {}).length;
        const unmatched = (map.unmatchedFigma || []).length;
        if (unmatched) {
          gaps.push(`${unmatched} Figma component(s) have no story. Edit ${relative(root, mapFile)} `
            + 'and set "matchedBy": "manual" on the ones you pin by hand — pinned entries survive re-runs.');
        }
        if (!entries) gaps.push('The Storybook map matched nothing — check the URL or build directory.');
      } catch {
        gaps.push(`Could not read ${relative(root, mapFile)}.`);
      }
    }
    if (existsSync(tokensFile)) {
      gaps.push(`Keep tokens in step with: figma-cli tokens sync ${tokensFile}`);
    }

    if (gaps.length) {
      console.log(chalk.white('\n  Next:'));
      for (const g of gaps) console.log(chalk.gray(`    - ${g}`));
    }

    console.log(chalk.gray('\n  DESIGN.md is what an agent should read first; tokens.json is what it binds to.\n'));
    if (failed.length) process.exitCode = 1;
  });
