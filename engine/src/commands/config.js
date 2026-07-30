// Commands: config (extracted from index.js)
import chalk from 'chalk';
import { program, loadConfig, saveConfig } from '../lib/cli-core.js';

// ============ CONFIG ============

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value')
  .action((key, value) => {
    const config = loadConfig();
    config[key] = value;
    saveConfig(config);
    console.log(chalk.green('✓ Config saved: ') + chalk.gray(key + ' = ' + value.substring(0, 10) + '...'));
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key) => {
    const config = loadConfig();
    if (config[key]) {
      console.log(config[key]);
    } else {
      console.log(chalk.gray('Not set'));
    }
  });
