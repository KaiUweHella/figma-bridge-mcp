// Closed request Interface for `annotate categories`.

function requestError(message) {
  return new Error(`Invalid Annotation Category Inventory command: ${message}.`);
}

export function parseAnnotationCategoryInventoryRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'annotate' || args[1] !== 'categories') {
    throw new Error('Expected an annotate categories command.');
  }
  if (args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Annotation Category Inventory arguments must be strings.');
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

export function acceptsAnnotationCategoryInventoryArgv(args) {
  try {
    parseAnnotationCategoryInventoryRequest(args);
    return true;
  } catch {
    return false;
  }
}

export function annotationCategoryInventoryArgvFromRequest(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Annotation Category Inventory request must be an object.');
  }
  const args = ['annotate', 'categories'];
  parseAnnotationCategoryInventoryRequest(args);
  return args;
}
