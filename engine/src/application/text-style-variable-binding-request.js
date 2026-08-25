// Closed request Interface for `style bind-font` and `style unbind-font`.

export const MAX_TEXT_STYLE_BINDING_QUERY_CODE_UNITS = 512;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
export const TEXT_STYLE_VARIABLE_FIELDS = Object.freeze([
  'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing',
  'lineHeight', 'paragraphSpacing', 'paragraphIndent',
]);

function requestError(message) { return new Error(`Invalid Text Style variable binding command: ${message}.`); }
function queryValue(value, name) {
  if (typeof value !== 'string' || !value) throw requestError(`${name} is required`);
  if (value.length > MAX_TEXT_STYLE_BINDING_QUERY_CODE_UNITS) throw requestError(`${name} is too long`);
  if (UNSAFE.test(value)) throw requestError(`${name} contains unsafe control characters`);
  return value;
}
function fieldValue(value) {
  if (typeof value !== 'string' || !TEXT_STYLE_VARIABLE_FIELDS.includes(value)) {
    throw requestError(`field must be one of ${TEXT_STYLE_VARIABLE_FIELDS.join(', ')}`);
  }
  return value;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== 'style' || !['bind-font', 'unbind-font'].includes(args[1])) {
    throw new Error('Expected a Text Style variable binding command.');
  }
  if (args.some((value) => typeof value !== 'string')) throw new TypeError('Text Style binding arguments must be strings.');
  const bind = args[1] === 'bind-font';
  const positionals = [];
  let variable = null;
  let sawVariable = false;
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    const inline = !literal ? token.match(/^--variable=(.*)$/s) : null;
    if (!literal && (token === '--variable' || inline)) {
      if (sawVariable) throw requestError('--variable may be provided only once');
      sawVariable = true;
      variable = inline ? inline[1] : args[++index];
      if (variable === undefined || variable === '') throw requestError('--variable requires a value');
      continue;
    }
    if (!literal && token.startsWith('-')) throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (bind && !sawVariable) throw requestError('--variable is required for bind-font');
  if (!bind && sawVariable) throw requestError('--variable is not accepted for unbind-font');
  if (positionals.length < 2) throw requestError('style and field are required');
  if (positionals.length > 2) throw requestError(`unexpected argument ${positionals[2]}`);
  return {
    action: bind ? 'bind' : 'unbind', style: queryValue(positionals[0], 'style'),
    field: fieldValue(positionals[1]), variable: bind ? queryValue(variable, 'variable') : null,
  };
}

export function parseTextStyleVariableBindingRequest(args) { return parsedRequest(args); }
export function acceptsTextStyleVariableBindingArgv(args) {
  try { parsedRequest(args); return true; } catch { return false; }
}
function typedRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Text Style binding request must be an object.');
  if (!['bind', 'unbind'].includes(request.action)) throw requestError('action must be bind or unbind');
  return {
    action: request.action, style: queryValue(request.style, 'style'), field: fieldValue(request.field),
    variable: request.action === 'bind' ? queryValue(request.variable, 'variable') : null,
  };
}
export function textStyleVariableBindingArgvFromRequest(request) {
  const input = typedRequest(request);
  return ['style', input.action === 'bind' ? 'bind-font' : 'unbind-font',
    ...(input.variable ? ['--variable', input.variable] : []), '--', input.style, input.field];
}
export const textStyleVariableBindingPlanningArgvFromRequest = textStyleVariableBindingArgvFromRequest;
