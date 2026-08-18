/**
 * Node-id normalization — the tools accept exactly what a user has at hand:
 *  - canonical ids            "12:34", instance paths "I12:34;56:78"
 *  - URL-style dash ids       "12-34"           (what figma.com puts in ?node-id=)
 *  - full Figma URLs          "https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=12-34"
 *
 * Pure: returns { id, fileKey?, warning? } and never throws on odd input —
 * unparseable strings pass through unchanged so the plugin's own not-found
 * error (which names the open file) stays the single source of truth.
 */

const URL_RE = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)[^?#]*/;

/** "12-34" → "12:34"; instance-path segments each converted too. */
function dashesToColons(id) {
  // Only rewrite when the whole string is made of digit-dash-digit segments
  // (optionally an instance path with I/; separators) — never touch names.
  if (/^I?[0-9]+[-:][0-9]+(;[0-9]+[-:][0-9]+)*$/.test(id)) {
    return id.replace(/(\d)-(\d)/g, '$1:$2');
  }
  return id;
}

/**
 * Normalize any node-id-ish input. Returns:
 *  - id: the canonical id to hand to figma.getNodeByIdAsync
 *  - fileKey: set when the input was a URL (so callers can warn that Safe
 *    Mode only reaches the currently open file)
 *  - warning: human-readable caution when a URL names a file key
 */
export function normalizeNodeId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { id: raw };

  const urlMatch = raw.match(URL_RE);
  if (urlMatch) {
    const fileKey = urlMatch[1];
    let nodeParam = null;
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      nodeParam = u.searchParams.get('node-id');
    } catch {
      const m = raw.match(/[?&]node-id=([^&#]+)/);
      if (m) nodeParam = decodeURIComponent(m[1]);
    }
    if (!nodeParam) {
      return {
        id: raw, fileKey,
        warning: `URL has no node-id parameter — pass a node id like "12:34" (file key: ${fileKey}).`,
      };
    }
    return {
      id: dashesToColons(nodeParam.trim()),
      fileKey,
      warning:
        `id taken from a URL for Figma file ${fileKey}. Safe Mode only reaches the file ` +
        `currently open in Figma Desktop — if that is a different file, the node will not be found.`,
    };
  }

  return { id: dashesToColons(raw) };
}
