// Commands: setup (extracted from index.js)
import chalk from 'chalk';
import { mkdirSync, copyFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { planFigmaCommand } from '../../../src/capability-catalog.js';
import { ensurePluginReadiness, runInProcessCommandPlan } from '../../../src/engine.js';
import {
  designSourceImportPlanningArgvFromRequest,
  designSourceImportRequiresFigma,
  executeDesignSourceImportPlan,
  prepareDesignSourceImportPlan,
} from '../application/design-source-import-command.js';
import { STATE_DIR, isLocalDevelopmentProfile } from '../lib/state-dir.js';
import { workspaceIO } from '../lib/workspace-io.js';

// Repo root = three levels up from engine/src/commands/setup.js. Used to
// locate the shipped plugin files independent of the process cwd (the MCP
// server spawns the engine from an arbitrary directory).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_SRC_DIR = join(REPO_ROOT, 'plugin');

// The path the user imports in Figma. Under an npx install the package lives
// in an EPHEMERAL cache that npx may garbage-collect — importing the manifest
// from there breaks the plugin on cache eviction. So connect copies both
// connected plugin adapters to the stable state dir and prints THAT path; only
// if the copy fails does it fall back to the in-package path.
export function installPluginFiles() {
  // The contributor profile deliberately stays checkout-owned: edits to the
  // active branch must be the exact Plugin bytes Figma runs. Released/npx
  // profiles still need the stable copied path below because their package
  // cache may disappear.
  if (isLocalDevelopmentProfile()) {
    return join(PLUGIN_SRC_DIR, 'manifest.json');
  }
  // Test/packaging hook: keep integration tests out of the user's real state
  // directory while exercising the exact connect command end to end.
  const dest = process.env.PLUGIN_INSTALL_DIR || join(STATE_DIR, 'plugin');
  try {
    mkdirSync(dest, { recursive: true });
    for (const f of ['manifest.dev.json', 'code.js', 'ui.html']) {
      copyFileSync(join(PLUGIN_SRC_DIR, f), join(dest, f));
    }
    copyFileSync(join(PLUGIN_SRC_DIR, 'manifest.release.json'), join(dest, 'manifest.json'));
    // 0.5.0 briefly shipped a separate offline Codegen adapter. It is not
    // needed by the MCP workflow; remove stable-cache leftovers on upgrade.
    for (const retired of ['manifest.codegen.json', 'codegen.js']) {
      try { rmSync(join(dest, retired), { force: true }); } catch {}
    }
    return join(dest, 'manifest.json');
  } catch {
    return join(PLUGIN_SRC_DIR, 'manifest.json');
  }
}
import * as apiDocs from '../api-docs.js';
import {
  progress,
  program,
  getDaemonPort,
  daemonHealth,
  daemonBuildMatchesCurrent,
  daemonExec,
  handleEvalError,
  isDaemonRunning,
  spinnerSucceed,
  pkg,
  startDaemon,
} from '../lib/cli-core.js';

program
  .name('figma-bridge-engine')
  .description('The Figma-facing engine behind figma-bridge-mcp. Normally driven by the MCP server, not typed by hand.')
  .version(pkg.version)
  // Global, because it applies to every command that reaches Figma rather than
  // to any one of them. Only needed when more than one Figma window has the
  // plugin running: with a single window the daemon routes there anyway, and
  // with several it refuses to guess. There is deliberately no "--all-files".
  //
  // NOT `--file`: eval and spec already own `-f, --file <path>` for a local
  // file path, and commander would resolve the global as theirs — silently
  // dropping the target and failing with an ambiguity error instead.
  .option('--figma-file <keyOrUrl>', 'Target a specific connected Figma file (see `status`)');

// Top-level Design Source Import Adapter. The owning Command Application keeps
// source detection, conversion, optional persistence and any prepared native
// mutation behind one authoritative Plan and Audit lifecycle.
program
  .command('import <source>')
  .description(
    'Import a design source into Figma variables.\n' +
    '  Supports: DESIGN.md, tailwind.config.js, CSS variables, design-tokens JSON, Storybook URL/build.'
  )
  .option('-c, --collection <name>', 'Variable collection name')
  .option('--print-context', 'Print the agent context summary without creating variables')
  .option('--save <file>', 'Write the converted DESIGN.md to this explicit path')
  .option('--type <type>', 'Override source-type detection (tailwind|css|tokens|storybook|designmd)')
  .option('--force-slash', 'Allow "/" in --collection intentionally because Figma Collections are flat')
  .allowExcessArguments(false)
  .action(async (source, options) => {
    try {
      const plan = planFigmaCommand(designSourceImportPlanningArgvFromRequest({
        source,
        collection: options.collection ?? null,
        printContext: options.printContext === true,
        save: options.save ?? null,
        type: options.type ?? null,
        forceSlash: options.forceSlash === true,
      }), { adapter: 'cli', fileKey: program.opts().figmaFile || null });
      const result = await runInProcessCommandPlan(plan, { compatibilityFallback: false },
        async ({ fileKey, deadline }) => {
          const io = workspaceIO();
          const prepared = await prepareDesignSourceImportPlan(plan, { workspaceIO: io });
          if (designSourceImportRequiresFigma(prepared)) {
            await ensurePluginReadiness({ deadline, maxWaitMs: 8000 });
          }
          return executeDesignSourceImportPlan(plan, prepared, {
            workspaceIO: io,
            evaluate: (code) => daemonExec('eval', {
              code, ...(fileKey ? { fileKey } : {}),
            }, Math.max(1, deadline - Date.now())),
          });
        });
      console.log(result.stdout);
      if (result.stderr) console.error(chalk.yellow(result.stderr));
    } catch (error) {
      handleEvalError(error);
      process.exitCode = 1;
    }
  });

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

  // No banner, no quick-start prose: the caller here is the MCP server, and
  // the one human who ever lands on a bare invocation wants the state and the
  // command list, not ASCII art.
  console.log(chalk.white(`  ${pkg.name} ${chalk.gray('v' + pkg.version)}\n`));
  const running = await isDaemonRunning();
  console.log(running
    ? chalk.green('  \u2713 Daemon running') + chalk.gray(` (port ${getDaemonPort()})`)
    : chalk.yellow('  \u25cb Daemon not running'));
  console.log();
  console.log(chalk.cyan('    connect') + chalk.gray('   start the daemon + show the plugin access key'));
  console.log(chalk.cyan('    --help') + chalk.gray('    list every command\n'));
  console.log(chalk.gray('  In Figma: Plugins \u2192 Development \u2192 Figma Bridge, paste the key once.\n'));
});

// (The interactive `init` wizard was removed: it patched the Figma Desktop
// binary and polled the CDP port — the Yolo path this build exists to avoid.
// `connect` below is the entire Safe-Mode setup.)

// ============ STATUS ============

// (`setup` was an alias that shelled out to a globally installed
// `figma-ds-cli init` — a binary this build never installs.)

program
  .command('status')
  .description('Report daemon + plugin connection state')
  .action(async () => {
    const daemonInfo = await isDaemonRunning(true);
    if (daemonInfo && daemonInfo.running) {
      console.log(chalk.green('  \u2713 Daemon running') + chalk.gray(` (port ${getDaemonPort()})`));
      try {
        const healthResponse = await daemonHealth(4000, { probe: true });
        if (!healthResponse.ok || !healthResponse.data) throw new Error(`HTTP ${healthResponse.status}`);
        const health = healthResponse.data;
        console.log(health.plugin
          ? chalk.green('  \u2713 Plugin connected') + chalk.gray(` (mode: ${health.mode})`)
          : chalk.yellow('  \u26a0 Plugin NOT connected') + chalk.gray(' \u2014 open Plugins \u2192 Development \u2192 Figma Bridge in Figma'));
        if (health.plugin && health.pluginResponsive === true) {
          console.log(chalk.green('  \u2713 Plugin responsive') + chalk.gray(' \u2014 authenticated Figma main-thread roundtrip completed'));
        } else if (health.plugin) {
          console.log(chalk.yellow('  \u26a0 Plugin socket connected, but Figma did not answer the bounded probe'));
          console.log(chalk.gray('    Focus Figma and the Plugin tab, then run daemon reconnect.'));
          console.log(chalk.gray('    If it remains unresponsive, close/reopen the Plugin before restarting the daemon.'));
        }
        if (!health.keyConfigured) {
          console.log(chalk.yellow('  \u26a0 No access key configured') + chalk.gray(' \u2014 run figma_connect'));
        }
        // With more than one window connected, commands must name a file \u2014
        // so the list has to be reachable from here.
        const conns = Array.isArray(health.connections) ? health.connections : [];
        if (conns.length > 1) {
          console.log(chalk.white(`\n  ${conns.length} Figma windows connected:`));
          for (const c of conns) {
            console.log('    ' + chalk.cyan(c.fileKey || '(unidentified)')
              + chalk.gray('  ' + [c.fileName, c.editorType, c.responsiveness].filter(Boolean).join('  ')));
          }
          console.log(chalk.gray('\n  Target one with --figma-file <key>, e.g. --figma-file '
            + (conns[0].fileKey || '<key>') + ' canvas info'));
        } else if (conns.length === 1 && conns[0].fileName) {
          console.log(chalk.gray(`    ${conns[0].fileName}`
            + (conns[0].fileKey ? ` (${conns[0].fileKey})` : '')));
        }
      } catch {
        console.log(chalk.gray('  (could not read /health)'));
      }
    } else if (daemonInfo && daemonInfo.authFailed) {
      console.log(chalk.yellow('  \u26a0 Daemon running but token mismatch (auth failed).'));
      console.log(chalk.gray('    Restart with:  figma_run ["daemon","restart"]'));
    } else {
      console.log(chalk.yellow('  \u26a0 Daemon NOT running'));
      console.log(chalk.gray('    Start it with:  figma_connect'));
    }
  });

// ============ UNPATCH ============

// The `unpatch` command was removed in the Safe-Mode build — there is no
// binary patching to undo.

// ============ CONNECT ============

export async function ensureCurrentDaemonReady({
  forceRestart = false,
  maxAttempts = 2,
  waitPerAttemptMs = 2000,
  adapters = {},
} = {}) {
  const now = adapters.now || (() => Date.now());
  const wait = adapters.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const running = adapters.running || ((returnDetails = false, force = false) =>
    isDaemonRunning(returnDetails, force));
  const matches = adapters.matches || (() => daemonBuildMatchesCurrent());
  const start = adapters.start || ((restart, mode, knownState) =>
    startDaemon(restart, mode, knownState));
  const attemptsLimit = Number.isSafeInteger(maxAttempts) && maxAttempts >= 1
    ? Math.min(maxAttempts, 3) : 2;
  const attemptWait = Number.isFinite(Number(waitPerAttemptMs)) && Number(waitPerAttemptMs) >= 1
    ? Math.min(Number(waitPerAttemptMs), 2000) : 2000;

  const daemonWasRunning = await running(false, true);
  const daemonWasReusable = daemonWasRunning && await matches();
  let knownRunning = daemonWasRunning;
  let knownReusable = daemonWasReusable;

  for (let attempt = 1; attempt <= attemptsLimit; attempt++) {
    await start(attempt === 1 && forceRestart === true, 'plugin', {
      running: knownRunning,
      buildMatches: knownReusable,
    });
    const deadline = now() + attemptWait;
    while (now() < deadline) {
      await wait(Math.max(1, Math.min(50, deadline - now())));
      knownRunning = await running(false, true);
      if (!knownRunning) continue;
      if (await matches()) {
        return {
          ready: true,
          attempts: attempt,
          daemonWasRunning,
          daemonWasReusable,
        };
      }
      // A different installed Bridge build won the singleton port. Waiting
      // cannot change that winner; replace it in the next bounded attempt.
      knownReusable = false;
      break;
    }
  }
  return {
    ready: false,
    attempts: attemptsLimit,
    daemonWasRunning,
    daemonWasReusable,
  };
}

program
  .command('connect')
  .description('Connect to Figma Desktop (Safe Mode — plugin bridge only)')
  .option('--safe', 'Accepted for compatibility; Safe Mode is the only mode')
  .option('--no-wait', 'Start the daemon and return without waiting for the Figma plugin')
  .option('--force-restart', 'Restart the daemon even when healthy (pairing-key rotation only)')
  .action(async (options) => {
    // Fun welcome message
    console.log(chalk.hex('#FF6B35')('\n  ✨ Hey designer! ') + chalk.white("Don't be afraid of the terminal!"));
    console.log(chalk.hex('#4ECDC4')('  🎨 Happy vibe coding!\n'));

    console.log(chalk.hex('#4ECDC4')('  🔒 Safe Mode ') + chalk.gray('(plugin bridge, no patching, no Figma API token)\n'));

    const daemonSpinner = progress('Starting daemon in Safe Mode...').start();
    try {
      // `connect` is the normal entry point for every new agent/session, so it
      // must be idempotent. A forced restart here used to tear down an already
      // authenticated Figma plugin socket; Chromium could then keep the panel
      // in its failed-WebSocket retry state for seconds or minutes. Reuse a
      // healthy daemon and reserve destructive restarts for `daemon restart`.
      const daemon = await ensureCurrentDaemonReady({
        forceRestart: options.forceRestart === true,
      });
      if (daemon.ready) {
        spinnerSucceed(
          daemonSpinner,
          daemon.daemonWasReusable && options.forceRestart !== true
            ? 'Daemon running in Safe Mode — existing plugin connection preserved'
            : daemon.daemonWasRunning && options.forceRestart !== true
              ? 'Daemon upgraded in Safe Mode — plugin reconnecting automatically'
            : 'Daemon running in Safe Mode',
        );
      } else {
        daemonSpinner.fail('Daemon failed to start');
        process.exitCode = 1;
        return;
      }
    } catch (e) {
      daemonSpinner.fail('Daemon failed: ' + e.message);
      process.exitCode = 1;
      return;
    }

    // Show plugin setup instructions
    const localDevelopment = isLocalDevelopmentProfile();
    const designPluginName = localDevelopment
      ? 'Figma Bridge Local Development'
      : 'Figma Bridge';
    const devModePluginName = 'Figma Bridge Dev Mode';
    console.log(chalk.hex('#FF6B35')('\n  ┌─────────────────────────────────────────────────────┐'));
    console.log(chalk.hex('#FF6B35')('  │') + chalk.white.bold('  Setup the Figma Bridge plugin                      ') + chalk.hex('#FF6B35')('│'));
    console.log(chalk.hex('#FF6B35')('  └─────────────────────────────────────────────────────┘\n'));

    const pluginManifestPath = installPluginFiles();
    console.log(chalk.white.bold('  ONE-TIME SETUP:\n'));
    console.log(chalk.cyan('  1. ') + chalk.white('Open Figma Desktop and any design file'));
    console.log(chalk.cyan('  2. ') + chalk.white('Go to ') + chalk.yellow('Plugins → Development → Import plugin from manifest'));
    console.log(chalk.cyan('  3. ') + chalk.white('Navigate to: ') + chalk.yellow(pluginManifestPath));
    console.log(chalk.cyan('  4. ') + chalk.white('Click ') + chalk.yellow('Open') + chalk.white(' — plugin is now installed!\n'));

    if (!localDevelopment) {
      console.log(chalk.white.bold('  OPTIONAL DEV MODE (SEPARATE READ-ONLY ADAPTER):\n'));
      console.log(chalk.cyan('  → ') + chalk.white('Connected MCP inspection: ')
        + chalk.yellow(join(dirname(pluginManifestPath), 'manifest.dev.json')) + '\n');
    }

    console.log(chalk.white.bold('  IF THE PLUGIN IS NOT ALREADY OPEN IN THIS FIGMA FILE:\n'));
    console.log(chalk.cyan('  → ') + chalk.white('Design mode: ') + chalk.yellow(`Plugins → Development → ${designPluginName}`));
    if (!localDevelopment) {
      console.log(chalk.cyan('  → ') + chalk.white('Dev Mode: ') + chalk.yellow(`Plugins → Development → ${devModePluginName}`));
    }
    console.log(chalk.cyan('  → ') + chalk.gray('A configured MCP wakes an idle daemon automatically; a new AI session does not require reopening a healthy plugin.'));
    console.log(chalk.cyan('  → ') + chalk.white('Paste the same ') + chalk.yellow('access key')
      + chalk.white(' once in each editor you use (Design, FigJam and Slides).'));
    console.log(chalk.cyan('  → ') + chalk.gray('Figma stores plugin data separately per editor; use Setup → Copy access key in an already paired editor.\n'));

    // MCP clients cannot show the access key appended by the wrapper until
    // this process exits. Waiting here creates a deadlock-shaped delay: the
    // plugin is waiting for a key the user cannot see yet. The MCP path uses
    // --no-wait, returns the key immediately, and leaves the detached daemon
    // ready for the plugin's automatic reconnect loop.
    if (options.wait === false) {
      console.log(chalk.green('  ✓ Daemon ready — launch the plugin and paste the access key.\n'));
      return;
    }

    // Wait for the plugin to connect AND authenticate.
    const pluginSpinner = progress('Waiting for plugin connection...').start();
    let pluginConnected = false;
    const PLUGIN_CONNECT_MAX_WAIT_S = 90;
    const pluginStartedAt = Date.now();
    const pluginDeadline = pluginStartedAt + PLUGIN_CONNECT_MAX_WAIT_S * 1000;
    let showedHalfway = false;
    while (Date.now() < pluginDeadline) {
      // Reconnects after figma_connect normally happen in the first few
      // seconds. Probe those at UI speed; fall back to a quiet 1 Hz wait when
      // the plugin has not been opened yet.
      const elapsed = Date.now() - pluginStartedAt;
      await new Promise(r => setTimeout(r, elapsed < 3000 ? 100 : 1000));
      try {
        const healthResponse = await daemonHealth();
        const health = healthResponse.data || {};
        if (health.plugin) {
          spinnerSucceed(pluginSpinner, 'Plugin connected and authenticated!');
          console.log(chalk.green('\n  ✓ Ready! Safe Mode active.\n'));
          pluginConnected = true;
          break;
        }
      } catch {}
      if (!showedHalfway && Date.now() - pluginStartedAt >= PLUGIN_CONNECT_MAX_WAIT_S * 500) {
        showedHalfway = true;
        pluginSpinner.text = `Waiting for plugin connection (${Math.ceil((pluginDeadline - Date.now()) / 1000)}s left)…`;
      }
    }

    if (!pluginConnected) {
      pluginSpinner.stop();
      console.log(chalk.yellow('⚠ Plugin not detected yet — daemon is still listening.'));
      console.log(chalk.gray('\n  The daemon stays running in the background.'));
      console.log(chalk.gray('  Open ') + chalk.yellow(`Plugins → Development → ${designPluginName}`) + chalk.gray(' in Figma and paste your access key —'));
      console.log(chalk.gray('  the next command will connect automatically.\n'));
    }
  });
