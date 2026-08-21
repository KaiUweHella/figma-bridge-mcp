// Locate a DESIGN.md (any name) in cwd or one level of subdirs. CLI-side file
// reads only — no model tokens spent scanning. Used by `spec`.
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createWorkspaceIO, workspaceIO } from './workspace-io.js';

const MARKER = 'Sample variant structure:';   // a DESIGN.md with a Components section

export function locateDesignMd(explicit, searchRoot = process.cwd()) {
  const io = process.env.FIGMA_BRIDGE_WORKSPACE_ROOTS
    ? workspaceIO()
    : createWorkspaceIO({ root: explicit ? join(explicit, '..') : searchRoot });
  if (explicit) {
    try {
      io.authorizePath(explicit, {
        access: 'read', role: 'design-spec-file', kind: 'file',
      });
      return explicit;
    } catch { return null; }
  }
  const cwd = searchRoot;
  const candidates = [];
  const scanDir = (dir, depth) => {
    let canonical;
    let entries;
    try {
      canonical = io.authorizePath(dir, {
        access: 'read', role: 'design-spec-search', kind: 'directory',
      }).canonical;
      entries = readdirSync(canonical).slice(0, 10_000);
    } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = join(canonical, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile() && e.endsWith('.md')) candidates.push(p);
      else if (st.isDirectory() && depth > 0) scanDir(p, depth - 1);
    }
  };
  scanDir(cwd, 1);
  // Prefer files that actually contain a Components section.
  for (const f of candidates) {
    try {
      if (io.readText(f, { role: 'design-spec-file' }).includes(MARKER)) return f;
    } catch {}
  }
  return null;
}
