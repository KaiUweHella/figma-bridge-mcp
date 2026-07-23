/**
 * Figma Patch — SAFE-MODE STUB
 *
 * In the upstream figma-ds-cli this module patches Figma Desktop's app.asar
 * binary to enable Chrome DevTools remote debugging ("Yolo mode").
 *
 * In figma-safe-mcp that capability is deliberately removed: this build only
 * ever talks to Figma through the local plugin bridge (Safe Mode). The binary
 * patching functions are neutered so no code path can modify the Figma app.
 *
 * The read-only path/port helpers are kept (they delegate to platform.js) so
 * the import surface used by figma-client.js, figjam-client.js, cli-core.js and
 * commands/setup.js stays byte-compatible with upstream — this keeps future
 * upstream syncs to a targeted re-diff.
 */

import {
  getAsarPath as platformGetAsarPath,
  getFigmaBinaryPath as platformGetFigmaBinaryPath,
  getFigmaCommand as platformGetFigmaCommand
} from './platform.js';

// Fixed CDP port kept only because dead Yolo code paths still reference it.
// No CDP connection is ever opened in the Safe-Mode-only build.
const CDP_PORT = 9222;

/** Get the CDP port (kept for import compatibility; unused in Safe Mode). */
export function getCdpPort() {
  return CDP_PORT;
}

/** Path to Figma's app.asar (read-only helper, delegates to platform.js). */
export function getAsarPath() {
  return platformGetAsarPath();
}

/**
 * Safe Mode never patches Figma, so it is never "patched".
 * @returns {false}
 */
export function isPatched() {
  return false;
}

/**
 * Binary patching is disabled in this build.
 * @returns {false}
 */
export function canPatchFigma() {
  return false;
}

/** Binary patching removed in the Safe-Mode-only build. */
export function patchFigma() {
  throw new Error(
    'Binary patching (Yolo mode) is removed in figma-safe-mcp. Use Safe Mode: run figma_connect and launch the FigCli plugin in Figma.'
  );
}

/** Binary patching removed in the Safe-Mode-only build. */
export function unpatchFigma() {
  throw new Error(
    'Binary patching (Yolo mode) is removed in figma-safe-mcp; there is nothing to unpatch.'
  );
}

/** Command to start Figma (read-only helper, delegates to platform.js). */
export function getFigmaCommand(port = 9222) {
  return platformGetFigmaCommand(port);
}

/** Path to Figma binary (read-only helper, delegates to platform.js). */
export function getFigmaBinaryPath() {
  return platformGetFigmaBinaryPath();
}

export default {
  getAsarPath,
  isPatched,
  canPatchFigma,
  patchFigma,
  unpatchFigma,
  getFigmaCommand,
  getFigmaBinaryPath,
  getCdpPort
};
