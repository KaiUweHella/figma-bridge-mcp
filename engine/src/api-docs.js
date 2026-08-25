/**
 * Figma Plugin API documentation lookup.
 *
 * Reads an official @figma/plugin-typings projection from the private Bridge
 * state directory. `api setup` is local, atomic and performs no network I/O.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { coveredApiTypeNames } from './lib/api-capability-claims.js';
import {
  API_REFERENCE_LIMITS,
  FIGMA_TYPINGS_MATERIAL_VERSION,
  OFFICIAL_TYPINGS_PATH,
} from './lib/api-reference-policy.js';
import { apiReferenceStore } from './lib/api-reference-store.js';
import {
  PLUGIN_API_CREATION_OPERATIONS,
  PLUGIN_API_STRUCTURAL_OPERATIONS,
  operationCoverageSummary,
} from './lib/api-operation-coverage.js';
import {
  auditRoundTripFidelityContract,
} from './lib/round-trip-fidelity-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DOCS_DIR = path.resolve(__dirname, '..', 'docs', 'figma-api');
const UNSAFE_QUERY = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

function isInstalled() {
  try { apiReferenceStore.load(); return true; } catch { return false; }
}

function legacyDocsPresent() {
  return fs.existsSync(path.join(LEGACY_DOCS_DIR, 'interfaces'));
}

function notInstalledMessage() {
  return legacyDocsPresent()
    ? 'legacy package-tree docs are no longer used; run figma_run ["api","setup"] to build the official private reference'
    : 'reference not installed; run figma_run ["api","setup"]';
}

function boundedQuery(value, label = 'query') {
  const text = String(value ?? '');
  if (text.length > API_REFERENCE_LIMITS.queryCodeUnits || UNSAFE_QUERY.test(text)) {
    throw new Error(`${label} must be at most ${API_REFERENCE_LIMITS.queryCodeUnits} characters without control or Bidi text`);
  }
  return text;
}

export async function setup({ update = false } = {}) {
  try {
    const installed = apiReferenceStore.install();
    const verb = installed.reused && !update ? 'already installed' : 'activated';
    console.log(`✓ Official Figma API reference ${verb}`);
    console.log(`  material: ${installed.materialVersion}`);
    console.log(`  ${installed.entries} declarations · ${installed.bytes} private bytes · network: none`);
    if (installed.reused && update) {
      console.log('  The installed package already contains the reviewed source; update the Bridge package for newer official typings.');
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    console.error('  The previous private reference, if any, remains unchanged. Reinstall this Bridge package if the official dependency is missing.');
    process.exitCode = 1;
  }
}

/** How old (in days) the activated private material is. */
export function ageInDays() {
  return apiReferenceStore.ageInDays();
}

function listAll() {
  try { return apiReferenceStore.load().entries; } catch { return null; }
}

export function list(filter) {
  const all = listAll();
  if (!all) {
    console.error(`✗ ${notInstalledMessage()}`);
    process.exitCode = 1;
    return;
  }
  const query = boundedQuery(filter || '', 'filter');
  const items = query
    ? all.filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
    : all;
  if (items.length === 0) {
    console.log(`No matches for "${query}".`);
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

function compactOfficialDeclaration(entry) {
  const declarationLine = entry.source
    .split('\n')
    .find((line) => /^(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum)\s+/.test(line.trim()))
    ?.trim();
  const lines = [
    `# ${entry.name}`,
    '',
    `Official source: ${FIGMA_TYPINGS_MATERIAL_VERSION}`,
  ];
  if (entry.summary) lines.push('', entry.summary);
  if (declarationLine) lines.push('', '## Declaration', '', `\`${declarationLine}\``);
  if (entry.members.length) {
    lines.push('', `## Members (${entry.members.length})`, '');
    for (const member of entry.members) lines.push(`- \`${member.signature}\``);
  }
  return lines.join('\n');
}

export function show(query, opts = {}) {
  const all = listAll();
  if (!all) {
    console.error(`✗ ${notInstalledMessage()}`);
    process.exitCode = 1;
    return;
  }
  if (!query) {
    console.error('Usage: figma_run ["api","<name>"]   (e.g. figma_run ["api","FrameNode"])');
    process.exitCode = 1;
    return;
  }
  query = boundedQuery(query);
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
  if (opts.full) {
    console.log(top.source);
  } else {
    console.log(compactOfficialDeclaration(top));
    console.log(`\n(compact official view — full declaration and prose: figma_run ["api","${top.name}","--full"])`);
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
  const hits = new Map(); // name -> { name, kind, score, matchedTerm }

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
    const wordRe = new RegExp(`\\b${term}\\b`);
    for (const i of all) {
      if (hits.has(i.name) && hits.get(i.name).source === 'name') continue;
      const content = i.source;
      let s = 0;
      if (i.members.some((member) => member.name === term)) {
        s = 80;
      } else if (wordRe.test(content)) {
        s = i.kind === 'interface' ? 25 : 15;
      }
      if (s > 0) {
        const ex = hits.get(i.name);
        if (!ex || s > ex.score) hits.set(i.name, {
          ...i, score: s, matchedTerm: term, source: s >= 80 ? 'definition' : 'mention',
        });
      }
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
  try { query = boundedQuery(query); } catch { return; }
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
  keyword = boundedQuery(keyword, 'keyword');
  const kw = keyword.toLowerCase();
  const all = listAll() || [];
  const results = [];
  for (const item of all) {
    for (const member of item.members) {
      const name = member.name;
      const lower = name.toLowerCase();
      if (!lower.includes(kw)) continue;
      let s = 0;
      if (lower === kw) s = 1000;
      else if (lower.startsWith(kw)) s = 200 + (kw.length / lower.length) * 100;
      else s = 50 + (kw.length / lower.length) * 50;
      if (item.name.endsWith('Mixin')) s += 5;
      results.push({
        method: name,
        signature: member.signature,
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
 * Lookup and coverage use the package Figma updates with every Plugin API
 * release; coverage does not depend on private reference setup.
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
  const operationSummary = operationCoverageSummary();
  console.log(`Core create/structure operations audited for typings ${operationSummary.auditedVersion}: ${operationSummary.total}`);
  console.log(`  ${operationSummary.supported} direct · ${operationSummary.alternative} safe alternatives · ${operationSummary.boundary} explicit boundaries`);
  const boundaries = [...Object.entries(PLUGIN_API_CREATION_OPERATIONS), ...Object.entries(PLUGIN_API_STRUCTURAL_OPERATIONS)]
    .filter(([, entry]) => entry.status === 'boundary');
  if (boundaries.length) {
    console.log('  boundaries:');
    for (const [name, entry] of boundaries) console.log(`    - ${name}: ${entry.note}`);
  }
  const fidelityAudit = auditRoundTripFidelityContract();
  const fidelity = fidelityAudit.summary;
  console.log(`Round-trip Fidelity Contract v${fidelity.version}: ${fidelity.classifiedBothWays}/${fidelity.total} fact families classified both ways`);
  console.log(`  ${fidelity.exactBothWays} exact pairs · ${fidelity.explicitSeams} explicit seams`);
  if (!fidelityAudit.ok) {
    console.log('  CONTRACT INVALID:');
    for (const error of fidelityAudit.errors) console.log(`    - ${error}`);
    process.exitCode = 1;
  }
  console.log();
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

function indexFromModel(model) {
  const groups = { interface: [], type: [] };
  for (const item of model.entries) {
    const blurb = item.summary.length > 140 ? `${item.summary.slice(0, 137)}…` : item.summary;
    groups[item.kind].push({ name: item.name, blurb });
  }
  for (const kind of Object.keys(groups)) groups[kind].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '# Figma Plugin API — Official Index',
    '',
    `Material: ${model.materialVersion}`,
    `Total: ${groups.interface.length} interfaces, ${groups.type.length} type/class/enum aliases.`,
    '',
    '## Interfaces',
    '',
  ];
  for (const item of groups.interface) lines.push(`- **${item.name}**${item.blurb ? ` — ${item.blurb}` : ''}`);
  lines.push('', '## Types, classes and enums', '');
  for (const item of groups.type) lines.push(`- **${item.name}**${item.blurb ? ` — ${item.blurb}` : ''}`);
  return `${lines.join('\n')}\n`;
}

/** Revalidate and atomically activate the pinned source, then project its index. */
export function buildIndex({ silent = false } = {}) {
  try {
    const installed = apiReferenceStore.install();
    const out = indexFromModel(apiReferenceStore.load());
    if (!silent) {
      console.log(`✓ official index ready: ${installed.materialVersion}`);
      console.log(`  ${installed.entries} declarations · ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KB`);
    }
    return out;
  } catch (error) {
    if (!silent) console.error(`✗ ${error.message}`);
    process.exitCode = 1;
    return '';
  }
}

export function readIndex() {
  return indexFromModel(apiReferenceStore.load());
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
  if (!isInstalled()) return `(Figma API ${notInstalledMessage()}.)`;
  const idx = readIndex();
  if (!topic || !topic.trim()) return idx;
  topic = boundedQuery(topic, 'topic');

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
  const heading = `\n\n# Relevant for "${topic}"\n`;
  const bodies = [];
  let usedBytes = Buffer.byteLength(idx, 'utf8') + Buffer.byteLength(heading, 'utf8');
  for (const name of interfaceNames) {
    const item = all.find(i => i.name === name);
    if (!item) continue;
    const body = `\n\n---\n\n## ${name}\n\n${item.source.trim()}`;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (usedBytes + bytes > API_REFERENCE_LIMITS.contextBytes) {
      const omission = `\n\n---\n\n## ${name}\n\n(declaration omitted from this bounded context; use figma_run ["api","show","${name}","--full"])`;
      const omissionBytes = Buffer.byteLength(omission, 'utf8');
      if (usedBytes + omissionBytes <= API_REFERENCE_LIMITS.contextBytes) {
        bodies.push(omission);
        usedBytes += omissionBytes;
      }
      continue;
    }
    bodies.push(body);
    usedBytes += bytes;
  }
  const empty = '(no specific interface matches — use the index above)';
  const content = bodies.length > 0 ? bodies.join('') : empty;
  const out = `${idx}${heading}${content}`;
  if (Buffer.byteLength(out, 'utf8') > API_REFERENCE_LIMITS.contextBytes) {
    throw new Error('official API reference index exceeds the bounded context policy');
  }
  return out;
}
