// Commands: setup (extracted from index.js)
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

// Repo root = three levels up from engine/src/commands/setup.js. Used to print
// the plugin manifest path independent of the process cwd (the MCP server spawns
// the engine from an arbitrary directory).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_MANIFEST_PATH = join(REPO_ROOT, 'plugin', 'manifest.json');
import * as apiDocs from '../api-docs.js';
import { convert, detectSourceType } from '../code-import/index.js';
import {
  program,
  getDaemonPort,
  daemonCurl,
  isDaemonRunning,
  pkg,
  startDaemon,
  stopDaemon
} from '../lib/cli-core.js';

program
  .name('figma-ds-cli')
  .description('CLI for managing Figma design systems')
  .version(pkg.version);

// Top-level shortcut: `figma-cli import <source>` — auto-detects the source
// type and routes to the right importer.
// Supported: DESIGN.md (Figma extraction format), Tailwind config, CSS custom
// properties, W3C design-tokens JSON, Storybook (URL or static build).
program
  .command('import <source>')
  .description(
    'Import a design source into Figma variables.\n' +
    '  Supports: DESIGN.md, tailwind.config.js, CSS variables, design-tokens JSON, Storybook URL/build.'
  )
  .option('-c, --collection <name>', 'Variable collection name')
  .option('--print-context', 'Print figmachat context summary without creating variables')
  .option('--save <file>', 'Write the converted DESIGN.md to this path instead of a temp file')
  .option('--type <type>', 'Override source-type detection (tailwind|css|tokens|storybook|designmd)')
  .action(async (source, options) => {
    const isUrl = /^https?:\/\//.test(source);

    // For URLs and directories we skip the readFileSync path entirely.
    // For file paths, check existence first.
    if (!isUrl) {
      const { statSync } = await import('fs');
      let isDir = false;
      try { isDir = statSync(source).isDirectory(); } catch { /* file or missing */ }
      if (!isDir && !existsSync(source)) {
        console.error(chalk.red('✗'), `not found: ${source}`);
        process.exit(1);
      }

      if (!isDir) {
        // Read content for DESIGN.md sniffing and type detection.
        const content = readFileSync(source, 'utf-8');

        // Check if it's one of the three DESIGN.md formats (existing path).
        const hasFrontmatterTokens = /^---\s*\n[\s\S]*?(^colors:|^color:|^typography:)/m.test(content);
        const hasJsonBlock = /```json\s+design-tokens/.test(content) || /^##\s+\d+\.\s+Machine-readable tokens/m.test(content);
        const proseColorRows = (content.match(/\*\*[^*]+\*\*\s*\(`#[0-9a-fA-F]{3,8}`\)\s*:/g) || []).length;
        const isDesignMd = hasFrontmatterTokens || hasJsonBlock || proseColorRows >= 3;

        if ((isDesignMd && !options.type) || options.type === 'designmd') {
          // Existing DESIGN.md path — forward unchanged.
          const args = ['tokens', 'import-design-md', source];
          if (options.collection) args.push('-c', options.collection);
          if (options.printContext) args.push('--print-context');
          await program.parseAsync(args, { from: 'user' });
          return;
        }

        // If no explicit type, detect from filename + content sample.
        if (!options.type) {
          const detectedType = detectSourceType(source, content.slice(0, 2048));
          if (!detectedType || detectedType === 'designmd') {
            console.error(chalk.red('✗'), `Unrecognized format: ${source}`);
            _printSupportedFormats();
            process.exit(1);
          }
          options.type = detectedType;
        }
      }
    }

    // Code-import branch: convert → write DESIGN.md → import variables.
    let result;
    try {
      result = await convert(source, { type: options.type });
    } catch (err) {
      console.error(chalk.red('✗'), `Import failed: ${err.message}`);
      process.exit(1);
    }

    const { tokens, meta, designMd } = result;
    const hasTokens = Object.keys(tokens.color || {}).length > 0 ||
                      Object.keys(tokens.typography || {}).length > 0 ||
                      Object.keys(tokens.radius || {}).length > 0;
    const hasComponents = meta.components?.length > 0;

    // Write DESIGN.md — to the --save path or a temp file.
    let designMdPath;
    if (options.save) {
      designMdPath = options.save;
      writeFileSync(designMdPath, designMd, 'utf-8');
      console.log(chalk.green('✓'), `DESIGN.md saved to ${designMdPath}`);
    } else if (!hasTokens) {
      // Storybook (zero-token): default to ./DESIGN-storybook.md
      designMdPath = join(process.cwd(), 'DESIGN-storybook.md');
      writeFileSync(designMdPath, designMd, 'utf-8');
      console.log(chalk.green('✓'), `Component context saved to ${designMdPath}`);
    } else {
      // Tokens present: use a temp file (not permanent unless --save given)
      designMdPath = join(tmpdir(), `figma-cli-import-${Date.now()}.md`);
      writeFileSync(designMdPath, designMd, 'utf-8');
    }

    if (hasTokens) {
      // Forward to the existing import-design-md pipeline.
      const args = ['tokens', 'import-design-md', designMdPath];
      if (options.collection) args.push('-c', options.collection);
      if (options.printContext) args.push('--print-context');
      await program.parseAsync(args, { from: 'user' });
    } else if (hasComponents) {
      // Storybook: print component context, skip variable creation.
      const comps = meta.components;
      console.log(chalk.cyan('\nStorybook component context loaded:'));
      console.log(chalk.white(`  ${comps.length} component${comps.length !== 1 ? 's' : ''}:`));
      const preview = comps.slice(0, 10);
      for (const c of preview) {
        const varCount = c.variants?.length ?? 0;
        const varLabel = varCount > 0 ? chalk.gray(` (${varCount} variants: ${c.variants.slice(0, 3).join(', ')}${varCount > 3 ? ', …' : ''})`) : '';
        console.log(`    ${chalk.white(c.name)}${varLabel}`);
      }
      if (comps.length > 10) {
        console.log(chalk.gray(`    … and ${comps.length - 10} more`));
      }
      console.log(
        chalk.yellow('\nStorybook gives component context, not design tokens.') +
        chalk.gray(' Combine with:')
      );
      console.log(chalk.cyan('  figma-cli import tailwind.config.js'));
      console.log(chalk.cyan('  figma-cli import src/globals.css'));
      console.log(chalk.cyan('  figma-cli import tokens.json'));
    } else {
      console.log(chalk.yellow('⚠'), 'No tokens or components found in source.');
    }
  });

function _printSupportedFormats() {
  console.error(chalk.yellow('  Supported sources for `figma-cli import`:'));
  console.error('    • DESIGN.md       (## Machine-readable tokens block, YAML frontmatter, or prose rows)');
  console.error('    • tailwind.config.js / .cjs / .ts   (Tailwind color/radius/spacing/font config)');
  console.error('    • globals.css / styles.css           (CSS custom properties, @theme, shadcn HSL)');
  console.error('    • tokens.json                        (W3C design-tokens / Style Dictionary)');
  console.error('    • http://localhost:6006              (Storybook — running dev server)');
  console.error('    • ./storybook-static/                (Storybook — static build directory)');
}

// Default action when no command is given (Safe Mode: no patching, no CDP —
// the only setup step is `connect`, which starts the daemon and prints the
// plugin access key).
program.action(async () => {
  // If user passed an unknown subcommand as first arg, suggest from API docs
  const argv = process.argv.slice(2);
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    const attempted = argv[0];
    console.error(chalk.red(`\u2717 unknown command: ${attempted}\n`));
    apiDocs.suggest(attempted);
    process.exit(1);
  }

  showBanner();
  const running = isDaemonRunning();
  console.log(running
    ? chalk.green('  \u2713 Daemon running') + chalk.gray(` (port ${getDaemonPort()})`)
    : chalk.yellow('  \u25cb Daemon not running'));
  console.log();
  console.log(chalk.white('  Get started:\n'));
  console.log(chalk.cyan('    node src/index.js connect') + chalk.gray('   start the daemon + show the plugin access key'));
  console.log(chalk.cyan('    node src/index.js --help') + chalk.gray('    list every command\n'));
  console.log(chalk.gray('  In Figma: Plugins \u2192 Development \u2192 FigCli, paste the key once.\n'));
  showQuickStart();
});

function showQuickStart() {
  console.log(chalk.white('  Just ask Claude:\n'));
  console.log(chalk.white('    "Import my design tokens from globals.css"'));
  console.log(chalk.white('    "Create a blue card with rounded corners"'));
  console.log(chalk.white('    "Show me what\'s on the canvas"'));
  console.log(chalk.white('    "Export this frame as PNG"'));
  console.log();
}

// ============ WELCOME BANNER ============

function showBanner() {
  console.log(chalk.cyan(`
  ███████╗██╗ ██████╗ ███╗   ███╗ █████╗       ██████╗ ███████╗       ██████╗██╗     ██╗
  ██╔════╝██║██╔════╝ ████╗ ████║██╔══██╗      ██╔══██╗██╔════╝      ██╔════╝██║     ██║
  █████╗  ██║██║  ███╗██╔████╔██║███████║█████╗██║  ██║███████╗█████╗██║     ██║     ██║
  ██╔══╝  ██║██║   ██║██║╚██╔╝██║██╔══██║╚════╝██║  ██║╚════██║╚════╝██║     ██║     ██║
  ██║     ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║      ██████╔╝███████║      ╚██████╗███████╗██║
  ╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝       ╚═════╝╚══════╝╚═╝
`));
  console.log(chalk.white(`  Design System CLI for Figma ${chalk.gray('v' + pkg.version)}\n`));
}

// (The interactive `init` wizard was removed: it patched the Figma Desktop
// binary and polled the CDP port — the Yolo path this build exists to avoid.
// `connect` below is the entire Safe-Mode setup.)

// ============ STATUS ============

// (`setup` was an alias that shelled out to a globally installed
// `figma-ds-cli init` — a binary this vendored build never installs.)

program
  .command('status')
  .description('Report daemon + plugin connection state')
  .action(() => {
    const daemonInfo = isDaemonRunning(true);
    if (daemonInfo && daemonInfo.running) {
      console.log(chalk.green('  \u2713 Daemon running') + chalk.gray(` (port ${getDaemonPort()})`));
      try {
        const health = JSON.parse(daemonCurl([`http://127.0.0.1:${getDaemonPort()}/health`]));
        console.log(health.plugin
          ? chalk.green('  \u2713 Plugin connected') + chalk.gray(` (mode: ${health.mode})`)
          : chalk.yellow('  \u26a0 Plugin NOT connected') + chalk.gray(' \u2014 open Plugins \u2192 Development \u2192 FigCli in Figma'));
        if (!health.keyConfigured) {
          console.log(chalk.yellow('  \u26a0 No access key configured') + chalk.gray(' \u2014 run: figma-cli connect'));
        }
      } catch {
        console.log(chalk.gray('  (could not read /health)'));
      }
    } else if (daemonInfo && daemonInfo.authFailed) {
      console.log(chalk.yellow('  \u26a0 Daemon running but token mismatch (auth failed).'));
      console.log(chalk.gray('    Restart with:  figma-cli daemon restart'));
    } else {
      console.log(chalk.yellow('  \u26a0 Daemon NOT running'));
      console.log(chalk.gray('    Start it with:  figma-cli connect'));
    }
  });

// ============ UNPATCH ============

// The `unpatch` command was removed in the Safe-Mode build — there is no
// binary patching to undo.

// ============ CONNECT ============

program
  .command('connect')
  .description('Connect to Figma Desktop (Safe Mode — plugin bridge only)')
  .option('--safe', 'Accepted for compatibility; Safe Mode is the only mode')
  .action(async (_options) => {
    // Fun welcome message
    console.log(chalk.hex('#FF6B35')('\n  ✨ Hey designer! ') + chalk.white("Don't be afraid of the terminal!"));
    console.log(chalk.hex('#4ECDC4')('  🎨 Happy vibe coding!\n'));

    console.log(chalk.hex('#4ECDC4')('  🔒 Safe Mode ') + chalk.gray('(plugin bridge, no patching, no Figma API token)\n'));

    // Stop any existing daemon, then start it in plugin mode.
    stopDaemon();

    const daemonSpinner = ora('Starting daemon in Safe Mode...').start();
    try {
      startDaemon(true, 'plugin');  // Force restart in plugin mode
      await new Promise(r => setTimeout(r, 1000));
      if (isDaemonRunning()) {
        daemonSpinner.succeed('Daemon running in Safe Mode');
      } else {
        daemonSpinner.fail('Daemon failed to start');
        return;
      }
    } catch (e) {
      daemonSpinner.fail('Daemon failed: ' + e.message);
      return;
    }

    // Show plugin setup instructions
    console.log(chalk.hex('#FF6B35')('\n  ┌─────────────────────────────────────────────────────┐'));
    console.log(chalk.hex('#FF6B35')('  │') + chalk.white.bold('  Setup the FigCli plugin                           ') + chalk.hex('#FF6B35')('│'));
    console.log(chalk.hex('#FF6B35')('  └─────────────────────────────────────────────────────┘\n'));

    console.log(chalk.white.bold('  ONE-TIME SETUP:\n'));
    console.log(chalk.cyan('  1. ') + chalk.white('Open Figma Desktop and any design file'));
    console.log(chalk.cyan('  2. ') + chalk.white('Go to ') + chalk.yellow('Plugins → Development → Import plugin from manifest'));
    console.log(chalk.cyan('  3. ') + chalk.white('Navigate to: ') + chalk.yellow(PLUGIN_MANIFEST_PATH));
    console.log(chalk.cyan('  4. ') + chalk.white('Click ') + chalk.yellow('Open') + chalk.white(' — plugin is now installed!\n'));

    console.log(chalk.white.bold('  EACH SESSION:\n'));
    console.log(chalk.cyan('  → ') + chalk.white('In Figma: ') + chalk.yellow('Plugins → Development → FigCli'));
    console.log(chalk.cyan('  → ') + chalk.white('Paste your ') + chalk.yellow('access key') + chalk.white(' into the plugin the first time.\n'));

    // Wait for the plugin to connect AND authenticate.
    const pluginSpinner = ora('Waiting for plugin connection...').start();
    let pluginConnected = false;
    const PLUGIN_CONNECT_MAX_WAIT_S = 90;
    for (let i = 0; i < PLUGIN_CONNECT_MAX_WAIT_S; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const healthRes = daemonCurl([`http://127.0.0.1:${getDaemonPort()}/health`]);
        const health = JSON.parse(healthRes);
        if (health.plugin) {
          pluginSpinner.succeed('Plugin connected and authenticated!');
          console.log(chalk.green('\n  ✓ Ready! Safe Mode active.\n'));
          pluginConnected = true;
          break;
        }
      } catch {}
      if (i === Math.floor(PLUGIN_CONNECT_MAX_WAIT_S / 2)) {
        pluginSpinner.text = `Waiting for plugin connection (${PLUGIN_CONNECT_MAX_WAIT_S - i}s left)…`;
      }
    }

    if (!pluginConnected) {
      pluginSpinner.warn('Plugin not detected yet — daemon is still listening.');
      console.log(chalk.gray('\n  The daemon stays running in the background.'));
      console.log(chalk.gray('  Open ') + chalk.yellow('Plugins → Development → FigCli') + chalk.gray(' in Figma and paste your access key —'));
      console.log(chalk.gray('  the next command will connect automatically.\n'));
    }
  });

