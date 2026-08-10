/**
 * Figma Plugin API documentation lookup.
 *
 * Reads from docs/figma-api/ (cloned via the `api setup` command).
 * Source: https://github.com/iamtekeste/figma (Figma Plugin API as markdown)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { coveredApiTypeNames } from './lib/api-capability-claims.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, '..', 'docs', 'figma-api');
const REPO = 'https://github.com/iamtekeste/figma.git';
const OFFICIAL_TYPINGS_PATH = path.resolve(
  __dirname, '..', '..', 'node_modules', '@figma', 'plugin-typings', 'plugin-api.d.ts',
);

function isInstalled() {
  return fs.existsSync(path.join(DOCS_DIR, 'interfaces'));
}

export async function setup({ update = false } = {}) {
  const installed = isInstalled();
  if (installed && !update) {
    console.log('✓ API docs already installed at docs/figma-api/');
    console.log('  Run with --update to pull the latest version.');
    return;
  }
  if (installed && update) {
    // git pull so the docs stay fresh without re-cloning ~5 MB
    try {
      console.log('→ pulling latest API docs (git pull) …');
      execSync(`git -C "${DOCS_DIR}" pull --ff-only --quiet`, { stdio: 'inherit' });
      console.log('✓ docs updated');
      // Rebuild the compact index since contents may have changed
      try { buildIndex({ silent: true }); } catch {}
      return;
    } catch (e) {
      console.error('✗ git pull failed:', e.message);
      console.error('  If the repo is dirty, delete docs/figma-api/ and re-run figma_run ["api","setup"].');
      process.exit(1);
    }
  }
  console.log('→ cloning Figma API docs (~5 MB) into docs/figma-api/');
  fs.mkdirSync(path.dirname(DOCS_DIR), { recursive: true });
  try {
    execSync(`git clone --depth 1 ${REPO} "${DOCS_DIR}"`, { stdio: 'inherit' });
    // Build the compact index on first install
    try { buildIndex({ silent: true }); } catch {}
    console.log('✓ done. Try: figma_run ["api","Frame"]  or  figma_run ["api","index"]');
  } catch (e) {
    console.error('✗ clone failed:', e.message);
    process.exit(1);
  }
}

/**
 * How old (in days) the local doc clone is. Returns Infinity if not installed.
 * Lets callers decide whether to trigger an auto-refresh.
 */
export function ageInDays() {
  if (!isInstalled()) return Infinity;
  try {
    // Use the .git/HEAD mtime as the freshness signal — updated on every pull
    const head = path.join(DOCS_DIR, '.git', 'HEAD');
    const stat = fs.statSync(head);
    return (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  } catch {
    return Infinity;
  }
}

function listAll() {
  if (!isInstalled()) return null;
  const interfaces = fs.readdirSync(path.join(DOCS_DIR, 'interfaces'))
    .filter(f => f.endsWith('.md'))
    .map(f => ({ kind: 'interface', name: f.replace(/\.md$/, ''), file: path.join(DOCS_DIR, 'interfaces', f) }));
  const aliases = fs.readdirSync(path.join(DOCS_DIR, 'type-aliases'))
    .filter(f => f.endsWith('.md'))
    .map(f => ({ kind: 'type', name: f.replace(/\.md$/, ''), file: path.join(DOCS_DIR, 'type-aliases', f) }));
  return [...interfaces, ...aliases];
}

export function list(filter) {
  const all = listAll();
  if (!all) {
    console.error('✗ docs not installed. Run: figma_run ["api","setup"]');
    process.exit(1);
  }
  const items = filter
    ? all.filter(i => i.name.toLowerCase().includes(filter.toLowerCase()))
    : all;
  if (items.length === 0) {
    console.log(`No matches for "${filter}".`);
    return;
  }
  for (const i of items) {
    console.log(`${i.kind.padEnd(10)} ${i.name}`);
  }
  console.log(`\n${items.length} result(s)`);
}

function score(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1000;
  if (n.startsWith(q)) return 100 + (q.length / n.length) * 50;
  if (n.includes(q)) return 50 + (q.length / n.length) * 25;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? i : 0;
}

/**
 * Compress a typedoc-style interface markdown to signatures + one line of
 * prose per member. The full dumps repeat "Defined in:", "Inherited from"
 * and cross-link boilerplate for EVERY inherited property — ComponentSetNode
 * weighs 135 KB raw, which no LLM context (and no human) wants. Compact
 * keeps: title, Extends, each member's signature blockquote and its first
 * description line.
 */
function compactMarkdown(md) {
  const stripLinks = (s) => s.replace(/\[`?([^\]`]+)`?\]\([^)]*\)/g, '$1');
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inMember = false;   // between a ### heading and the next ###/##
  let proseTaken = false; // one description line per member
  let inFence = false;    // inside a ``` code block
  for (; i < lines.length; i++) {
    const line = lines[i];
    // Drop fenced code blocks whole. The compact view keeps only signatures +
    // one prose line, so a lone ``` opener (with its body/closer skipped as
    // non-prose) would leave unbalanced fences that make renderers treat the
    // rest of the document as one code block.
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.startsWith('# ')) { out.push(stripLinks(line)); continue; }
    if (line.startsWith('## ')) {
      inMember = false;
      // Drop link-only sections; keep structural ones (Extends, Properties, Methods, ...)
      if (/^## (See|Source)\b/.test(line)) continue;
      out.push('', stripLinks(line));
      continue;
    }
    if (line.startsWith('### ')) {
      inMember = true;
      proseTaken = false;
      out.push('', stripLinks(line));
      continue;
    }
    if (!inMember) {
      // Header block between title and first ## — keep prose (interface summary)
      if (line.startsWith('Defined in:') || line.startsWith('---') || line.startsWith('#')) continue;
      if (line.trim()) out.push(stripLinks(line));
      continue;
    }
    // Inside a member section:
    if (line.startsWith('> ')) { out.push(stripLinks(line)); continue; } // signature
    if (line.startsWith('#### ') || line.startsWith('Defined in:') || line.startsWith('---')) continue;
    if (!proseTaken && line.trim() && !line.startsWith('#') && !line.startsWith('[')) {
      out.push(stripLinks(line.length > 240 ? line.slice(0, 240) + '…' : line));
      proseTaken = true;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function show(query, opts = {}) {
  const all = listAll();
  if (!all) {
    console.error('✗ docs not installed. Run: figma_run ["api","setup"]');
    process.exit(1);
  }
  if (!query) {
    console.error('Usage: figma_run ["api","<name>"]   (e.g. figma_run ["api","FrameNode"])');
    process.exit(1);
  }
  const ranked = all
    .map(i => ({ ...i, s: score(i.name, query) }))
    .filter(i => i.s > 0)
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 0) {
    console.log(`No interface or type matching "${query}".`);
    console.log(`Try: figma_run ["api","list","${query}"]`);
    return;
  }
  const top = ranked[0];
  if (ranked.length > 1 && top.s < 100) {
    console.log(`Top matches for "${query}":`);
    for (const r of ranked.slice(0, 8)) {
      console.log(`  ${r.kind.padEnd(10)} ${r.name}`);
    }
    console.log(`\nUse: figma_run ["api","<exact-name>"]`);
    return;
  }
  const md = fs.readFileSync(top.file, 'utf-8');
  if (opts.full) {
    console.log(md);
  } else {
    console.log(compactMarkdown(md));
    console.log(`\n(compact view — full docs: figma_run ["api","${top.name}","--full"])`);
  }
}

/**
 * Try to extract a Figma API name from a runtime error message,
 * then call suggest() if the docs are installed.
 * Returns true if a useful suggestion was emitted, false otherwise.
 *
 * Recognized patterns:
 *   "TypeError: <obj>.<name> is not a function"     -> name
 *   "Property \"<name>\" failed validation"          -> name
 *   "Error: in <name>: ..."                          -> name
 *   "Cannot read properties of undefined (reading '<name>')" -> name
 */
export function suggestFromError(message) {
  if (!message || typeof message !== 'string') return false;
  const candidates = [];
  let m;
  // Match the last identifier before "is not a function" (e.g. "figma.createImage" -> "createImage")
  if ((m = message.match(/([a-zA-Z][a-zA-Z0-9_]+)\s+is not a function/))) candidates.push(m[1]);
  if ((m = message.match(/Property\s+"([a-zA-Z][a-zA-Z0-9_.#]+)"\s+failed validation/))) {
    // "node.addComponentProperty.options" -> "addComponentProperty"
    const last = m[1].split('.').pop();
    candidates.push(last);
  }
  if ((m = message.match(/Error:\s+in\s+([a-zA-Z][a-zA-Z0-9_]+)/))) candidates.push(m[1]);
  if ((m = message.match(/Cannot read propert(?:y|ies)\s+(?:of undefined\s+\(reading\s+)?'?([a-zA-Z][a-zA-Z0-9_]+)'?/))) candidates.push(m[1]);
  // Strip "set_"/"get_" prefixes Figma adds to setters
  const cleaned = candidates.map(c => c.replace(/^(set_|get_)/, ''));
  // Filter out generic JS terms
  const skip = new Set(['undefined', 'null', 'object', 'function', 'string', 'number', 'array', 'true', 'false', 'foo', 'bar', 'baz', 'something', 'value', 'data', 'item']);
  // Need at least 5 chars to be likely a real API name (avoids "foo", "id", etc.)
  const useful = [...new Set(cleaned)].filter(c => c.length >= 5 && !skip.has(c.toLowerCase()));
  if (useful.length === 0) return false;

  if (!isInstalled()) return false;

  // Search both: interface names (fast, fuzzy) AND interface contents (for method/property names)
  const all = listAll() || [];
  const hits = new Map(); // name -> { name, kind, file, score, matchedTerm }

  for (const term of useful) {
    // 1. Name-based fuzzy match
    for (const i of all) {
      const s = score(i.name, term);
      if (s > 0) {
        const ex = hits.get(i.name);
        if (!ex || s > ex.score) hits.set(i.name, { ...i, score: s, matchedTerm: term, source: 'name' });
      }
    }
    // 2. Content search: which files contain this term?
    // Higher score if term appears as a heading (### term) — that's where it's DEFINED.
    const headingRe = new RegExp(`^#{2,4}\\s+${term}\\b`, 'm');
    const wordRe = new RegExp(`\\b${term}\\b`);
    for (const i of all) {
      if (hits.has(i.name) && hits.get(i.name).source === 'name') continue;
      try {
        const content = fs.readFileSync(i.file, 'utf-8');
        let s = 0;
        if (headingRe.test(content)) {
          // Defined here — high score
          s = 80;
        } else if (wordRe.test(content)) {
          // Just mentioned — low score
          s = i.kind === 'interface' ? 25 : 15;
        }
        if (s > 0) {
          const ex = hits.get(i.name);
          if (!ex || s > ex.score) hits.set(i.name, { ...i, score: s, matchedTerm: term, source: s >= 80 ? 'definition' : 'mention' });
        }
      } catch { /* skip unreadable */ }
    }
  }

  const top = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  if (top.length === 0) return false;

  console.error('\n  💡 Looks like this might map to a Figma Plugin API. Try:');
  for (const r of top) {
    let tag = '';
    if (r.source === 'definition') tag = ` (defines "${r.matchedTerm}")`;
    else if (r.source === 'mention') tag = ` (mentions "${r.matchedTerm}")`;
    console.error(`    figma_run ["api","${r.name}"]${tag}`);
  }
  return true;
}

/**
 * Suggest API interfaces/types when user types an unknown command.
 * Hint without crashing if docs not installed.
 */
export function suggest(query) {
  if (!query) return;
  const all = listAll();
  if (!all) {
    console.error('  → run figma_run ["--help"] to see available commands');
    console.error('  → or figma_run ["api","setup"] to enable offline Figma API lookup');
    return;
  }
  const ranked = all
    .map(i => ({ ...i, s: score(i.name, query) }))
    .filter(i => i.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (ranked.length === 0) {
    console.error('  → run figma_run ["--help"] to see available commands');
    return;
  }
  console.error('  Did you mean one of these Figma Plugin API references?');
  for (const r of ranked) {
    console.error(`    figma_run ["api","${r.name}"]`);
  }
  console.error('  Or run figma_run ["--help"] for the actual command list.');
}

/**
 * Search the Plugin API docs for methods/properties whose name matches `keyword`.
 * Returns an array of { method, signature, interface, kind } sorted by relevance.
 * "method" is the literal name as defined under a `### name()` heading,
 * "signature" is the next non-blank source line (typically `> **name**(args): ReturnType`).
 *
 * API-doc fallback: when no engine subcommand matches the
 * user's intent, search for matching methods so we can synthesize an `eval` call.
 */
export function searchMethods(keyword) {
  if (!keyword || typeof keyword !== 'string') return [];
  if (!isInstalled()) return [];
  const kw = keyword.toLowerCase();
  const all = listAll() || [];
  const results = [];
  // Method/property headings look like:
  //   ### rescale()
  //   ### width
  // Followed (after a blank line) by:
  //   > **rescale**(`scale`): `void`
  const headingRe = /^###\s+([a-zA-Z_][a-zA-Z0-9_]*)\(?\)?\s*$/gm;
  for (const item of all) {
    let content;
    try { content = fs.readFileSync(item.file, 'utf-8'); } catch { continue; }
    headingRe.lastIndex = 0;
    let m;
    while ((m = headingRe.exec(content)) !== null) {
      const name = m[1];
      const lower = name.toLowerCase();
      // Match if keyword is a substring OR keyword matches start of the camelCase name
      if (!lower.includes(kw)) continue;
      // Capture the signature: prefer a `> **name**...` blockquote line within
      // the next ~600 chars; fall back to "Defined in:" if no signature exists
      // (means it's a property, not a method)
      const rest = content.slice(m.index + m[0].length, m.index + m[0].length + 800);
      let signature = '';
      const sigMatch = rest.match(/^>\s+(\*\*[^\n]+)/m);
      if (sigMatch) signature = sigMatch[1].replace(/\*\*/g, '').trim();
      else {
        const propMatch = rest.match(/^(?:>\s+)?`([^`]+)`\s*$/m);
        if (propMatch) signature = propMatch[1].trim();
      }
      // Relevance: exact match > prefix > substring; prefer shorter names
      let s = 0;
      if (lower === kw) s = 1000;
      else if (lower.startsWith(kw)) s = 200 + (kw.length / lower.length) * 100;
      else s = 50 + (kw.length / lower.length) * 50;
      // Prefer the canonical / less-specific interfaces (LayoutMixin > FrameNode for shared methods)
      if (item.name.endsWith('Mixin')) s += 5;
      results.push({
        method: name,
        signature,
        interface: item.name,
        kind: item.kind,
        score: s,
      });
    }
  }
  // Deduplicate by method name keeping the highest-scoring source
  const dedup = new Map();
  for (const r of results) {
    const ex = dedup.get(r.method);
    if (!ex || r.score > ex.score) dedup.set(r.method, r);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score);
}

/**
 * The ways a documented API name can actually appear in plugin code.
 *
 * The docs are typedoc output, so they name TYPES — `FrameNode`,
 * `ComponentSetNode`. Plugin code never writes a type: it calls
 * `figma.createFrame()` and compares `node.type === 'FRAME'`. Matching the
 * bare interface name therefore misses almost everything, which is why this
 * report used to claim the engine touched 14 of 254 names.
 */
export function usageForms(name) {
  const forms = [name];
  const base = name.replace(/Node$/, '');
  if (base !== name) {
    // FrameNode → createFrame, 'FRAME'; ComponentSetNode → COMPONENT_SET
    forms.push('create' + base);
    forms.push(base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
  }
  return forms;
}

/** Concatenate every .js file under `dir` (recursive). Used as the corpus for
 *  the coverage scan below — read-only, engine sources only. */
function readSourceTree(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readSourceTree(full);
    else if (entry.name.endsWith('.js')) out += fs.readFileSync(full, 'utf-8');
  }
  return out;
}

/**
 * Extract the public named declarations from Figma's official typings.
 * The Markdown mirror remains useful for prose lookup, but coverage must be
 * measured against the package Figma updates with every Plugin API release.
 */
export function parseOfficialTypingNames(source) {
  const found = new Map();
  const declaration = /^(?:export\s+)?(?:declare\s+)?(interface|type|class|enum)\s+([A-Za-z_$][\w$]*)\b/gm;
  for (const match of String(source ?? '').matchAll(declaration)) {
    const [, declarationKind, name] = match;
    if (!found.has(name)) {
      found.set(name, {
        kind: declarationKind === 'interface' ? 'interface' : 'type',
        name,
        file: OFFICIAL_TYPINGS_PATH,
      });
    }
  }
  return [...found.values()];
}

function officialTypingItems() {
  try {
    const items = parseOfficialTypingNames(fs.readFileSync(OFFICIAL_TYPINGS_PATH, 'utf8'));
    return items.length ? items : null;
  } catch {
    return null;
  }
}

export function gap() {
  const official = officialTypingItems();
  const all = official || listAll();
  if (!all) {
    console.error('✗ neither @figma/plugin-typings nor offline docs are installed. Run npm install.');
    process.exit(1);
  }
  // Which Figma API names does this engine actually mention? The corpus has
  // to be the whole source tree: the calls live in the eval snippets each
  // command builds, not in any one client file. (This used to read index.js
  // plus a since-deleted client — a few hundred lines out of ~25,000, so all
  // but a handful of names looked "missing".)
  const usage = readSourceTree(path.resolve(__dirname));

  const interesting = all.filter(i => {
    const n = i.name;
    if (n.length < 4) return false;
    if (n.startsWith('Default')) return false;
    if (n.startsWith('Base')) return false;
    if (n.endsWith('Mixin')) return false;
    return true;
  });

  const referenced = [];
  const missing = [];
  const claimed = coveredApiTypeNames();
  for (const i of interesting) {
    if (claimed.has(i.name) || usageForms(i.name).some(form => new RegExp(`\\b${form}\\b`).test(usage))) {
      referenced.push(i);
    } else {
      missing.push(i);
    }
  }

  // Group missing by likely category
  const groups = {
    figjam: [],
    slides: [],
    annotations: [],
    devmode: [],
    plugin_runtime: [],
    nodes: [],
    styles_effects: [],
    other: [],
  };
  for (const i of missing) {
    const n = i.name.toLowerCase();
    if (/sticky|connector|shapewithtext|stamp|widget|figjam|table/i.test(i.name)) groups.figjam.push(i);
    else if (/slide/i.test(i.name)) groups.slides.push(i);
    else if (/annotation/i.test(i.name)) groups.annotations.push(i);
    else if (/dev.*resource|codegen|measurement|status/i.test(i.name)) groups.devmode.push(i);
    else if (/plugin|param|relaunch|message|argfreedata/i.test(i.name)) groups.plugin_runtime.push(i);
    else if (/node$|component|frame|section/i.test(i.name)) groups.nodes.push(i);
    else if (/effect|fill|stroke|gradient|paint|style/i.test(i.name)) groups.styles_effects.push(i);
    else groups.other.push(i);
  }

  console.log(`Figma Plugin API: ${all.length} total (${interesting.length} interesting)`);
  console.log(`source: ${official ? '@figma/plugin-typings (official, installed)' : 'offline Markdown fallback'}\n`);
  console.log(`✓ Referenced or explicitly command-covered: ${referenced.length}`);
  console.log(`✗ NOT referenced (potential gap): ${missing.length}\n`);

  console.log('=== Missing capabilities (grouped) ===\n');
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    console.log(`${cat.toUpperCase()} (${items.length}):`);
    for (const i of items.slice(0, 12)) {
      console.log(`  - ${i.name}`);
    }
    if (items.length > 12) console.log(`  …and ${items.length - 12} more`);
    console.log();
  }

  console.log('Tip: figma_run ["api","<Name>"]   to read the prose reference; api gap itself uses the official typings.');
}

/** Path to the compact index. Rebuilt by buildIndex(); lives alongside the docs. */
const INDEX_PATH = path.resolve(__dirname, '..', 'docs', 'figma-api-INDEX.md');

/**
 * Build a compact markdown index of every interface + type alias with a
 * one-line description extracted from the source markdown. ~5 KB instead of
 * 135 KB. Designed as a "first-fetch" knowledge handle for LLM agents:
 * the model sees what APIs exist without having to load every full file.
 *
 * Inspired by Claude's claude-code-guide pattern (Cristian Morales): keep
 * skills thin, knowledge external + indexed.
 */
export function buildIndex({ silent = false } = {}) {
  if (!isInstalled()) {
    if (!silent) console.error('✗ docs not installed. Run: figma_run ["api","setup"]');
    process.exit(1);
  }
  const all = listAll();
  const groups = { interface: [], type: [] };
  for (const item of all) {
    let blurb = '';
    try {
      const content = fs.readFileSync(item.file, 'utf-8');
      // First paragraph after the H1, skipping empty + frontmatter-style lines
      const lines = content.split('\n');
      let inBody = false;
      for (const line of lines) {
        const trim = line.trim();
        if (!inBody) {
          if (trim.startsWith('# ')) { inBody = true; continue; }
          continue;
        }
        if (!trim) continue;
        if (trim.startsWith('Defined in:')) continue;
        if (trim.startsWith('##') || trim.startsWith('###')) break;
        if (trim.startsWith('>')) continue;
        if (trim.startsWith('|')) continue;
        // first non-meta paragraph
        blurb = trim.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`/g, '');
        if (blurb.length > 140) blurb = blurb.slice(0, 137) + '…';
        break;
      }
    } catch { /* skip unreadable */ }
    groups[item.kind].push({ name: item.name, blurb });
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  const lines = [
    '# Figma Plugin API — Index',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from docs/figma-api/.`,
    `Total: ${groups.interface.length} interfaces, ${groups.type.length} type aliases.`,
    '',
    '## Interfaces',
    '',
  ];
  for (const i of groups.interface) {
    lines.push(`- **${i.name}**${i.blurb ? ' — ' + i.blurb : ''}`);
  }
  lines.push('', '## Type aliases', '');
  for (const i of groups.type) {
    lines.push(`- **${i.name}**${i.blurb ? ' — ' + i.blurb : ''}`);
  }
  const out = lines.join('\n') + '\n';
  fs.writeFileSync(INDEX_PATH, out);
  if (!silent) {
    const sizeKB = (out.length / 1024).toFixed(1);
    console.log(`✓ index written: ${INDEX_PATH} (${groups.interface.length}i + ${groups.type.length}t, ${sizeKB} KB)`);
  }
  return INDEX_PATH;
}

/**
 * Read (or build-and-read) the compact index. Used at startup
 * and on /learn.
 */
export function readIndex() {
  if (!fs.existsSync(INDEX_PATH)) buildIndex({ silent: true });
  return fs.readFileSync(INDEX_PATH, 'utf-8');
}

/**
 * Produce an LLM-ready context block. With no topic: the compact index.
 * With a topic: the index + a small set of relevant full interface bodies
 * (top 4 matches from searchMethods + name-search).
 *
 * Goal: a single string a caller can append to the system prompt or the
 * next user message, sized appropriate for a 32k-context local model.
 */
export function getContext(topic) {
  if (!isInstalled()) {
    return '(Figma API docs not installed — run figma_run ["api","setup"] first.)';
  }
  const idx = readIndex();
  if (!topic || !topic.trim()) return idx;

  // Find candidate interfaces by name (cheap) + by method search (deeper)
  const all = listAll() || [];
  const q = topic.toLowerCase();
  const nameHits = all
    .filter(i => i.name.toLowerCase().includes(q))
    .slice(0, 4);
  // Also pull anything that has the topic as a defined method
  let methodHits = [];
  try {
    methodHits = (searchMethods(topic) || []).slice(0, 4);
  } catch {}
  const interfaceNames = new Set([
    ...nameHits.map(h => h.name),
    ...methodHits.map(h => h.interface),
  ]);
  const bodies = [];
  for (const name of interfaceNames) {
    const item = all.find(i => i.name === name);
    if (!item) continue;
    try {
      bodies.push(`\n\n---\n\n## ${name}\n\n` + fs.readFileSync(item.file, 'utf-8').trim());
    } catch {}
  }
  const out = [
    idx,
    `\n\n# Relevant for "${topic}"\n`,
    bodies.length > 0 ? bodies.join('\n') : '(no specific interface matches — use the index above)',
  ].join('');
  return out;
}
