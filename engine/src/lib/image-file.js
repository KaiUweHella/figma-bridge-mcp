// Shared local-image loading for every command that ships image bytes into
// Figma (`render`/`render-batch` via <Image src=…>, `node set-image`).
// One home for the size limits and their user-facing wording — these were
// duplicated across two commands within a single commit before.
import { isAbsolute, resolve } from 'path';
import chalk from 'chalk';
import { WorkspaceIOError, workspaceIO } from './workspace-io.js';
import { MAX_PROTOCOL_VALUE_BYTES } from './protocol-contract.js';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Inbound image bytes have exactly one way into Figma: base64 inside the
// plugin payload (an eval source or a render plan). The asset stream is an
// export path only. Base64 inflates a file by 4/3, and the protocol caps one
// value at MAX_PROTOCOL_VALUE_BYTES, so the ceiling must leave the code or
// plan JSON around the bytes room under that limit; the headroom is derived
// and image-file.test.js keeps it comfortable. The 8 MB this used to advertise
// was unreachable by arithmetic -- 8 MB becomes ~10.7 MB of base64 -- so a
// file between ~3.7 and 8 MB failed at the transport instead of here, with a
// protocol error in place of this guidance.
export const IMAGE_HARD_LIMIT = 3_500_000;
export const INBOUND_MEDIA_HEADROOM_BYTES = MAX_PROTOCOL_VALUE_BYTES
  - Math.ceil(IMAGE_HARD_LIMIT / 3) * 4;
export const IMAGE_WARN_LIMIT = 2 * 1024 * 1024;

/** The one sentence every inbound image refusal shares, so the reason is stated once. */
export function inboundImageCeilingGuidance() {
  return `Image bytes ride inside the plugin payload as base64 (4/3 of the file size) against a ${MAX_PROTOCOL_VALUE_BYTES} byte protocol limit; downscale it first (Figma caps images at 4096px anyway).`;
}

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
    const error = `Workspace render-image rejected: file is ${size} bytes, over the ${IMAGE_HARD_LIMIT} byte ceiling. ${inboundImageCeilingGuidance()}`;
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
