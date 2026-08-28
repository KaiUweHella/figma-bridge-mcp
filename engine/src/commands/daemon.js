// Commands: daemon (extracted from index.js)
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { getPortPids } from '../platform.js';
import {
  program,
  DAEMON_PID_FILE,
  getDaemonPort,
  daemonExec,
  daemonReconnect,
  getTokenStatus,
  isDaemonRunning,
  startDaemon,
  stopDaemon
} from '../lib/cli-core.js';

// ============ DAEMON ============

const daemon = program
  .command('daemon')
  .description('Manage the speed daemon');

daemon
  .command('status')
  .description('Check if daemon is running')
  .option('--debug', 'Show detailed token and connection info')
  .action(async (options) => {
    const details = await isDaemonRunning(true);
    const tokenStatus = getTokenStatus();

    if (options.debug) {
      console.log(chalk.bold('\nDaemon Status'));
      console.log(chalk.gray('─'.repeat(50)));

      // Connection status
      if (details.running) {
        console.log(chalk.green('✓ Daemon:    ') + 'Running on port ' + getDaemonPort());
      } else if (details.authFailed) {
        console.log(chalk.red('✗ Daemon:    ') + 'Running but authentication failed (403)');
      } else if (details.error) {
        console.log(chalk.yellow('○ Daemon:    ') + 'Not responding');
      } else {
        console.log(chalk.yellow('○ Daemon:    ') + 'Not running');
      }

      // Token status
      console.log();
      console.log(chalk.bold('Token Info'));
      console.log(chalk.gray('  Config dir:   ') + tokenStatus.configDir);
      console.log(chalk.gray('  Token file:   ') + tokenStatus.tokenPath);
      console.log(chalk.gray('  Dir exists:   ') + (tokenStatus.configDirExists ? chalk.green('Yes') : chalk.red('No')));
      console.log(chalk.gray('  File exists:  ') + (tokenStatus.tokenFileExists ? chalk.green('Yes') : chalk.red('No')));

      if (tokenStatus.tokenPreview) {
        console.log(chalk.gray('  Token:        ') + tokenStatus.tokenPreview);
      } else if (tokenStatus.readError) {
        console.log(chalk.red('  Read error:   ') + tokenStatus.readError);
      }

      // Troubleshooting
      if (details.authFailed) {
        console.log();
        console.log(chalk.yellow('⚠ Token mismatch detected'));
        console.log(chalk.gray('  The daemon has a different token than the CLI.'));
        console.log(chalk.gray('  Fix: ') + chalk.cyan('node src/index.js daemon restart'));
      } else if (!tokenStatus.tokenFileExists && !details.running) {
        console.log();
        console.log(chalk.yellow('⚠ No token file found'));
        console.log(chalk.gray('  Fix: ') + chalk.cyan('node src/index.js connect'));
      }

      console.log();
    } else {
      // Simple output
      if (details.running) {
        console.log(chalk.green('✓ Daemon is running on port ' + getDaemonPort()));
      } else if (details.authFailed) {
        console.log(chalk.red('✗ Daemon running but auth failed (token mismatch)'));
        console.log(chalk.gray('  Fix: node src/index.js daemon restart'));
        console.log(chalk.gray('  Debug: node src/index.js daemon status --debug'));
      } else {
        console.log(chalk.yellow('○ Daemon is not running'));
        console.log(chalk.gray('  Run "node src/index.js connect" to start it'));
      }
    }
  });

daemon
  .command('start')
  .description('Start the daemon manually')
  .option('--force', 'Force restart even if already running')
  .action(async (options) => {
    const details = await isDaemonRunning(true);

    if (details.running && !options.force) {
      console.log(chalk.green('✓ Daemon already running'));
      return;
    }

    if (details.authFailed) {
      console.log(chalk.yellow('⚠ Daemon running but auth failed, forcing restart...'));
      options.force = true;
    }

    console.log(chalk.blue('Starting daemon...'));
    await startDaemon(options.force, 'auto');
    await new Promise(r => setTimeout(r, 1500));

    const newDetails = await isDaemonRunning(true);
    if (newDetails.running) {
      console.log(chalk.green('✓ Daemon started on port ' + getDaemonPort()));
    } else if (newDetails.authFailed) {
      console.log(chalk.red('✗ Daemon started but auth failed'));
      console.log(chalk.gray('  Run: node src/index.js daemon diagnose'));
    } else {
      console.log(chalk.red('✗ Failed to start daemon'));
      console.log(chalk.gray('  Run: node src/index.js daemon diagnose'));
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    console.log(chalk.blue('Stopping daemon...'));
    await stopDaemon();
    console.log(chalk.green('✓ Daemon stopped'));
  });

daemon
  .command('restart')
  .description('Restart the daemon (regenerates token)')
  .action(async () => {
    console.log(chalk.blue('Restarting daemon...'));
    // Use forceRestart=true to ensure clean restart with new token
    await startDaemon(true, 'auto');
    await new Promise(r => setTimeout(r, 1500));

    const details = await isDaemonRunning(true);
    if (details.running) {
      console.log(chalk.green('✓ Daemon restarted with fresh token'));
    } else if (details.authFailed) {
      console.log(chalk.red('✗ Daemon running but auth failed'));
      console.log(chalk.gray('  Try: node src/index.js daemon diagnose'));
    } else {
      console.log(chalk.red('✗ Failed to restart daemon'));
      console.log(chalk.gray('  Try: node src/index.js daemon diagnose'));
    }
  });

daemon
  .command('reconnect')
  .description('Reconnect to Figma (use if connection is stale)')
  .action(async () => {
    if (!(await isDaemonRunning())) {
      console.log(chalk.yellow('○ Daemon is not running'));
      console.log(chalk.gray('  Run "node src/index.js connect" first'));
      return;
    }
    console.log(chalk.blue('Reconnecting to Figma...'));
    try {
      const response = await daemonReconnect();
      const result = response.data || {};
      if (!response.ok) throw new Error(result.error || `Daemon answered HTTP ${response.status}`);
      if (result.error) {
        console.log(chalk.red('✗ Reconnect failed: ' + result.error));
      } else if (result.hadPlugin) {
        console.log(chalk.green(
          result.reloaded > 0
            ? `✓ Reloaded ${result.reloaded} plugin UI${result.reloaded === 1 ? '' : 's'} — reconnecting automatically`
            : '✓ Reset the unresponsive plugin socket — reconnecting automatically'
        ));
      } else {
        console.log(chalk.yellow('○ No plugin was connected. Open Plugins → Development → Figma Bridge in Figma.'));
      }
    } catch (e) {
      console.log(chalk.red('✗ Failed: ' + e.message));
      process.exitCode = 1;
    }
  });

daemon
  .command('diagnose')
  .description('Diagnose daemon connection issues')
  .action(async () => {
    console.log(chalk.bold('\n🔍 Daemon Diagnostics\n'));

    const tokenStatus = getTokenStatus();
    const details = await isDaemonRunning(true);

    // Step 1: Check token file
    console.log(chalk.bold('1. Token File'));
    console.log(chalk.gray('   Path: ') + tokenStatus.tokenPath);

    if (!tokenStatus.configDirExists) {
      console.log(chalk.red('   ✗ Config directory does not exist'));
      console.log(chalk.gray('     Fix: Run "node src/index.js connect"'));
    } else if (!tokenStatus.tokenFileExists) {
      console.log(chalk.red('   ✗ Token file does not exist'));
      console.log(chalk.gray('     Fix: Run "node src/index.js connect"'));
    } else if (tokenStatus.readError) {
      console.log(chalk.red('   ✗ Cannot read token: ' + tokenStatus.readError));
    } else {
      console.log(chalk.green('   ✓ Token exists: ') + tokenStatus.tokenPreview);
    }

    // Step 2: Check if port is in use
    console.log();
    console.log(chalk.bold('2. Port ' + getDaemonPort()));

    let portPids = [];
    let portInspectionError = null;
    try {
      portPids = getPortPids(getDaemonPort());
    } catch (error) {
      portInspectionError = error;
    }

    if (portInspectionError) {
      console.log(chalk.red('   ✗ Listener inspection unavailable'));
      console.log(chalk.gray('     ' + portInspectionError.message));
    } else if (portPids.length > 0) {
      console.log(chalk.green('   ✓ Port in use by PID: ') + portPids.join(', '));

      // Check if it matches our PID file
      let savedPid = null;
      try {
        const rawSavedPid = readFileSync(DAEMON_PID_FILE, 'utf8').trim();
        if (/^\d+$/.test(rawSavedPid)) savedPid = Number(rawSavedPid);
      } catch {}

      if (Number.isInteger(savedPid) && portPids.includes(savedPid)) {
        console.log(chalk.green('   ✓ PID matches saved daemon PID'));
      } else if (Number.isInteger(savedPid)) {
        console.log(chalk.yellow('   ⚠ PID mismatch! Saved: ' + savedPid + ', Actual: ' + portPids.join(', ')));
        console.log(chalk.gray('     This may cause auth issues. Fix: "node src/index.js daemon restart"'));
      }
    } else {
      console.log(chalk.yellow('   ○ Port not in use (daemon not running)'));
    }

    // Step 3: Test authentication
    console.log();
    console.log(chalk.bold('3. Authentication'));

    if (!details.running && !details.authFailed) {
      console.log(chalk.yellow('   ○ Daemon not responding, cannot test auth'));
    } else if (details.authFailed) {
      console.log(chalk.red('   ✗ Auth failed (403 Unauthorized)'));
      console.log(chalk.gray('     The daemon has a different token than the CLI.'));
      console.log(chalk.gray('     This happens when the daemon was started with an old token.'));
      console.log(chalk.gray('     Fix: "node src/index.js daemon restart"'));
    } else if (details.running) {
      console.log(chalk.green('   ✓ Authentication successful'));
    }

    // Step 4: Test eval
    console.log();
    console.log(chalk.bold('4. Eval Test'));

    if (details.running) {
      try {
        const result = await daemonExec('eval', { code: 'return "pong"' }, 5000);
        if (result === 'pong') {
          console.log(chalk.green('   ✓ Eval working: ping → pong'));
        } else {
          console.log(chalk.yellow('   ⚠ Unexpected result: ' + JSON.stringify(result)));
        }
      } catch (e) {
        console.log(chalk.red('   ✗ Eval failed: ' + e.message.split('\n')[0]));
        process.exitCode = 1;
      }
    } else {
      console.log(chalk.yellow('   ○ Skipped (daemon not running)'));
    }

    // Summary
    console.log();
    console.log(chalk.gray('─'.repeat(50)));

    if (details.running) {
      console.log(chalk.green('✓ Daemon is healthy'));
    } else if (details.authFailed) {
      console.log(chalk.red('✗ Token mismatch - run: node src/index.js daemon restart'));
    } else if (!tokenStatus.tokenFileExists) {
      console.log(chalk.red('✗ No token - run: node src/index.js connect'));
    } else {
      console.log(chalk.yellow('○ Daemon not running - run: node src/index.js connect'));
    }

    console.log();
  });
