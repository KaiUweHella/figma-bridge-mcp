// Closed request Interface for `library import-*` materialization writes.

export const LIBRARY_IMPORT_ACTIONS = Object.freeze([
  'variable', 'style', 'component', 'component-set',
]);
export const MAX_LIBRARY_IMPORT_KEY_CODE_UNITS = 1_024;

const SUBCOMMANDS = Object.freeze({
  'import-variable': 'variable',
  'import-style': 'style',
  'import-component': 'component',
  'import-component-set': 'component-set',
});
const ACTION_SUBCOMMANDS = Object.freeze(Object.fromEntries(
  Object.entries(SUBCOMMANDS).map(([subcommand, action]) => [action, subcommand]),
));
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid Library Import command: ${message}.`);
}

function actionValue(value) {
  if (typeof value !== 'string' || !LIBRARY_IMPORT_ACTIONS.includes(value)) {
    throw requestError('action must be variable, style, component, or component-set');
  }
  return value;
}

function keyValue(value) {
  if (typeof value !== 'string') throw requestError('key must be a string');
  const key = value.trim();
  if (!key.length) throw requestError('key is required');
  if (key.length > MAX_LIBRARY_IMPORT_KEY_CODE_UNITS) throw requestError('key exceeds its bounded length');
  if (UNSAFE.test(key)) throw requestError('key contains unsafe control characters');
  return key;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Library Import arguments must be strings.');
  }
  if (args[0] !== 'library' || !Object.hasOwn(SUBCOMMANDS, args[1])) {
    throw new Error('Expected a Library Import command.');
  }
  const action = SUBCOMMANDS[args[1]];
  const values = args.slice(2);
  if (values[0] === '--') values.shift();
  if (!values.length) throw requestError('key is required');
  if (values.length > 1) throw requestError(`unexpected argument ${values[1]}`);
  if (values[0].startsWith('-')) throw requestError(`unknown option ${values[0]}`);
  return { action, key: keyValue(values[0]) };
}

export function parseLibraryImportRequest(args) {
  return parsedRequest(args);
}

export function acceptsLibraryImportArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}

function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Library Import request must be an object.');
  }
  return { action: actionValue(request.action), key: keyValue(request.key) };
}

export function libraryImportArgvFromRequest(request) {
  const input = typedRequest(request);
  const args = ['library', ACTION_SUBCOMMANDS[input.action], '--', input.key];
  parseLibraryImportRequest(args);
  return args;
}
