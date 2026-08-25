import ts from 'typescript';

function namedDeclaration(sourceFile, name) {
  return sourceFile.statements.find((node) => (
    (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))
      && node.name.text === name
  ));
}

function stringLiterals(type) {
  if (type.isUnion()) return type.types.flatMap(stringLiterals);
  return type.isStringLiteral() ? [type.value] : [];
}

export function officialUnionDiscriminants({ typingsPath, contract }) {
  const program = ts.createProgram([typingsPath], {
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  });
  const sourceFile = program.getSourceFile(typingsPath);
  if (!sourceFile) throw new Error('Official Figma typings source was not loaded');
  const checker = program.getTypeChecker();
  const result = {};
  for (const [unionName, expected] of Object.entries(contract)) {
    const declaration = namedDeclaration(sourceFile, unionName);
    if (!declaration) throw new Error(`Official Figma union ${unionName} is missing`);
    const union = checker.getTypeAtLocation(declaration);
    const members = union.isUnion() ? union.types : [union];
    const values = new Set();
    for (const member of members) {
      const property = checker.getPropertyOfType(member, expected.property);
      if (!property) {
        throw new Error(`Official Figma union ${unionName} member lacks ${expected.property}`);
      }
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const literals = stringLiterals(propertyType);
      if (literals.length === 0) {
        throw new Error(
          `Official Figma union ${unionName}.${expected.property} is not a string-literal union`,
        );
      }
      for (const literal of literals) values.add(literal);
    }
    result[unionName] = Object.freeze([...values].sort());
  }
  return Object.freeze(result);
}

export function auditFigmaStyleUnionDrift({ typingsPath, contract }) {
  const official = officialUnionDiscriminants({ typingsPath, contract });
  const errors = [];
  for (const [unionName, expected] of Object.entries(contract)) {
    const bridge = [...expected.values].sort();
    const figma = official[unionName];
    if (bridge.join('\u0000') !== figma.join('\u0000')) {
      const bridgeSet = new Set(bridge);
      const figmaSet = new Set(figma);
      const missing = figma.filter((value) => !bridgeSet.has(value));
      const stale = bridge.filter((value) => !figmaSet.has(value));
      errors.push(Object.freeze({ unionName, missing, stale }));
    }
  }
  return Object.freeze({ ok: errors.length === 0, official, errors: Object.freeze(errors) });
}

function officialFieldKind(checker, type) {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return 'string';
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean';
  const rendered = checker.typeToString(type);
  if (rendered.endsWith('[]') || /^ReadonlyArray<.+>$/.test(rendered)) return 'array';
  return rendered;
}

export function officialInterfaceFieldContract({ typingsPath, interfaceName, fields }) {
  const program = ts.createProgram([typingsPath], {
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
  });
  const sourceFile = program.getSourceFile(typingsPath);
  if (!sourceFile) throw new Error('Official Figma typings source was not loaded');
  const checker = program.getTypeChecker();
  const declaration = namedDeclaration(sourceFile, interfaceName);
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    throw new Error(`Official Figma interface ${interfaceName} is missing`);
  }
  const type = checker.getTypeAtLocation(declaration);
  const result = {};
  for (const field of fields) {
    const symbol = checker.getPropertyOfType(type, field);
    if (!symbol) throw new Error(`Official Figma interface ${interfaceName}.${field} is missing`);
    const fieldType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    result[field] = Object.freeze({
      required: (symbol.flags & ts.SymbolFlags.Optional) === 0,
      kind: officialFieldKind(checker, fieldType),
    });
  }
  return Object.freeze(result);
}
