// Figma Target Context.
//
// One resolved object accompanies a Figma Command from adapter input through
// Command Capability planning, audit, background identity and Daemon Client.
// Callers no longer need to know URL parsing or precedence rules.

const FIGMA_FILE_URL_RE = /^https?:\/\/(?:www\.)?figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/i;

/** @param {unknown} value */
function fileKeyFrom(value) {
  if (value == null || !String(value).trim()) return null;
  const raw = String(value).trim();
  return FIGMA_FILE_URL_RE.exec(raw)?.[1] || raw;
}

/**
 * Resolve target precedence once. `registryFileKey` is lazy because reading the
 * Design Link Registry is unnecessary when the caller or a Figma URL already
 * supplied a stronger target.
 *
 * @param {{explicitFileKey?: unknown, args?: readonly unknown[], figmaUrlArgs?: readonly unknown[], registryFileKey?: unknown|((args:readonly unknown[])=>unknown)}} [options]
 */
export function resolveFigmaTarget({
  explicitFileKey,
  args = [],
  figmaUrlArgs = args,
  registryFileKey,
} = {}) {
  const explicit = fileKeyFrom(explicitFileKey);
  if (explicit) return Object.freeze({ kind: 'plugin-file', fileKey: explicit, source: 'explicit' });
  // A Command Application may canonicalize a node URL to its node id before
  // execution. Targeting still observes the original Adapter input, while a
  // registry resolver receives the prepared argv it understands.
  for (const arg of figmaUrlArgs || []) {
    if (typeof arg !== 'string') continue;
    const match = FIGMA_FILE_URL_RE.exec(arg);
    if (match) return Object.freeze({ kind: 'plugin-file', fileKey: match[1], source: 'figma-url' });
  }
  const registry = fileKeyFrom(typeof registryFileKey === 'function' ? registryFileKey(args) : registryFileKey);
  if (registry) return Object.freeze({ kind: 'plugin-file', fileKey: registry, source: 'design-link-registry' });
  return Object.freeze({ kind: 'plugin-file', fileKey: null, source: 'implicit-single-window' });
}

/** @param {string|{kind:string,fileKey?:unknown}|null|undefined} target */
export function targetFileKey(target) {
  if (target == null) return null;
  if (typeof target === 'string') return fileKeyFrom(target);
  if (target.kind !== 'plugin-file') return null;
  return fileKeyFrom(target.fileKey);
}
