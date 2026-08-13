const FLOAT_SCOPE_FAMILIES = Object.freeze({
  GAP: new Set(['space', 'spacing']),
  CORNER_RADIUS: new Set(['radius', 'radii']),
});

/**
 * Figma's VariableScope union, grouped by the variable type that can actually
 * supply the corresponding design property. ALL_SCOPES means unrestricted;
 * it is a fallback, not a recommendation to select every specialized scope.
 */
const VARIABLE_SCOPES_BY_TYPE = Object.freeze({
  COLOR: Object.freeze([
    'ALL_SCOPES', 'ALL_FILLS', 'FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL',
    'STROKE_COLOR', 'EFFECT_COLOR',
  ]),
  FLOAT: Object.freeze([
    'ALL_SCOPES', 'CORNER_RADIUS', 'WIDTH_HEIGHT', 'GAP', 'STROKE_FLOAT',
    'EFFECT_FLOAT', 'OPACITY', 'FONT_WEIGHT', 'FONT_SIZE', 'LINE_HEIGHT',
    'LETTER_SPACING', 'PARAGRAPH_SPACING', 'PARAGRAPH_INDENT',
  ]),
  STRING: Object.freeze(['ALL_SCOPES', 'TEXT_CONTENT', 'FONT_FAMILY', 'FONT_STYLE']),
  BOOLEAN: Object.freeze(['ALL_SCOPES']),
});

function variableScopeOptionsForType(resolvedType) {
  const type = String(resolvedType || '').toUpperCase();
  return [...(VARIABLE_SCOPES_BY_TYPE[type] || ['ALL_SCOPES'])];
}

/**
 * Infer a narrow Figma VariableScope only from an explicit semantic namespace.
 * Substring guesses are deliberately forbidden: `spacingFactor` and
 * `brandRadiusColor` are not spacing/radius tokens merely because their names
 * contain those words.
 */
function variableScopesForToken(name, resolvedType) {
  if (String(resolvedType || '').toUpperCase() !== 'FLOAT') return null;
  const head = String(name || '').trim().toLowerCase().split('/')[0];
  if (FLOAT_SCOPE_FAMILIES.GAP.has(head)) return ['GAP'];
  if (FLOAT_SCOPE_FAMILIES.CORNER_RADIUS.has(head)) return ['CORNER_RADIUS'];
  return null;
}

function applyVariableScopePolicy(variable, name = variable?.name, resolvedType = variable?.resolvedType) {
  const scopes = variableScopesForToken(name, resolvedType);
  if (variable && scopes) variable.scopes = scopes;
  return scopes;
}

/**
 * Describe the human decision for a newly created variable. Safe namespaces
 * are applied automatically; every other type with specialized Figma scopes
 * is surfaced instead of being guessed from a vague token name.
 */
function variableScopeDecision(name, resolvedType, collection = null) {
  const type = String(resolvedType || '').toUpperCase();
  const automaticScopes = variableScopesForToken(name, type);
  const allowedScopes = variableScopeOptionsForType(type);
  if (automaticScopes) {
    return {
      name, collection, resolvedType: type,
      status: 'AUTO_SCOPED', scopes: automaticScopes, allowedScopes,
    };
  }
  if (allowedScopes.length === 1) return null;
  return {
    name, collection, resolvedType: type,
    status: 'USER_DECISION_REQUIRED',
    currentScopes: ['ALL_SCOPES'],
    allowedScopes,
    question: `Should "${name}" remain unrestricted (ALL_SCOPES), or be limited to one or more compatible ${type} scopes?`,
  };
}

function variableScopeQuestions(tokens, collection = null) {
  return (tokens || [])
    .map((token) => variableScopeDecision(token.name, token.type || token.resolvedType, collection))
    .filter((decision) => decision?.status === 'USER_DECISION_REQUIRED');
}

/** Embed the same policy in generated Figma-plugin code. */
function variableScopePolicyCode(functionName = '__scopeTokenVariable') {
  return `const __variableScopeOptionsByType = ${JSON.stringify(VARIABLE_SCOPES_BY_TYPE)};
const ${functionName} = (variable, name, resolvedType) => {
  if (String(resolvedType || '').toUpperCase() !== 'FLOAT') return null;
  const head = String(name || '').trim().toLowerCase().split('/')[0];
  const scopes = (head === 'space' || head === 'spacing') ? ['GAP']
    : (head === 'radius' || head === 'radii') ? ['CORNER_RADIUS'] : null;
  if (variable && scopes) variable.scopes = scopes;
  return scopes;
};
const __variableScopeQuestion = (name, resolvedType, collection = null) => {
  const type = String(resolvedType || '').toUpperCase();
  if (${functionName}(null, name, type)) return null;
  const allowedScopes = __variableScopeOptionsByType[type] || ['ALL_SCOPES'];
  if (allowedScopes.length === 1) return null;
  return {
    name, collection, resolvedType: type, status: 'USER_DECISION_REQUIRED',
    currentScopes: ['ALL_SCOPES'], allowedScopes,
    question: 'Should "' + name + '" remain unrestricted (ALL_SCOPES), or be limited to one or more compatible ' + type + ' scopes?'
  };
};`;
}

export {
  VARIABLE_SCOPES_BY_TYPE,
  applyVariableScopePolicy,
  variableScopeDecision,
  variableScopeOptionsForType,
  variableScopePolicyCode,
  variableScopeQuestions,
  variableScopesForToken,
};
