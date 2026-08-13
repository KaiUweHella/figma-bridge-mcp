// Reuse/repeat lint for `render` — pure functions, no I/O.
//
// Reuse: a render that draws a frame NAMED like an existing component set is
// almost always an agent rebuilding what it should instantiate. Matching is
// deliberately strict (normalized equality, never prefix/substring — the
// set-lint lesson) so the warning keeps its authority.
//
// Repeat: N structurally identical siblings in one render are a component
// begging to exist. Detected purely from the parsed JSX — content (text,
// image, icon names) is excluded from the signature, style/layout is not.
import { normalizeName } from './story-match.js';

// Figma's own default node names — a frame named "Frame" is not a reuse claim.
const AUTO_NAMES = new Set([
  'frame', 'nested frame', 'group', 'component', 'instance', 'section',
  'rectangle', 'rect', 'ellipse', 'text', 'vector',
]);

/**
 * Candidate names from raw JSX strings: every named <Frame> open tag
 * (Instances are excluded by construction — instantiating IS reuse).
 * Auto-names and very short names are filtered as false-positive brakes.
 */
export function namedContainers(jsxStrings) {
  const names = [];
  const seen = new Set();
  for (const jsx of jsxStrings) {
    const re = /<Frame\b[^>]*?\bname="([^"]+)"/g;
    let m;
    while ((m = re.exec(String(jsx))) !== null) {
      const name = m[1].trim();
      if (name.length < 3) continue;
      if (AUTO_NAMES.has(name.toLowerCase())) continue;
      const key = normalizeName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * Match candidate names against the file inventory
 * ({ componentSets, standaloneComponents } from component-inventory.js).
 * A candidate hits when its normalized full name OR its normalized first
 * slash-segment equals a set/component name — exact segment equality, never
 * a prefix test ("Buttons Overview" must not hit "Button").
 */
export function matchInventory(names, inventory) {
  const sets = (inventory && inventory.componentSets) || [];
  const singles = (inventory && inventory.standaloneComponents) || [];
  const findings = [];
  for (const name of names) {
    const full = normalizeName(name);
    const firstSeg = normalizeName(String(name).split('/')[0]);
    const set = sets.find(s => {
      const n = normalizeName(s.name);
      return n === full || n === firstSeg;
    });
    if (set) {
      findings.push({ name, kind: 'set', match: set });
      continue;
    }
    const comp = singles.find(c => {
      const n = normalizeName(c.name);
      return n === full || n === firstSeg;
    });
    if (comp) findings.push({ name, kind: 'component', match: comp });
  }
  return findings;
}

/**
 * The rebuild recipe: which set/component exists, its axes, and a ready
 * <Instance> line. When the candidate carries a slash tail that equals an
 * axis value ("Button/Primary" and an axis has value "Primary"), the snippet
 * pre-fills that variant.
 */
export function formatReuseWarning(finding) {
  const m = finding.match;
  const lines = [];
  if (finding.kind === 'set') {
    lines.push(`"${finding.name}" has a name-match candidate in component set "${m.name}" (${m.id}).`);
    const axes = m.variantAxes || {};
    const axisLines = Object.entries(axes)
      .map(([axis, def]) => `${axis}: ${(def.values || []).join(' | ')}`);
    if (axisLines.length) lines.push(`  axes: ${axisLines.join('; ')}`);
    let variantAttr = '';
    const tail = String(finding.name).split('/').slice(1).join('/').trim();
    if (tail) {
      for (const [axis, def] of Object.entries(axes)) {
        const hit = (def.values || []).find(v => normalizeName(v) === normalizeName(tail));
        if (hit) { variantAttr = ` variant="${axis}=${hit}"`; break; }
      }
    }
    lines.push('  decision required: is this the same Design Entity and visually/structurally compatible?');
    lines.push(`  if yes, link ${m.id} to a repository entity and instrument data-figma-component="<entity-id>"${variantAttr ? ` with${variantAttr}` : ''}.`);
    lines.push(`  name equality alone never authorizes <Instance component="${m.name}" />.`);
  } else {
    lines.push(`"${finding.name}" has a name-match candidate in component "${m.name}" (${m.id}).`);
    lines.push('  decision required: if it is the same Design Entity, link it and instrument data-figma-component="<entity-id>".');
    lines.push(`  name equality alone never authorizes <Instance component="${m.name}" />.`);
  }
  return lines.join('\n');
}

// ---------- repeat lint ----------

/**
 * Structure signature of a parsed JSX item (parseChildren output): the tag
 * tree plus layout/style props. Content — text characters, image sources,
 * icon names, per-item name suffixes — is excluded: three cards with
 * different plant names are still the same card.
 */
export function repeatSignature(item) {
  if (!item || typeof item !== 'object') return '';
  const CONTENT_PROPS = new Set([
    'text', 'content', 'src', 'name', 'id', 'component', 'key', 'variant',
  ]);
  const props = Object.keys(item)
    .filter(k => !k.startsWith('_') && !CONTENT_PROPS.has(k)
      && !k.startsWith('text:') && !k.startsWith('prop:')
      && !k.startsWith('fill:') && !k.startsWith('swap:'))
    .sort()
    .map(k => `${k}=${JSON.stringify(item[k])}`);
  const kids = Array.isArray(item._children) ? item._children.map(repeatSignature) : [];
  return `${item._type || '?'}(${props.join(',')})[${kids.join('|')}]`;
}

/**
 * Groups of >= minCount structurally identical siblings. Only container
 * children (frames) count — five identical icons in a row are a list, not
 * a missing component.
 */
export function findRepeatedSiblings(items, minCount = 3) {
  const groups = new Map();
  for (const item of items || []) {
    if (!item || item._type !== 'frame') continue;
    const sig = repeatSignature(item);
    if (!sig || sig.length < 30) continue; // trivially small structures don't warrant a component
    const g = groups.get(sig) || { signature: sig, count: 0, sampleName: null };
    g.count++;
    if (!g.sampleName && item.name) g.sampleName = item.name;
    groups.set(sig, g);
  }
  return [...groups.values()].filter(g => g.count >= minCount);
}
