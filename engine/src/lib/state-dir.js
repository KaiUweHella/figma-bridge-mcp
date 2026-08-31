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

function canonicalHomeDir() {
  const home = homedir();
  try {
    return fs.realpathSync.native(home);
  } catch {
    // A normal account home already exists. Keep the platform value only for
    // unusual bootstrap environments; the private-state policy will still
    // reject a non-canonical or unsafe Bridge root before using credentials.
    return home;
  }
}

const HOME_DIR = canonicalHomeDir();
const NEW_DIR = join(HOME_DIR, '.figma-bridge-mcp');
const OLD_DIR = join(HOME_DIR, '.figma-safe-mcp');

export const LOCAL_DEVELOPMENT_PROFILE = 'local-development';

export function isLocalDevelopmentProfile(env = process.env) {
  return env.FIGMA_BRIDGE_PROFILE === LOCAL_DEVELOPMENT_PROFILE;
}

function selectedStateDir(env = process.env) {
  const profile = String(env.FIGMA_BRIDGE_PROFILE || '').trim();
  if (!profile) return NEW_DIR;
  if (profile !== LOCAL_DEVELOPMENT_PROFILE) {
    throw new Error(
      `Unsupported FIGMA_BRIDGE_PROFILE "${profile}". Expected "${LOCAL_DEVELOPMENT_PROFILE}".`,
    );
  }
  return join(NEW_DIR, 'profiles', LOCAL_DEVELOPMENT_PROFILE);
}

/**
 * Migrate ~/.figma-safe-mcp → ~/.figma-bridge-mcp exactly once: only when the
 * old dir exists and the new one does not. If both exist the new dir wins and
 * the old one is left untouched (never destroy user state).
 */
function migrateOnce() {
  // The isolated contributor profile must never claim or move the installed
  // Bridge's legacy pairing. It owns a new key and plugin identity.
  if (isLocalDevelopmentProfile()) return;
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

// STATE_ROOT is the one exact private tree whose permissions are enforced.
// STATE_DIR is the active profile's storage namespace inside that tree.
export const STATE_ROOT = NEW_DIR;
export const STATE_DIR = selectedStateDir();
