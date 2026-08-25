// Preflighted, journaled batch import of native Text and Effect Styles.

import { isDeepStrictEqual } from 'node:util';
import { normalizeCompositeStyleImport } from './composite-style-import-source.js';

const PREPARED = new WeakSet();
const MAX_CANDIDATES = 20_000;
const MAX_RESULT = 262_144;
const MAX_REPORT = 200;

export function prepareCompositeStyleImport(source) {
  const value = normalizeCompositeStyleImport(source);
  PREPARED.add(value);
  return value;
}

export function compositeStyleImportRequiresFigma(prepared) {
  if (!PREPARED.has(prepared)) throw new Error('Composite Style Import requires its authentic prepared source.');
  return prepared.styles.length > 0;
}

export function compositeStyleImportCommandCode(prepared) {
  if (!PREPARED.has(prepared)) throw new Error('Composite Style Import requires its authentic prepared source.');
  return `(async () => {
    const input = ${JSON.stringify(prepared)};
    const maxCandidates = ${MAX_CANDIDATES};
    const maxReport = ${MAX_REPORT};
    const same = (actual, expected) => {
      if (typeof actual === 'number' && typeof expected === 'number') {
        return Number.isFinite(actual) && Number.isFinite(expected)
          && (Object.is(actual, expected) || Math.fround(actual) === Math.fround(expected));
      }
      if (actual === null || expected === null || typeof actual !== 'object'
        || typeof expected !== 'object') return Object.is(actual, expected);
      if (Array.isArray(actual) !== Array.isArray(expected)) return false;
      const a = Object.keys(actual).sort(); const b = Object.keys(expected).sort();
      return a.length === b.length && a.every((key, index) => key === b[index]
        && same(actual[key], expected[key]));
    };
    const differencePaths = (actual, expected, path, out = []) => {
      if (out.length >= 12 || same(actual, expected)) return out;
      if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
        || Array.isArray(actual) !== Array.isArray(expected)) { out.push(path); return out; }
      const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
      for (const key of keys) differencePaths(actual[key], expected[key],
        Array.isArray(expected) ? path + '[' + key + ']' : path + '.' + key, out);
      return out;
    };
    const canonicalEffect = (effect) => {
      if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return effect;
      const value = { ...effect };
      if (value.boundVariables && Object.keys(value.boundVariables).length === 0) delete value.boundVariables;
      if (value.type === 'DROP_SHADOW' && value.showShadowBehindNode === false) delete value.showShadowBehindNode;
      return value;
    };
    const authoredSame = (field, actual, expected) => field === 'effects'
      ? Array.isArray(actual) && Array.isArray(expected)
        && same(actual.map(canonicalEffect), expected.map(canonicalEffect))
      : same(actual, expected);
    const authoredDifferencePaths = (field, actual, expected) => field === 'effects'
      ? differencePaths(Array.isArray(actual) ? actual.map(canonicalEffect) : actual,
        Array.isArray(expected) ? expected.map(canonicalEffect) : expected, field)
      : differencePaths(actual, expected, field);
    const identity = (style) => ({
      id: style.id, key: style.key, name: style.name, type: style.type, remote: style.remote,
    });
    const summary = (items) => ({
      total: items.length, items: items.slice(0, maxReport),
      omitted: Math.max(0, items.length - maxReport),
    });
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_RESULT}) throw new Error('Composite Style Import result exceeded the bounded result limit.');
      return serialized;
    };
    const safeText = (value, empty = true) => typeof value === 'string' && value.length <= 1024
      && (empty || value.length > 0) && !/[\u0000\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
    const validStyle = (style, type) => style && safeText(style.id, false)
      && safeText(style.key) && safeText(style.name)
      && style.type === type && style.remote === false;
    const [texts, effects] = await Promise.all([
      figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(),
    ]);
    if (!Array.isArray(texts) || !Array.isArray(effects)
      || texts.length + effects.length > maxCandidates
      || texts.some((style) => !validStyle(style, 'TEXT'))
      || effects.some((style) => !validStyle(style, 'EFFECT'))
      || new Set([...texts, ...effects].map((style) => style.id)).size !== texts.length + effects.length) {
      throw new Error('Composite Style Import encountered an invalid or oversized Style catalog.');
    }
    const catalogs = { TEXT: texts, EFFECT: effects };
    const variables = await figma.variables.getLocalVariablesAsync();
    if (!Array.isArray(variables) || variables.length > maxCandidates
      || variables.some((variable) => !variable || !safeText(variable.id, false)
        || !safeText(variable.name) || !['BOOLEAN', 'COLOR', 'FLOAT', 'STRING', 'EASING', 'TIMING'].includes(variable.resolvedType)
        || variable.remote !== false)
      || new Set(variables.map((variable) => variable.id)).size !== variables.length) {
      throw new Error('Composite Style Import encountered an invalid or oversized Variable catalog.');
    }
    const variablesByName = new Map();
    const variablesById = new Map();
    for (const variable of variables) {
      variablesById.set(variable.id, variable);
      const list = variablesByName.get(variable.name) || [];
      list.push(variable); variablesByName.set(variable.name, list);
    }
    const resolveVariable = (binding) => {
      const direct = variablesById.get(binding.query);
      const matches = direct ? [direct] : (variablesByName.get(binding.query) || []);
      if (matches.length !== 1) {
        throw new Error(matches.length
          ? 'Composite Style Variable reference is ambiguous: ' + binding.query
          : 'Composite Style Variable was not found: ' + binding.query);
      }
      if (matches[0].resolvedType !== binding.expectedType) {
        throw new Error('Composite Style Variable has incompatible type: ' + binding.query);
      }
      return matches[0];
    };
    const resolutions = [];
    const fontKeys = new Set();
    const fonts = [];
    for (const item of input.styles) {
      const catalog = catalogs[item.kind];
      const sourceMatches = item.sourceIdentity
        ? catalog.filter((style) => (item.sourceIdentity.id && style.id === item.sourceIdentity.id)
          || (item.sourceIdentity.key && style.key === item.sourceIdentity.key))
        : [];
      const nameMatches = catalog.filter((style) => style.name === item.name);
      if (item.sourceIdentity && sourceMatches.length === 0 && nameMatches.length) {
        throw new Error('Composite Style source identity conflicts with an existing authored name: ' + item.name);
      }
      const matches = sourceMatches.length ? sourceMatches : nameMatches;
      if (matches.length > 1) throw new Error('Composite Style identity is ambiguous: ' + item.name);
      if (sourceMatches.length === 1 && sourceMatches[0].name !== item.name) {
        throw new Error('Composite Style source identity resolves to a different authored name: ' + item.name);
      }
      const resolvedBindings = {};
      for (const [field, binding] of Object.entries(item.bindings)) {
        resolvedBindings[field] = resolveVariable(binding);
      }
      if (item.kind === 'TEXT') {
        const key = item.properties.fontName.family + '\u0000' + item.properties.fontName.style;
        if (!fontKeys.has(key)) { fontKeys.add(key); fonts.push(item.properties.fontName); }
      }
      const existing = matches[0] || null;
      if (existing) {
        const fieldsMatch = Object.entries(item.properties)
          .every(([field, value]) => authoredSame(field, existing[field], value));
        const bindingsMatch = Object.entries(resolvedBindings).every(([field, variable]) => {
          const alias = existing.boundVariables && existing.boundVariables[field];
          return alias && alias.type === 'VARIABLE_ALIAS' && alias.id === variable.id;
        });
        const unrequestedBindings = Object.keys(existing.boundVariables || {})
          .filter((field) => !Object.hasOwn(resolvedBindings, field));
        if (existing.description !== item.description || !fieldsMatch || !bindingsMatch || unrequestedBindings.length) {
          throw new Error('Composite Style existing authored state differs: ' + item.name);
        }
      }
      resolutions.push({ item, existing, bindings: resolvedBindings });
    }
    // Every fallible font and Variable lookup completes before the first Style write.
    for (const font of fonts) await figma.loadFontAsync(font);
    const journal = [];
    const journalIds = new Set();
    const created = [];
    const matched = [];
    try {
      for (const resolved of resolutions) {
        if (resolved.existing) { matched.push(identity(resolved.existing)); continue; }
        const style = resolved.item.kind === 'TEXT'
          ? figma.createTextStyle() : figma.createEffectStyle();
        if (!validStyle(style, resolved.item.kind)) {
          try { style?.remove?.(); } catch {}
          throw new Error('Composite Style factory returned incompatible identity.');
        }
        if (journalIds.has(style.id) || [...texts, ...effects].some((candidate) => candidate.id === style.id)) {
          try { style.remove(); } catch {}
          throw new Error('Composite Style factory returned a duplicate identity.');
        }
        journalIds.add(style.id);
        journal.push(style);
        style.name = resolved.item.name;
        style.description = resolved.item.description;
        for (const [field, value] of Object.entries(resolved.item.properties)) style[field] = value;
        if (Object.keys(resolved.bindings).length && typeof style.setBoundVariable !== 'function') {
          throw new Error('Composite Text Style binding API is unavailable.');
        }
        for (const [field, variable] of Object.entries(resolved.bindings)) {
          style.setBoundVariable(field, variable);
        }
        resolved.native = style;
        created.push(identity(style));
      }
      const verified = [];
      for (const resolved of resolutions) {
        const expected = resolved.existing || resolved.native;
        const style = await figma.getStyleByIdAsync(expected.id);
        const failedFields = !style ? ['identity'] : [
          ...(!validStyle(style, resolved.item.kind) || style.name !== resolved.item.name ? ['identity'] : []),
          ...(style.description !== resolved.item.description ? ['description'] : []),
          ...Object.entries(resolved.item.properties)
            .flatMap(([field, value]) => authoredDifferencePaths(field, style[field], value)),
          ...Object.entries(resolved.bindings).filter(([field, variable]) => {
            const alias = style.boundVariables && style.boundVariables[field];
            return !(alias && alias.type === 'VARIABLE_ALIAS' && alias.id === variable.id);
          }).map(([field]) => 'binding:' + field),
        ];
        if (failedFields.length) throw new Error('Composite Style postcondition failed: '
          + resolved.item.name + ' (' + failedFields.join(', ') + ')');
        verified.push(identity(style));
      }
      return bounded({ schemaVersion: 1, status: 'complete', created: summary(created),
        matching: summary(matched), verified: summary(verified), unsupported: input.unsupported,
        residue: { total: 0, items: [], omitted: 0 } });
    } catch (cause) {
      const residue = [];
      let removed = 0;
      for (let index = journal.length - 1; index >= 0; index--) {
        try { journal[index].remove(); removed++; }
        catch { residue.push(identity(journal[index])); }
      }
      return bounded({ schemaVersion: 1, status: 'failed', outcome: residue.length ? 'partial-residue' : 'rolled-back',
        attempted: journal.length, removed, unsupported: input.unsupported,
        residue: summary(residue), reason: String(cause && cause.message || cause).slice(0, 1024) });
    }
  })()`;
}

function validSummary(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'items,omitted,total'
    && Number.isInteger(value.total) && value.total >= 0
    && Array.isArray(value.items) && value.items.length <= MAX_REPORT
    && Number.isInteger(value.omitted) && value.omitted === value.total - value.items.length;
}

function validIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'id,key,name,remote,type'
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 1024
    && typeof value.key === 'string' && value.key.length <= 1024
    && typeof value.name === 'string' && value.name.length <= 1024
    && ['TEXT', 'EFFECT'].includes(value.type) && value.remote === false;
}

function validUnsupported(value, prepared) {
  return Array.isArray(value) && isDeepStrictEqual(value, prepared.unsupported);
}

function validComplete(value, prepared) {
  return value && value.schemaVersion === 1 && value.status === 'complete'
    && Object.keys(value).sort().join(',') === 'created,matching,residue,schemaVersion,status,unsupported,verified'
    && [value.created, value.matching, value.verified, value.residue].every(validSummary)
    && [...value.created.items, ...value.matching.items, ...value.verified.items,
      ...value.residue.items].every(validIdentity)
    && value.created.total + value.matching.total === prepared.styles.length
    && value.verified.total === prepared.styles.length && value.residue.total === 0
    && validUnsupported(value.unsupported, prepared);
}

function validFailure(value, prepared) {
  return value && value.schemaVersion === 1 && value.status === 'failed'
    && Object.keys(value).sort().join(',') === 'attempted,outcome,reason,removed,residue,schemaVersion,status,unsupported'
    && ['rolled-back', 'partial-residue'].includes(value.outcome)
    && Number.isInteger(value.attempted) && value.attempted >= 0 && value.attempted <= prepared.styles.length
    && Number.isInteger(value.removed) && value.removed >= 0 && value.removed <= value.attempted
    && validSummary(value.residue) && value.residue.items.every(validIdentity)
    && value.removed + value.residue.total === value.attempted
    && (value.outcome === 'rolled-back' ? value.residue.total === 0 : value.residue.total > 0)
    && typeof value.reason === 'string' && value.reason.length <= 1024
    && validUnsupported(value.unsupported, prepared);
}

export async function executeCompositeStyleImport(prepared, adapters = {}) {
  if (!PREPARED.has(prepared)) throw new Error('Composite Style Import requires its authentic prepared source.');
  if (!prepared.styles.length) {
    return { stdout: JSON.stringify({ created: 0, matching: 0, unsupported: prepared.unsupported }, null, 2),
      stderr: prepared.unsupported.length ? `${prepared.unsupported.length} composite construct(s) remain unsupported.` : '',
      code: 0, result: { schemaVersion: 1, status: 'complete', created: 0, matching: 0,
        unsupported: prepared.unsupported, residue: 0 } };
  }
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Composite Style Import requires evaluate(code).');
  const serialized = await adapters.evaluate(compositeStyleImportCommandCode(prepared));
  if (typeof serialized !== 'string' || serialized.length > MAX_RESULT) throw new Error('Composite Style Import returned an invalid bounded result.');
  let payload;
  try { payload = JSON.parse(serialized); } catch { throw new Error('Composite Style Import returned invalid JSON.'); }
  if (payload?.status === 'failed') {
    if (!validFailure(payload, prepared)) throw new Error('Composite Style Import returned an invalid bounded result.');
    const error = new Error(`${payload.outcome === 'rolled-back'
      ? `Composite Style Import failed; ${payload.removed} created Style(s) were removed.`
      : `Composite Style Import failed; ${payload.residue.total} created Style(s) may remain.`} ${payload.reason}`);
    error.kind = 'execution'; error.phase = 'plugin-execution'; error.outcome = 'unknown-after-dispatch';
    error.dispatchState = 'failed'; error.mutationOutcome = payload.outcome;
    error.compositeStyleReport = payload; throw error;
  }
  if (!validComplete(payload, prepared)) throw new Error('Composite Style Import returned an invalid bounded result.');
  const result = { schemaVersion: 1, status: 'complete', created: payload.created.total,
    matching: payload.matching.total, unsupported: payload.unsupported, residue: 0,
    styles: payload.verified.items, stylesOmitted: payload.verified.omitted };
  return {
    stdout: `Imported ${result.created} composite Style(s); matched ${result.matching} existing Style(s).`,
    stderr: result.unsupported.length ? `${result.unsupported.length} composite construct(s) remain explicitly unsupported.` : '',
    code: 0, result,
  };
}
