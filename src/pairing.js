// Plugin access-key management.
//
// The access key authenticates the Figma plugin's WebSocket connection to the
// local daemon. It is generated here (MCP layer), stored 0600, and:
//   - passed to the daemon via the PLUGIN_KEY_FILE env var (see config.js), and
//   - displayed once to the user so they can paste it into the FigCli plugin.
//
// This is the "security of figma-console-mcp" half of the design: without a
// matching key, no local process can drive Figma through the plugin bridge.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PLUGIN_KEY_FILE, STATE_DIR } from "./config.js";

/**
 * Read the current plugin access key, or null if none has been generated yet.
 * @returns {string|null}
 */
export function readKey() {
  try {
    const k = fs.readFileSync(PLUGIN_KEY_FILE, "utf8").trim();
    return k || null;
  } catch {
    return null;
  }
}

/**
 * Generate and persist a fresh access key (0600), overwriting any existing one.
 * @returns {string} the new key
 */
export function generateKey() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // 32 random bytes → 43-char base64url string, paste-friendly (no padding).
  const key = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(PLUGIN_KEY_FILE, key, { mode: 0o600 });
  // Tighten in case the file pre-existed with looser perms.
  try {
    fs.chmodSync(PLUGIN_KEY_FILE, 0o600);
  } catch {
    // best-effort
  }
  return key;
}

/**
 * Return the existing key, generating one lazily if absent.
 * @returns {{ key: string, created: boolean }}
 */
export function ensureKey() {
  const existing = readKey();
  if (existing) return { key: existing, created: false };
  return { key: generateKey(), created: true };
}

/**
 * Force-rotate the key. Any previously paired plugin will be rejected on its
 * next (re)connect until the user pastes the new key. Requires a daemon restart
 * to take effect, since the daemon reads the key file at startup.
 * @returns {string} the new key
 */
export function rotateKey() {
  return generateKey();
}

/** Absolute path of the key file (for display / debugging). */
export function keyPath() {
  return path.resolve(PLUGIN_KEY_FILE);
}
