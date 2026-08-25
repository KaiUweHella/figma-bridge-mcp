import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const FIGMA_TYPINGS_PACKAGE = '@figma/plugin-typings';
export const FIGMA_TYPINGS_VERSION = '1.133.0';
export const FIGMA_TYPINGS_SOURCE_SHA256 = '010eadcbbd278bcd6b99b15f6ba9eacb00be69e14519930b5b816c56c1bc146d';
export const FIGMA_TYPINGS_MATERIAL_VERSION = `figma-plugin-typings-${FIGMA_TYPINGS_VERSION}-${FIGMA_TYPINGS_SOURCE_SHA256.slice(0, 12)}`;
export const OFFICIAL_TYPINGS_DIRECTORY = path.join(root, 'node_modules', '@figma', 'plugin-typings');
export const OFFICIAL_TYPINGS_PATH = path.join(OFFICIAL_TYPINGS_DIRECTORY, 'plugin-api.d.ts');
export const OFFICIAL_TYPINGS_PACKAGE_PATH = path.join(OFFICIAL_TYPINGS_DIRECTORY, 'package.json');

export const API_REFERENCE_LIMITS = Object.freeze({
  sourceBytes: 1_000_000,
  storeBytes: 2_000_000,
  files: 16,
  entries: 2_000,
  entryBytes: 300_000,
  membersPerEntry: 2_048,
  nameCodeUnits: 128,
  summaryCodeUnits: 2_048,
  signatureCodeUnits: 4_096,
  queryCodeUnits: 128,
  contextBytes: 1_000_000,
});

export const API_REFERENCE_POLICY = Object.freeze({
  packageName: FIGMA_TYPINGS_PACKAGE,
  packageVersion: FIGMA_TYPINGS_VERSION,
  sourceSha256: FIGMA_TYPINGS_SOURCE_SHA256,
  materialVersion: FIGMA_TYPINGS_MATERIAL_VERSION,
  sourceDirectory: OFFICIAL_TYPINGS_DIRECTORY,
  sourcePath: OFFICIAL_TYPINGS_PATH,
  packagePath: OFFICIAL_TYPINGS_PACKAGE_PATH,
  limits: API_REFERENCE_LIMITS,
});
