// Daemon port resolution — single source of truth for every layer.
//
// The daemon binds the first free port in PORT_RANGE (unless DAEMON_PORT is
// set explicitly) and publishes the bound port in a small state file. Short-
// lived consumers (engine CLI, MCP layer) resolve the port fresh per call:
//
//   env DAEMON_PORT  >  port file (integer within range)  >  DEFAULT_PORT
//
// PORT_RANGE mirrors plugin/manifest.json's ws://localhost allowlist — the
// Figma plugin scans exactly these ports, so a fallback bind stays reachable.
// Ports outside the range are honored when set via env but unsupported (the
// manifest is Figma-enforced and cannot be widened at runtime).
//
// Every function reads env at CALL time, not module load: a stale port file is
// self-healing (probe fails → daemon respawns → file rewritten) and tests can
// inject scratch env objects without mutating process.env.

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { STATE_DIR } from './state-dir.js';

export const DEFAULT_PORT = 3456;
export const PORT_RANGE = [3456, 3457, 3458, 3459, 3460];

export function portFilePath(env = process.env) {
  return env.DAEMON_PORT_FILE || join(STATE_DIR, 'daemon-port');
}

// Test hook: DAEMON_PORT_RANGE="a,b,c" replaces the manifest range so fallback
// tests can run on scratch ports without touching 3456-3460.
export function parsePortRange(env = process.env) {
  if (env.DAEMON_PORT_RANGE) {
    const ports = env.DAEMON_PORT_RANGE.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (ports.length) return ports;
  }
  return [...PORT_RANGE];
}

export function readPortFile(env = process.env) {
  try {
    const port = parseInt(readFileSync(portFilePath(env), 'utf8').trim(), 10);
    return parsePortRange(env).includes(port) ? port : null;
  } catch {
    return null;
  }
}

export function getDaemonPort(env = process.env) {
  const explicit = parseInt(env.DAEMON_PORT, 10);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit;
  return readPortFile(env) ?? parsePortRange(env)[0] ?? DEFAULT_PORT;
}

export function writePortFile(port, env = process.env) {
  try {
    const file = portFilePath(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(port));
  } catch {}
}

// `onlyIfPort`: a dying old daemon must not delete a newer daemon's file —
// pass its own bound port so the clear is a no-op when the file moved on.
export function clearPortFile(env = process.env, onlyIfPort = null) {
  try {
    const file = portFilePath(env);
    if (onlyIfPort !== null) {
      const current = parseInt(readFileSync(file, 'utf8').trim(), 10);
      if (current !== onlyIfPort) return;
    }
    unlinkSync(file);
  } catch {}
}
