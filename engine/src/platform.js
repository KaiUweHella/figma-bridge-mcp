/**
 * Platform-specific helpers.
 * Only defines functions for the current platform — no Windows code loaded on Mac, etc.
 */

import { execSync } from 'child_process';

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

// (The Figma-path helpers — asar locations, Figma.exe discovery — and the
// doctor probes getFigmaVersion/isFigmaRunning served the removed Yolo/patching
// path and the removed `doctor` command. Deleted with them.)
