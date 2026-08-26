import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { createWorkspaceIO } from './workspace-io.js';
import { IMAGE_HARD_LIMIT } from './image-file.js';

export const BROWSER_CAPTURE_ASSET_LIMITS = Object.freeze({
  references: 20_000,
  uniqueAssets: 500,
  svgBytes: 100 * 1024,
  rasterBytes: IMAGE_HARD_LIMIT,
  totalBytes: 32 * 1024 * 1024,
});

function safeSourceLabel(url) {
  return `${url.origin}${url.pathname}`;
}

function projectPathFromUrl(url, projectRoot) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new Error('DOM image URL contains invalid path encoding'); }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
    throw new Error('DOM image URL contains an unsafe path');
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('DOM image URL traverses outside the project asset root');
  }
  if (!segments.length) throw new Error('DOM image URL has no project-relative asset path');
  return join(projectRoot, ...segments);
}

function assertSafeSvg(markup, label) {
  if (!/^\s*<svg\b/i.test(markup)) throw new Error(`DOM SVG asset is not SVG markup: ${label}`);
  if (/<!doctype|<!entity|<script\b|<foreignObject\b|\son[a-z]+\s*=/i.test(markup)) {
    throw new Error(`DOM SVG asset contains active or unsupported content: ${label}`);
  }
  if (/\b(?:href|xlink:href)\s*=\s*["'](?!#)[^"']+/i.test(markup)
    || /url\(\s*["']?https?:/i.test(markup)) {
    throw new Error(`DOM SVG asset contains an external reference: ${label}`);
  }
  return markup;
}

function rasterKind(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/**
 * Resolve browser `<img>` URLs without granting either the host or Plugin
 * ambient network access. The Design Link manifest directory is the explicit
 * application root; URL pathnames are mapped beneath it and read through a
 * dedicated WorkspaceIO authority with symlink containment and byte limits.
 */
export function resolveBrowserCaptureAssets(capture, {
  projectRoot,
  limits = BROWSER_CAPTURE_ASSET_LIMITS,
} = {}) {
  if (!capture?.root || !projectRoot) {
    throw new Error('DOM image resolution requires a capture root and an explicit project root');
  }
  const pending = [capture.root];
  let pendingImages = 0;
  while (pending.length) {
    const current = pending.pop();
    if (current?.asset?.kind === 'image') pendingImages++;
    for (const child of Array.isArray(current?.children) ? current.children : []) pending.push(child);
  }
  if (!pendingImages) {
    return {
      capture,
      diagnostics: {
        references: 0, uniqueAssets: 0, uniqueContent: 0,
        svgAssets: 0, rasterAssets: 0, totalBytes: 0,
        policy: 'project-root-bytes',
      },
    };
  }
  let documentOrigin;
  try { documentOrigin = new URL(String(capture.documentOrigin || '')); }
  catch { throw new Error('DOM image resolution requires capture.documentOrigin; recapture with the current browser script'); }
  if (!['http:', 'https:'].includes(documentOrigin.protocol)) {
    throw new Error('DOM image resolution requires an HTTP(S) document origin');
  }

  const io = createWorkspaceIO({ root: projectRoot });
  const materialized = new Map();
  const digests = new Set();
  let references = 0;
  let totalBytes = 0;
  let svgAssets = 0;
  let rasterAssets = 0;

  const resolveNode = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.asset?.kind === 'image') {
      references++;
      if (references > limits.references) throw new Error(`DOM image references exceed ${limits.references}`);
      let url;
      try { url = new URL(String(node.asset.src || ''), documentOrigin); }
      catch { throw new Error('DOM image source is not a valid URL'); }
      if (url.origin !== documentOrigin.origin) {
        throw new Error(`Cross-origin DOM image requires the bounded remote-asset pipeline: ${safeSourceLabel(url)}`);
      }
      const file = projectPathFromUrl(url, projectRoot);
      let resolved = materialized.get(file);
      if (!resolved) {
        if (materialized.size >= limits.uniqueAssets) throw new Error(`DOM image assets exceed ${limits.uniqueAssets} unique files`);
        const extension = extname(file).toLowerCase();
        const maxBytes = extension === '.svg' ? limits.svgBytes : limits.rasterBytes;
        const bytes = io.read(file, { role: 'dom-image-asset', maxBytes });
        totalBytes += bytes.length;
        if (totalBytes > limits.totalBytes) throw new Error(`DOM image assets exceed ${limits.totalBytes} total bytes`);
        const digest = createHash('sha256').update(bytes).digest('hex');
        digests.add(digest);
        const label = safeSourceLabel(url);
        if (extension === '.svg') {
          resolved = { kind: 'svg', markup: assertSafeSvg(bytes.toString('utf8'), label), digest };
          svgAssets++;
        } else {
          const kind = rasterKind(bytes);
          const expected = extension === '.jpg' ? 'jpeg' : extension.slice(1);
          if (!kind || !['png', 'jpeg', 'gif', 'webp'].includes(expected) || kind !== expected) {
            throw new Error(`DOM raster asset type does not match its bytes: ${label}`);
          }
          resolved = {
            kind: 'raster',
            asset: { kind: 'embedded-raster', name: file.split('/').at(-1), base64: bytes.toString('base64') },
            digest,
          };
          rasterAssets++;
        }
        materialized.set(file, resolved);
      }
      if (resolved.kind === 'svg') {
        node.svg = resolved.markup;
        node.asset = null;
      } else {
        node.asset = resolved.asset;
      }
    }
    for (const child of Array.isArray(node.children) ? node.children : []) resolveNode(child);
  };
  resolveNode(capture.root);
  return {
    capture,
    diagnostics: {
      references,
      uniqueAssets: materialized.size,
      uniqueContent: digests.size,
      svgAssets,
      rasterAssets,
      totalBytes,
      policy: 'project-root-bytes',
    },
  };
}
