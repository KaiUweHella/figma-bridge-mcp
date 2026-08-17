// Three-way token sync between a code file and Figma variables.
//
// `tokens import` is one-directional and skips anything that already exists, so
// a value edited in code never reaches Figma and a value edited in Figma never
// reaches code. Sync closes that loop — but a two-way sync without memory
// cannot tell "the code changed" from "Figma changed": it only sees that the
// two sides differ, and whichever direction it picks silently destroys the
// other side's work.
//
// So a lockfile records the state at the last successful sync, and every
// decision is a THREE-way comparison (code / figma / lock):
//
//   code ≠ lock, figma = lock   → the code changed      → update Figma
//   code = lock, figma ≠ lock   → Figma changed         → report, never clobber
//   both ≠ lock, and ≠ each other → conflict            → refuse, list it
//   neither ≠ lock              → unchanged
//
// The lockfile also stores each variable's Figma id, which is what makes a
// RENAME visible: same id, new name is one rename, not a delete plus a create
// that would drop every binding pointing at it.
//
// Everything here is pure — no Figma, no filesystem — so the decision table is
// testable in isolation. The command layer supplies the three inputs.

export const LOCKFILE_VERSION = 1;
export const LOCKFILE_NAME = 'figma-tokens.lock.json';
export const DTCG_BRIDGE_EXTENSION = 'figma-bridge-mcp';

/** Figma's variable types we round-trip. */
const TYPES = new Set(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']);

/**
 * Canonical comparison form. Colors become lowercase #rrggbb(aa), numbers are
 * rounded to 4 decimals (Figma stores floats; 0.30000000000000004 is not a
 * change anyone made), everything else is compared as-is.
 */
export function canonicalValue(type, value) {
  if (type === 'COLOR') return canonicalColor(value);
  if (type === 'FLOAT') {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
  }
  if (type === 'BOOLEAN') return value === true || value === 'true';
  return value === null || value === undefined ? null : String(value);
}

/** Accepts #rgb, #rrggbb, #rrggbbaa and Figma's {r,g,b,a} floats. */
export function canonicalColor(value) {
  // DTCG 2025.10 colors are structured values. Figma currently stores sRGB,
  // so prefer the normative components for sRGB and use the optional hex
  // fallback for other color spaces rather than silently inventing a gamut
  // conversion.
  if (value && typeof value === 'object' && Array.isArray(value.components)) {
    if (String(value.colorSpace || '').toLowerCase() !== 'srgb') {
      return typeof value.hex === 'string' ? canonicalColor(value.hex) : null;
    }
    const [r, g, b] = value.components;
    if (![r, g, b].every((component) => Number.isFinite(Number(component)))) {
      return typeof value.hex === 'string' ? canonicalColor(value.hex) : null;
    }
    return canonicalColor({ r: Number(r), g: Number(g), b: Number(b), a: value.alpha ?? 1 });
  }
  if (value && typeof value === 'object' && 'r' in value) {
    const to255 = (c) => Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255);
    const hex = [to255(value.r), to255(value.g), to255(value.b)]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
    const a = value.a === undefined || value.a === null ? 1 : Number(value.a);
    return a >= 0.999 ? `#${hex}` : `#${hex}${to255(a).toString(16).padStart(2, '0')}`;
  }
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (!s.startsWith('#')) return s; // rgb()/hsl()/named: compared verbatim
  s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length === 4) s = s.split('').map((c) => c + c).join('');
  if (s.length === 8 && s.slice(6) === 'ff') s = s.slice(0, 6);
  return `#${s}`;
}

/** Hex → Figma's {r,g,b,a}. Returns null when the string is not a hex colour. */
export function hexToFigmaRgb(hex) {
  const s = String(canonicalColor(hex) || '').slice(1);
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return null;
  const part = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
  return {
    r: part(0), g: part(2), b: part(4),
    a: s.length === 8 ? part(6) : 1,
  };
}

function sameValue(type, a, b) {
  const ca = canonicalValue(type, a);
  const cb = canonicalValue(type, b);
  if (ca === null || cb === null) return ca === cb;
  return ca === cb;
}

// ---------------------------------------------------------------- parsing

const isColorString = (v) => typeof v === 'string' && /^(#|rgb\(|rgba\(|hsl)/i.test(v.trim());

function inferType(value, declared) {
  const t = String(declared || '').toUpperCase();
  if (t === 'COLOR') return 'COLOR';
  if (t === 'NUMBER' || t === 'FLOAT' || t === 'DIMENSION') return 'FLOAT';
  if (t === 'BOOLEAN') return 'BOOLEAN';
  if (t === 'STRING' || t === 'FONTFAMILY') return 'STRING';
  if (isColorString(value)) return 'COLOR';
  if (typeof value === 'number') return 'FLOAT';
  if (typeof value === 'boolean') return 'BOOLEAN';
  // "16px" / "1rem" are dimensions, and Figma stores them as plain numbers.
  if (typeof value === 'string' && /^-?[\d.]+(px|rem|em)?$/.test(value.trim())) return 'FLOAT';
  return 'STRING';
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && Number.isFinite(Number(value.value))) {
    const n = Number(value.value);
    const unit = String(value.unit || '').toLowerCase();
    if (unit === 'rem' || unit === 'em') return n * 16;
    if (unit === '' || unit === 'px') return n;
    return null;
  }
  const m = String(value).trim().match(/^(-?[\d.]+)(px|rem|em)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

/**
 * Parse a DTCG (W3C design tokens) document into the flat sync shape.
 *
 * Unlike code-import/w3c-tokens.js — which buckets into color/spacing/radius
 * for the one-shot importer and drops anything that does not fit — this keeps
 * every token and its full path, because a sync that silently ignores tokens
 * would delete them from Figma on the next --prune.
 *
 * @returns {Map<string, {type: string, value: *}>} keyed by Figma-style path
 */
export function parseDtcgFlat(jsonText) {
  let doc;
  try { doc = JSON.parse(jsonText); } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  const raw = new Map();
  const walk = (node, path, inheritedType) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const groupType = node.$type ?? inheritedType;
    if ('$value' in node || 'value' in node) {
      raw.set(path.join('.'), {
        value: node.$value ?? node.value,
        type: node.$type ?? node.type ?? groupType,
        extension: node.$extensions?.[DTCG_BRIDGE_EXTENSION],
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...path, k], groupType);
    }
  };
  walk(doc, [], undefined);

  // Resolve {alias.references} — a sync compares values, so an alias must be
  // followed rather than stored as the literal string "{brand.primary}".
  const resolve = (value, seen) => {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{([^}]+)\}$/);
    if (!m) return value;
    const ref = m[1];
    if (seen.has(ref)) throw new Error(`Circular alias reference: {${ref}}`);
    const target = raw.get(ref);
    if (!target) throw new Error(`Unresolved alias {${ref}}`);
    seen.add(ref);
    return resolve(target.value, seen);
  };

  const out = new Map();
  for (const [path, tok] of raw) {
    const value = resolve(tok.value, new Set([path]));
    // Composite tokens (typography, shadow) have no single Figma variable to
    // map onto; skipping them silently would risk pruning, so they are
    // reported by the caller instead.
    const declared = String(tok.type || '').toLowerCase();
    const isStructuredColor = declared === 'color' && value && typeof value === 'object' && Array.isArray(value.components);
    const isStructuredNumber = declared === 'dimension'
      && value && typeof value === 'object' && 'value' in value;
    if (value && typeof value === 'object' && !isStructuredColor && !isStructuredNumber) continue;
    const type = inferType(value, tok.type);
    const name = path.split('.').join('/');
    const extension = tok.extension && typeof tok.extension === 'object' ? tok.extension : {};
    const scopes = Array.isArray(extension.scopes)
      ? [...new Set(extension.scopes.map(String))].sort()
      : undefined;
    const codeSyntax = extension.codeSyntax && typeof extension.codeSyntax === 'object'
      ? Object.fromEntries(Object.entries(extension.codeSyntax)
        .filter(([, syntax]) => typeof syntax === 'string')
        .sort(([a], [b]) => a.localeCompare(b)))
      : undefined;
    out.set(name, {
      type,
      value: type === 'FLOAT' ? toNumber(value) : isStructuredColor ? canonicalColor(value) : value,
      ...(typeof extension.variableId === 'string' ? { variableId: extension.variableId } : {}),
      ...(scopes ? { scopes } : {}),
      ...(codeSyntax ? { codeSyntax } : {}),
      ...(typeof extension.collection === 'string' ? { collection: extension.collection } : {}),
    });
  }
  return out;
}

/**
 * Parse CSS custom properties (`--brand-primary: #0D7C74;`) into the same
 * shape. `--` prefix dropped; `-` becomes `/` so the names match Figma's
 * grouping, mirroring what `export css` emits.
 */
export function parseCssFlat(cssText) {
  const out = new Map();
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const value = m[2].trim();
    // var() indirection cannot be resolved reliably without full cascade
    // evaluation; carrying it through would write literal "var(--x)" into a
    // Figma variable.
    if (/^var\(/.test(value)) continue;
    const type = inferType(value);
    out.set(m[1].replace(/-/g, '/'), {
      type,
      value: type === 'FLOAT' ? toNumber(value) : value,
    });
  }
  return out;
}

/** Pick a parser from the file name and content. */
export function parseTokenFile(fileName, content) {
  if (/\.css$/i.test(fileName)) return parseCssFlat(content);
  if (/\.json$/i.test(fileName)) return parseDtcgFlat(content);
  // Content sniff for unusual extensions.
  if (content.trim().startsWith('{')) return parseDtcgFlat(content);
  if (content.includes('--')) return parseCssFlat(content);
  throw new Error(
    `Cannot read tokens from "${fileName}". Supported for safe three-way sync: DTCG/W3C JSON (.json) and CSS custom properties (.css). `
    + 'Tailwind configs are an import source, not a sync source — their parser buckets values and cannot round-trip.',
  );
}

// ---------------------------------------------------------------- lockfile

export function emptyLock(collection) {
  return {
    version: LOCKFILE_VERSION,
    collection: collection || null,
    fileKey: null,
    syncedAt: null,
    tokens: {},
  };
}

/** Tolerate a missing or unreadable lock: a first sync simply has no memory. */
export function parseLock(text) {
  if (!text) return null;
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || !doc.tokens || typeof doc.tokens !== 'object') return null;
  if (doc.version !== LOCKFILE_VERSION) return null;
  return doc;
}

/** Lock entries for exactly what was applied — never for a dry run. */
export function buildLock({ collection, fileKey, tokens, syncedAt }) {
  const out = emptyLock(collection);
  out.fileKey = fileKey || null;
  out.syncedAt = syncedAt || new Date().toISOString();
  for (const [name, t] of tokens) {
    out.tokens[name] = {
      type: t.type,
      value: canonicalValue(t.type, t.value),
      ...(t.id ? { id: t.id } : {}),
      ...(Object.hasOwn(t, 'scopes') ? { scopes: normalizeScopes(t.scopes) } : {}),
      ...(Object.hasOwn(t, 'codeSyntax') ? { codeSyntax: normalizeCodeSyntax(t.codeSyntax) } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------- planning

/**
 * Decide what to do, comparing all three sides.
 *
 * @param {Map<string,{type,value}>} code   - parsed token file
 * @param {Map<string,{type,value,id}>} figma - current Figma variables
 * @param {object|null} lock                - previous sync state, or null
 * @param {{prune?: boolean}} [opts]
 * @returns {{create,update,rename,pull,delete:Array,conflict:Array,unchanged:number,orphan:Array}}
 */
export function planSync(code, figma, lock, { prune = false } = {}) {
  const locked = new Map(Object.entries((lock && lock.tokens) || {}));

  const create = [];
  const update = [];
  const rename = [];
  const pull = [];      // Figma moved ahead — reported so the user updates code
  const remove = [];
  const conflict = [];
  const orphan = [];    // in Figma, never tracked, not in code
  let unchanged = 0;

  // Renames are a request from the CODE side: a name the lock tracked has
  // disappeared from the file, and a new name has appeared. Figma still holds
  // the variable under its old name — that is exactly what we are about to
  // change. Pairing them here, before the create/delete passes, is what keeps
  // a rename from becoming a delete plus a create, which in Figma drops every
  // layer binding pointing at that variable.
  //
  // Pairing is by (type, canonical value) and only when it is UNAMBIGUOUS:
  // with two same-valued tokens renamed at once there is no way to tell which
  // became which, and guessing would move bindings to the wrong token. Those
  // fall through to create + delete, which is merely lossy rather than wrong.
  const renamedFrom = new Map(); // new name → old name
  {
    const goneFromCode = [];
    for (const [lockName, l] of locked) {
      if (code.has(lockName)) continue;
      const f = figma.get(lockName);
      // Only a variable Figma still holds unchanged can be renamed; anything
      // else is a conflict the passes below will report.
      if (!f || !sameValue(f.type, f.value, l.value) || f.type !== l.type) continue;
      goneFromCode.push({ name: lockName, figma: f });
    }
    const newInCode = [];
    for (const [name, c] of code) {
      if (figma.has(name) || locked.has(name)) continue;
      newInCode.push({ name, code: c });
    }

    // A DTCG export can carry Figma's stable variable id. That removes the
    // ambiguity of same-valued tokens and also lets a rename and value edit be
    // applied together without replacing the variable (and losing bindings).
    const oldById = new Map(goneFromCode
      .filter((item) => item.figma.id)
      .map((item) => [item.figma.id, item]));
    const claimedOld = new Set();
    const claimedNew = new Set();
    for (const item of newInCode) {
      if (!item.code.variableId) continue;
      const old = oldById.get(item.code.variableId);
      const lockedOld = old && locked.get(old.name);
      if (!old || !lockedOld || lockedOld.id !== item.code.variableId) continue;
      renamedFrom.set(item.name, old.name);
      claimedOld.add(old.name);
      claimedNew.add(item.name);
      rename.push({ name: item.name, from: old.name, id: old.figma.id, type: old.figma.type });
    }

    const signature = (type, value) => `${type} ${canonicalValue(type, value)}`;
    const bucket = (list, sig) => {
      const m = new Map();
      for (const item of list) {
        const key = sig(item);
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(item);
      }
      return m;
    };
    const oldBySig = bucket(goneFromCode.filter((i) => !claimedOld.has(i.name)), (i) => signature(i.figma.type, i.figma.value));
    const newBySig = bucket(newInCode.filter((i) => !claimedNew.has(i.name)), (i) => signature(i.code.type, i.code.value));

    for (const [sig, olds] of oldBySig) {
      const news = newBySig.get(sig);
      if (!news || olds.length !== 1 || news.length !== 1) continue;
      renamedFrom.set(news[0].name, olds[0].name);
      rename.push({
        name: news[0].name,
        from: olds[0].name,
        id: olds[0].figma.id,
        type: olds[0].figma.type,
      });
    }
  }

  const renamedTo = new Map(); // old name → new name
  for (const [to, from] of renamedFrom) renamedTo.set(from, to);

  for (const [name, c] of code) {
    // A rename has not happened in Figma yet — the variable is still there
    // under its old name, and both its current value and its lock history
    // belong to this token.
    const oldName = renamedFrom.get(name);
    const f = figma.get(name) ?? (oldName ? figma.get(oldName) : undefined);
    const l = locked.get(oldName || name);

    if (!f) {
      if (l) {
        // Tracked before, gone from Figma now: someone deleted it there.
        conflict.push({
          name, reason: 'deleted-in-figma',
          code: c.value, figma: null, lock: l.value, type: c.type,
          ...syncMetadataFields(c),
        });
      } else {
        create.push({ name, ...syncWriteFields(c) });
      }
      continue;
    }

    const typeChanged = f.type !== c.type;
    // "Moved on" is always measured against the LOCK, never against the other
    // side — including the type. Comparing the two live sides to each other
    // reads a type change as a mutual disagreement and reports a conflict
    // where only one side actually moved.
    const codeMovedOn = !l || l.type !== c.type || !sameValue(c.type, c.value, l.value)
      || !managedMetadataEqual(c, l, c);
    const figmaMovedOn = !l || l.type !== f.type || !sameValue(f.type, f.value, l.value)
      || !managedMetadataEqual(f, l, l);
    const sidesAgree = !typeChanged && sameValue(c.type, c.value, f.value)
      && managedMetadataEqual(c, f, c);

    if (sidesAgree) {
      // A pure rename is already reported as a rename; counting it as
      // unchanged too would make the summary claim more than happened.
      if (!oldName) unchanged++;
      continue;
    }

    if (!l) {
      // First sync, both sides exist with different values: nothing on disk
      // says who is right, so guessing would destroy someone's work.
      conflict.push({
        name, reason: 'untracked-divergence',
        code: c.value, figma: f.value, lock: null, type: c.type, id: f.id,
        ...syncMetadataFields(c),
        ...(typeChanged ? { typeChange: `${f.type} → ${c.type}` } : {}),
      });
      continue;
    }
    if (codeMovedOn && !figmaMovedOn) {
      const metadataChange = !managedMetadataEqual(c, f, c);
      update.push({ name, ...syncWriteFields(c), from: f.value, id: f.id,
        ...(typeChanged ? { typeChange: `${f.type} → ${c.type}` } : {}),
        ...(metadataChange ? { metadataChange: true } : {}) });
    } else if (!codeMovedOn && figmaMovedOn) {
      pull.push({ name, type: f.type, value: f.value, codeValue: c.value, id: f.id });
    } else {
      conflict.push({
        name, reason: 'both-changed',
        code: c.value, figma: f.value, lock: l.value, type: c.type, id: f.id,
        ...syncMetadataFields(c),
      });
    }
  }

  for (const [name, f] of figma) {
    if (code.has(name)) continue;
    // The old side of a rename: still in Figma, gone from code, but it is
    // being renamed rather than deleted.
    if (renamedTo.has(name)) continue;
    const l = locked.get(name);
    if (!l) {
      // Never tracked: someone else's variable in the same collection. Never
      // touched, only reported — pruning it would be vandalism.
      orphan.push({ name, type: f.type, value: f.value });
      continue;
    }
    if (!sameValue(f.type, f.value, l.value)) {
      conflict.push({
        name, reason: 'deleted-in-code-changed-in-figma',
        code: null, figma: f.value, lock: l.value, type: f.type, id: f.id,
      });
      continue;
    }
    remove.push({ name, type: f.type, value: f.value, id: f.id, willDelete: prune });
  }

  return {
    create, update, rename, pull,
    delete: remove,
    conflict, orphan, unchanged,
  };
}

/** True when applying the plan would change Figma. */
export function planTouchesFigma(plan) {
  return plan.create.length > 0
    || plan.update.length > 0
    || plan.rename.length > 0
    || plan.delete.some((d) => d.willDelete);
}

/** Human-readable plan. `apply` only changes the wording, never the content. */
export function formatPlan(plan, { collection, file, apply = false, prune = false } = {}) {
  const lines = [];
  const verb = apply ? '' : 'would ';
  lines.push(`collection: ${collection}`);
  lines.push(`source:     ${file}`);
  lines.push('');

  const section = (title, items, render) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length}):`);
    for (const item of items) lines.push(`  ${render(item)}`);
    lines.push('');
  };

  const show = (type, v) => {
    const c = canonicalValue(type, v);
    return c === null ? '—' : String(c);
  };

  section(`${verb}create`.trim(), plan.create, (t) => `+ ${t.name}  ${show(t.type, t.value)}  [${t.type}]`);
  section(`${verb}rename`.trim(), plan.rename, (t) => `~ ${t.from} → ${t.name}`);
  section(`${verb}update`.trim(), plan.update, (t) =>
    `* ${t.name}  ${show(t.type, t.from)} → ${show(t.type, t.value)}`
    + (t.typeChange ? `  (type ${t.typeChange})` : '')
    + (t.metadataChange ? '  (metadata)' : ''));

  if (plan.delete.length) {
    const title = prune ? `${verb}delete`.trim() : 'in Figma but not in code';
    section(title, plan.delete, (t) => (prune
      ? `- ${t.name}  ${show(t.type, t.value)}`
      : `- ${t.name}  ${show(t.type, t.value)}   (pass --prune to delete)`));
  }

  if (plan.pull.length) {
    lines.push(`changed in Figma — update your code file (${plan.pull.length}):`);
    for (const t of plan.pull) {
      lines.push(`  ← ${t.name}  code has ${show(t.type, t.codeValue)}, Figma has ${show(t.type, t.value)}`);
    }
    lines.push('');
  }

  if (plan.orphan.length) {
    lines.push(`untracked in Figma — never touched by sync (${plan.orphan.length}):`);
    for (const t of plan.orphan.slice(0, 10)) lines.push(`  ? ${t.name}`);
    if (plan.orphan.length > 10) lines.push(`  … and ${plan.orphan.length - 10} more`);
    lines.push('');
  }

  if (plan.conflict.length) {
    lines.push(`CONFLICTS (${plan.conflict.length}) — nothing is applied while these stand:`);
    for (const c of plan.conflict) {
      lines.push(`  ! ${c.name}  [${c.reason}]`);
      lines.push(`      code:  ${c.code === null ? '(removed)' : show(c.type, c.code)}`);
      lines.push(`      figma: ${c.figma === null ? '(deleted)' : show(c.type, c.figma)}`);
      lines.push(`      last:  ${c.lock === null ? '(never synced)' : show(c.type, c.lock)}`);
    }
    lines.push('');
    lines.push('  Resolve by editing one side to match, or re-run with --theirs (take Figma)');
    lines.push('  or --ours (take the code file) to decide all of them at once.');
    lines.push('');
  }

  lines.push(`unchanged: ${plan.unchanged}`);
  return lines.join('\n').trimEnd();
}

/**
 * Fold a conflict resolution into the plan, so --ours/--theirs reuse the exact
 * same apply path rather than a second, subtly different one.
 */
export function resolveConflicts(plan, strategy) {
  if (strategy !== 'ours' && strategy !== 'theirs') return plan;
  const next = {
    ...plan,
    create: [...plan.create],
    update: [...plan.update],
    pull: [...plan.pull],
    delete: [...plan.delete],
    conflict: [],
  };
  for (const c of plan.conflict) {
    if (strategy === 'ours') {
      // The code file wins.
      if (c.code === null) next.delete.push({ name: c.name, type: c.type, value: c.figma, id: c.id, willDelete: true });
      else if (c.figma === null) next.create.push({
        name: c.name, type: c.type, value: c.code, ...syncMetadataFields(c),
      });
      else next.update.push({
        name: c.name, type: c.type, value: c.code, from: c.figma, id: c.id,
        ...syncMetadataFields(c),
      });
    } else {
      // Figma wins: nothing is written to Figma, the divergence is reported
      // back so the user updates the code file.
      if (c.figma !== null) next.pull.push({ name: c.name, type: c.type, value: c.figma, codeValue: c.code, id: c.id });
    }
  }
  return next;
}

function normalizeScopes(scopes) {
  return Array.isArray(scopes) ? [...new Set(scopes.map(String))].sort() : [];
}

function normalizeCodeSyntax(codeSyntax) {
  if (!codeSyntax || typeof codeSyntax !== 'object') return {};
  return Object.fromEntries(Object.entries(codeSyntax)
    .filter(([, value]) => typeof value === 'string')
    .sort(([a], [b]) => a.localeCompare(b)));
}

function managedMetadataEqual(a, b, fields) {
  if (Object.hasOwn(fields || {}, 'scopes')) {
    if (JSON.stringify(normalizeScopes(a?.scopes)) !== JSON.stringify(normalizeScopes(b?.scopes))) return false;
  }
  if (Object.hasOwn(fields || {}, 'codeSyntax')) {
    if (JSON.stringify(normalizeCodeSyntax(a?.codeSyntax)) !== JSON.stringify(normalizeCodeSyntax(b?.codeSyntax))) return false;
  }
  return true;
}

function syncMetadataFields(token) {
  return {
    ...(Object.hasOwn(token, 'scopes') ? { scopes: normalizeScopes(token.scopes) } : {}),
    ...(Object.hasOwn(token, 'codeSyntax') ? { codeSyntax: normalizeCodeSyntax(token.codeSyntax) } : {}),
  };
}

function syncWriteFields(token) {
  return {
    type: token.type,
    value: token.value,
    ...syncMetadataFields(token),
  };
}
