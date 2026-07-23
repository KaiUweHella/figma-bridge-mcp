/**
 * Platform-specific helpers.
 * Only defines functions for the current platform — no Windows code loaded on Mac, etc.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const PLATFORM = process.platform;

// --- Null device ---
export const nullDevice = PLATFORM === 'win32' ? 'NUL' : '/dev/null';

// --- Port cleanup ---
function killPortUnix(port) {
  const portCheck = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' });
  if (portCheck.trim()) {
    try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' }); } catch {}
    try { execSync('sleep 0.3', { stdio: 'pipe' }); } catch {}
  }
}

function killPortWindows(port) {
  try {
    const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
    const lines = result.split('\n').filter(l => l.includes('LISTENING'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) {
        execSync(`taskkill /PID ${pid} /F 2>nul`, { stdio: 'pipe' });
      }
    }
    try { execSync('ping -n 1 127.0.0.1 >nul', { stdio: 'pipe' }); } catch {}
  } catch {}
}

export const killPort = PLATFORM === 'win32' ? killPortWindows : killPortUnix;

// --- Get PID listening on port ---
function getPortPidUnix(port) {
  return execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' }).trim() || null;
}

function getPortPidWindows(port) {
  const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' });
  const line = result.split('\n').find(l => l.includes('LISTENING'));
  if (line) {
    const parts = line.trim().split(/\s+/);
    return parts[parts.length - 1] || null;
  }
  return null;
}

export const getPortPid = PLATFORM === 'win32' ? getPortPidWindows : getPortPidUnix;

// --- Sleep after daemon stop ---
export function sleepAfterStop() {
  if (PLATFORM === 'win32') {
    try { execSync('ping -n 2 127.0.0.1 >nul', { stdio: 'pipe' }); } catch {}
  } else {
    try { execSync('sleep 0.5', { stdio: 'pipe' }); } catch {}
  }
}

// --- Start Figma ---
export function startFigmaApp(figmaPath, port) {
  if (PLATFORM === 'darwin') {
    execSync(`open -a Figma --args --remote-debugging-port=${port}`, { stdio: 'pipe' });
  } else {
    spawn(figmaPath, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// --- Kill Figma ---
export function killFigmaApp() {
  try {
    if (PLATFORM === 'darwin') {
      execSync('pkill -x Figma 2>/dev/null || true', { stdio: 'pipe' });
    } else if (PLATFORM === 'win32') {
      execSync('taskkill /IM Figma.exe /F 2>nul', { stdio: 'pipe' });
    } else {
      execSync('pkill -x figma 2>/dev/null || true', { stdio: 'pipe' });
    }
  } catch {}
}

// --- Figma paths (asar, binary, command) ---

// Windows-only helpers (only defined on Windows)
let findWindowsFigmaPath, findWindowsFigmaExe;

if (PLATFORM === 'win32') {
  findWindowsFigmaPath = function() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;

    const figmaBase = join(localAppData, 'Figma');
    if (!existsSync(figmaBase)) return null;

    try {
      const entries = readdirSync(figmaBase);
      const appFolders = entries
        .filter(e => e.startsWith('app-'))
        .sort()
        .reverse();

      for (const folder of appFolders) {
        const asarPath = join(figmaBase, folder, 'resources', 'app.asar');
        if (existsSync(asarPath)) return asarPath;
      }

      const oldPath = join(figmaBase, 'resources', 'app.asar');
      if (existsSync(oldPath)) return oldPath;
    } catch {}

    return null;
  };

  findWindowsFigmaExe = function() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;

    const figmaBase = join(localAppData, 'Figma');
    const mainExe = join(figmaBase, 'Figma.exe');
    if (existsSync(mainExe)) return mainExe;

    try {
      const entries = readdirSync(figmaBase);
      const appFolders = entries
        .filter(e => e.startsWith('app-'))
        .sort()
        .reverse();

      for (const folder of appFolders) {
        const exePath = join(figmaBase, folder, 'Figma.exe');
        if (existsSync(exePath)) return exePath;
      }
    } catch {}

    return null;
  };
}

const ASAR_PATHS = {
  darwin: '/Applications/Figma.app/Contents/Resources/app.asar',
  linux: '/opt/figma/resources/app.asar'
};

export function getAsarPath() {
  if (PLATFORM === 'win32') return findWindowsFigmaPath();
  return ASAR_PATHS[PLATFORM] || null;
}

export function getFigmaBinaryPath() {
  switch (PLATFORM) {
    case 'darwin':
      return '/Applications/Figma.app/Contents/MacOS/Figma';
    case 'win32':
      return findWindowsFigmaExe() || `${process.env.LOCALAPPDATA}\\Figma\\Figma.exe`;
    case 'linux':
      return '/usr/bin/figma';
    default:
      return null;
  }
}

export function getFigmaCommand(port = 9222) {
  switch (PLATFORM) {
    case 'darwin':
      return `open -a Figma --args --remote-debugging-port=${port}`;
    case 'win32': {
      const exePath = findWindowsFigmaExe();
      if (exePath) return `"${exePath}" --remote-debugging-port=${port}`;
      return `"%LOCALAPPDATA%\\Figma\\Figma.exe" --remote-debugging-port=${port}`;
    }
    case 'linux':
      return `figma --remote-debugging-port=${port}`;
    default:
      return null;
  }
}

// --- Doctor helpers ---
export function getFigmaVersion() {
  if (PLATFORM === 'darwin') {
    return execSync('defaults read /Applications/Figma.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null', { encoding: 'utf8' }).trim();
  } else if (PLATFORM === 'win32') {
    return execSync('powershell -command "(Get-Item \\"$env:LOCALAPPDATA\\Figma\\Figma.exe\\").VersionInfo.ProductVersion" 2>nul', { encoding: 'utf8' }).trim() || 'unknown';
  }
  return 'unknown';
}

export function isFigmaRunning() {
  if (PLATFORM === 'darwin' || PLATFORM === 'linux') {
    const ps = execSync('pgrep -f Figma 2>/dev/null || true', { encoding: 'utf8' });
    return ps.trim().length > 0;
  } else if (PLATFORM === 'win32') {
    const ps = execSync('tasklist /FI "IMAGENAME eq Figma.exe" 2>nul', { encoding: 'utf8' });
    return ps.includes('Figma.exe');
  }
  return false;
}

export const platformName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[PLATFORM] || PLATFORM;
