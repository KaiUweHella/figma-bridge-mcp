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

/** @param {{explicitFileKey?: unknown, args?: unknown[]}} [options] */
export function resolveFigmaTarget({ explicitFileKey, args = [] } = {}) {
  const explicit = fileKeyFrom(explicitFileKey);
  if (explicit) return Object.freeze({ kind: 'plugin-file', fileKey: explicit, source: 'explicit' });
  for (const arg of args || []) {
    if (typeof arg !== 'string') continue;
    const match = FIGMA_FILE_URL_RE.exec(arg);
    if (match) return Object.freeze({ kind: 'plugin-file', fileKey: match[1], source: 'figma-url' });
  }
  return Object.freeze({ kind: 'plugin-file', fileKey: null, source: 'implicit-single-window' });
}

/** @param {string|{kind:string,fileKey?:unknown}|null|undefined} target */
export function targetFileKey(target) {
  if (target == null) return null;
  if (typeof target === 'string') return fileKeyFrom(target);
  if (target.kind !== 'plugin-file') return null;
  return fileKeyFrom(target.fileKey);
}
