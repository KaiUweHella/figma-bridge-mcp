/**
 * Cross-platform secure credential storage.
 * macOS: Keychain via `security` CLI
 * Windows: Credential Manager via `cmdkey`
 * Linux: ~/.config/figma-cli/credentials (chmod 600)
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SERVICE = 'figma-cli';
const PLATFORM = process.platform;

function linuxCredPath() {
  const dir = join(homedir(), '.config', 'figma-cli');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'credentials.json');
}

function readLinuxCreds() {
  const p = linuxCredPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeLinuxCreds(creds) {
  const p = linuxCredPath();
  writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
}

/**
 * Save a key securely.
 */
export function saveKey(name, value) {
  if (PLATFORM === 'darwin') {
    // Delete existing entry first (silently ignore if not found)
    try {
      execSync(`security delete-generic-password -s '${SERVICE}' -a '${name}' 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
    execSync(`security add-generic-password -s '${SERVICE}' -a '${name}' -w '${value.replace(/'/g, "'\\''")}'`, { stdio: 'ignore' });
    return;
  }

  if (PLATFORM === 'win32') {
    execSync(`cmdkey /generic:${SERVICE}:${name} /user:${SERVICE} /pass:${value}`, { stdio: 'ignore' });
    return;
  }

  // Linux fallback
  const creds = readLinuxCreds();
  creds[name] = value;
  writeLinuxCreds(creds);
}

/**
 * Get a key. Returns null if not found.
 */
export function getKey(name) {
  if (PLATFORM === 'darwin') {
    try {
      return execSync(`security find-generic-password -s '${SERVICE}' -a '${name}' -w 2>/dev/null`, { encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  }

  if (PLATFORM === 'win32') {
    try {
      const output = execSync(`cmdkey /list:${SERVICE}:${name}`, { encoding: 'utf-8' });
      // cmdkey /list doesn't actually show the password, so we use PowerShell
      const ps = execSync(
        `powershell -Command "[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Get-StoredCredential -Target '${SERVICE}:${name}').Password))"`,
        { encoding: 'utf-8' }
      ).trim();
      return ps || null;
    } catch {
      return null;
    }
  }

  // Linux fallback
  const creds = readLinuxCreds();
  return creds[name] || null;
}

/**
 * Delete a key.
 */
export function deleteKey(name) {
  if (PLATFORM === 'darwin') {
    try {
      execSync(`security delete-generic-password -s '${SERVICE}' -a '${name}' 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
    return;
  }

  if (PLATFORM === 'win32') {
    try {
      execSync(`cmdkey /delete:${SERVICE}:${name}`, { stdio: 'ignore' });
    } catch {}
    return;
  }

  const creds = readLinuxCreds();
  delete creds[name];
  writeLinuxCreds(creds);
}

/**
 * Mask a key for display: sk-ant-...xxxx
 */
export function maskKey(value) {
  if (!value) return '(not set)';
  if (value.length <= 12) return '****';
  return value.slice(0, 7) + '...' + value.slice(-4);
}

/**
 * Prompt for a key securely (hidden input with asterisks).
 * Returns the entered value.
 */
export function promptKeySecure(questionText) {
  return new Promise((resolve) => {
    process.stdout.write(questionText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');
    let input = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(wasRaw || false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\u007f' || ch === '\b') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}
