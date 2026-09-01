// Bounded Team Library Variable reads behind one safe-retrying Plan seam.

import { isFigmaCommandPlan } from '../../../src/capability-catalog.js';
import {
  LIBRARY_READ_ACTIONS,
  LIBRARY_VARIABLE_TYPES,
  libraryReadArgvFromRequest,
  parseLibraryReadRequest,
} from './library-read-request.js';

export { libraryReadArgvFromRequest } from './library-read-request.js';
export const MAX_LIBRARY_READ_ITEMS = 10_000;
export const MAX_LIBRARY_READ_RESULT_CODE_UNITS = 2_000_000;
const APPLICATION_IDS = new Set(LIBRARY_READ_ACTIONS.map((action) => `library.${action}`));
const normalized = (request) => parseLibraryReadRequest(libraryReadArgvFromRequest(request));
const js = (value) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function libraryReadCode(request) {
  const input = normalized(request);
  return `(async () => {
    const request = ${js(input)};
    const clean = (value, maximum) => typeof value === 'string' ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ') : '';
    const bounded = (value) => { const serialized = JSON.stringify(value); if (serialized.length > ${MAX_LIBRARY_READ_RESULT_CODE_UNITS}) throw new Error('Library Read result exceeded its bounded response limit.'); return serialized; };
    if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== 'function') throw new Error('Figma Team Library Variable discovery is unavailable.');
    const rawCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    if (!Array.isArray(rawCollections) || rawCollections.length > ${MAX_LIBRARY_READ_ITEMS}) throw new Error('Library collection inventory exceeded its bounded item limit.');
    const collectionFacts = (collection) => {
      if (!collection || typeof collection.key !== 'string' || !collection.key.length || collection.key.length > 1024 || typeof collection.name !== 'string' || collection.name.length > 1024 || typeof collection.libraryName !== 'string' || collection.libraryName.length > 1024) throw new Error('Library collection facts are invalid.');
      return { key: clean(collection.key, 1024), name: clean(collection.name, 1024), libraryName: clean(collection.libraryName, 1024) };
    };
    const indexed = rawCollections.map((raw) => ({ raw, facts: collectionFacts(raw) }));
    if (new Set(indexed.map((entry) => entry.facts.key)).size !== indexed.length) throw new Error('Library collection inventory contains duplicate keys.');
    if (request.action === 'collections') return bounded(indexed.map((entry) => entry.facts).sort((left, right) => left.libraryName.localeCompare(right.libraryName) || left.name.localeCompare(right.name) || left.key.localeCompare(right.key)));
    if (typeof figma.teamLibrary.getVariablesInLibraryCollectionAsync !== 'function') throw new Error('Figma Team Library Variable discovery is unavailable.');
    const exact = indexed.filter((entry) => entry.facts.key === request.collection || entry.facts.name === request.collection);
    const query = request.collection.toLowerCase();
    const matches = exact.length ? exact : indexed.filter((entry) => entry.facts.name.toLowerCase().includes(query) || entry.facts.libraryName.toLowerCase().includes(query));
    if (matches.length > 1) throw new Error('Library collection query is ambiguous.');
    if (!matches.length) throw new Error('Enabled Library Variable Collection was not found. Enable its library in the Figma UI first.');
    let variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(matches[0].facts.key);
    if (!Array.isArray(variables) || variables.length > ${MAX_LIBRARY_READ_ITEMS}) throw new Error('Library Variable inventory exceeded its bounded item limit.');
    if (request.type) variables = variables.filter((variable) => variable && variable.resolvedType === request.type);
    const facts = variables.map((variable) => {
      if (!variable || typeof variable.key !== 'string' || !variable.key.length || variable.key.length > 1024 || typeof variable.name !== 'string' || variable.name.length > 1024 || !${js(LIBRARY_VARIABLE_TYPES)}.includes(variable.resolvedType)) throw new Error('Library Variable facts are invalid.');
      return { key: clean(variable.key, 1024), name: clean(variable.name, 1024), resolvedType: variable.resolvedType };
    }).sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
    if (new Set(facts.map((variable) => variable.key)).size !== facts.length) throw new Error('Library Variable inventory contains duplicate keys.');
    return bounded({ collection: matches[0].facts, variables: facts });
  })()`;
}

function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
const text = (value, maximum, empty = true) => typeof value === 'string' && value.length <= maximum && (empty || value.length > 0);
function collectionValue(value) { return exact(value, ['key','name','libraryName']) && text(value.key, 1024, false) && text(value.name, 1024) && text(value.libraryName, 1024); }
function variableValue(value) { return exact(value, ['key','name','resolvedType']) && text(value.key, 1024, false) && text(value.name, 1024) && LIBRARY_VARIABLE_TYPES.includes(value.resolvedType); }
const unique = (values) => new Set(values).size === values.length;
const ordered = (values, compare) => values.every((value, index) => index === 0 || compare(values[index - 1], value) <= 0);
function validResult(value, input) {
  if (input.action === 'collections') return Array.isArray(value) && value.length <= MAX_LIBRARY_READ_ITEMS && value.every(collectionValue) && unique(value.map((item) => item.key)) && ordered(value, (left, right) => left.libraryName.localeCompare(right.libraryName) || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  const query = input.collection.toLowerCase();
  const selected = collectionValue(value?.collection) && (value.collection.key === input.collection || value.collection.name === input.collection || value.collection.name.toLowerCase().includes(query) || value.collection.libraryName.toLowerCase().includes(query));
  return exact(value, ['collection','variables']) && selected && Array.isArray(value.variables) && value.variables.length <= MAX_LIBRARY_READ_ITEMS && value.variables.every((variable) => variableValue(variable) && (!input.type || variable.resolvedType === input.type)) && unique(value.variables.map((item) => item.key)) && ordered(value.variables, (left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}
function invalid(message) { const error = new Error(message); Object.assign(error, { kind: 'execution', phase: 'plugin-response', outcome: 'unknown-after-dispatch', dispatchState: 'failed' }); return error; }
function safe(value) { return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }

export async function executeLibraryRead(request, adapters = {}) {
  if (typeof adapters.evaluate !== 'function') throw new TypeError('Library Read requires a Figma evaluate adapter.');
  const input = normalized(request); const serialized = await adapters.evaluate(libraryReadCode(input));
  if (typeof serialized !== 'string' || serialized.length > MAX_LIBRARY_READ_RESULT_CODE_UNITS) throw invalid('Library Read returned an invalid bounded result.');
  let result; try { result = JSON.parse(serialized); } catch { throw invalid('Library Read returned invalid JSON.'); }
  if (!validResult(result, input)) throw invalid('Library Read returned an invalid bounded result.');
  return { stdout: safe(result), stderr: '', result };
}
export function libraryReadPlanRoute(plan) { if (!isFigmaCommandPlan(plan)) throw new TypeError('Library Read routing requires a Command Plan.'); return plan.allowed && APPLICATION_IDS.has(plan.id) ? 'command-application' : 'not-library-read'; }
export function executeLibraryReadPlan(plan, adapters = {}) { if (libraryReadPlanRoute(plan) !== 'command-application') throw new Error('Command Plan is not owned by Library Read.'); return executeLibraryRead(parseLibraryReadRequest(plan.argv), adapters); }
