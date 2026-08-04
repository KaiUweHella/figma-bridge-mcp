// Single source of truth for the local state directory (~/.figma-bridge-mcp).
//
// Holds the daemon token/pid/port files, the plugin access key, the optional
// REST token, config.json and the audit log. Previously this path was
// hardcoded as ~/.figma-safe-mcp in five places; the rename to
// figma-bridge-mcp centralizes it here, with a one-time migration so existing
// pairings (plugin key, daemon token) survive the upgrade.
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NEW_DIR = join(homedir(), '.figma-bridge-mcp');
const OLD_DIR = join(homedir(), '.figma-safe-mcp');

/**
 * Migrate ~/.figma-safe-mcp → ~/.figma-bridge-mcp exactly once: only when the
 * old dir exists and the new one does not. If both exist the new dir wins and
 * the old one is left untouched (never destroy user state).
 */
function migrateOnce() {
  try {
    if (fs.existsSync(NEW_DIR) || !fs.existsSync(OLD_DIR)) return;
    try {
      fs.renameSync(OLD_DIR, NEW_DIR);
    } catch {
      // Cross-device or permission edge: copy instead, keep the old dir as a
      // harmless leftover rather than risking a partial move.
      fs.cpSync(OLD_DIR, NEW_DIR, { recursive: true });
    }
  } catch {
    // best-effort — worst case the user re-pairs
  }
}

migrateOnce();

export const STATE_DIR = NEW_DIR;
