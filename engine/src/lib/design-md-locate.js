// Locate a DESIGN.md (any name) in cwd or one level of subdirs. CLI-side file
// reads only — no model tokens spent scanning. Shared by `spec` and `instantiate`.
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const MARKER = 'Sample variant structure:';   // a DESIGN.md with a Components section

export function locateDesignMd(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const cwd = process.cwd();
  const candidates = [];
  const scanDir = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.') || e === 'node_modules') continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isFile() && e.endsWith('.md')) candidates.push(p);
      else if (st.isDirectory() && depth > 0) scanDir(p, depth - 1);
    }
  };
  scanDir(cwd, 1);
  // Prefer files that actually contain a Components section.
  for (const f of candidates) {
    try { if (readFileSync(f, 'utf8').includes(MARKER)) return f; } catch {}
  }
  return null;
}
