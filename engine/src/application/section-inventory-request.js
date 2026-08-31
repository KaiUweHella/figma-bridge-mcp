// Closed request Interface for `section list`.

function requestError(message) {
  return new Error(`Invalid Section Inventory command: ${message}.`);
}

export function parseSectionInventoryRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'section' || args[1] !== 'list') {
    throw new Error('Expected a section list command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Section Inventory arguments must be strings.');
  }
  const values = args.slice(2).filter((value) => value !== '--');
  if (values.length > 0) {
    throw requestError(values[0].startsWith('-')
      ? `unknown option ${values[0]}`
      : 'unexpected argument');
  }
  if (args.filter((value) => value === '--').length > 1) {
    throw requestError('option terminator may be provided only once');
  }
  return Object.freeze({});
}

export function acceptsSectionInventoryArgv(args) {
  try {
    parseSectionInventoryRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function sectionInventoryArgvFromRequest(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Section Inventory request must be an object.');
  }
  const args = ['section', 'list'];
  parseSectionInventoryRequest(args);
  return args;
}
