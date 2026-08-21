// Shared local-image loading for every command that ships image bytes into
// Figma (`render`/`render-batch` via <Image src=…>, `node set-image`).
// One home for the size limits and their user-facing wording — these were
// duplicated across two commands within a single commit before.
import { isAbsolute, resolve } from 'path';
import chalk from 'chalk';
import { WorkspaceIOError, workspaceIO } from './workspace-io.js';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const IMAGE_HARD_LIMIT = 8 * 1024 * 1024; // Figma rejects far earlier; keeps the eval payload sane
export const IMAGE_WARN_LIMIT = 2 * 1024 * 1024;

/**
 * Read a local image file as base64 with the shared size guards.
 * Returns { b64 } on success or { error } with the message already printed
 * (callers decide whether an error is fatal or degrades to a placeholder).
 * A single statSync covers existence + size before any bytes are read.
 */
export function readImageBase64(file) {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  let size;
  let accepted;
  try {
    accepted = workspaceIO().authorizePath(path, { access: 'read', role: 'render-image', kind: 'file' });
    size = accepted.metadata.size;
  } catch (cause) {
    const error = cause instanceof WorkspaceIOError
      ? cause.message
      : 'Image file not found.';
    console.log(chalk.yellow(`⚠ ${error}`));
    return { error };
  }
  if (size > IMAGE_HARD_LIMIT) {
    const error = `Workspace render-image rejected: file is ${(size / 1048576).toFixed(1)} MB (> 8 MB); downscale it first (Figma caps images at 4096px anyway).`;
    console.log(chalk.yellow(`⚠ ${error}`));
    return { error };
  }
  if (size > IMAGE_WARN_LIMIT) {
    console.log(chalk.gray(`↳ Render image: ${(size / 1048576).toFixed(1)} MB — large images slow the plugin bridge; consider downscaling.`));
  }
  return {
    b64: workspaceIO().read(accepted.canonical, { role: 'render-image', maxBytes: IMAGE_HARD_LIMIT }).toString('base64'),
    path: accepted.canonical,
  };
}
