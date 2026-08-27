#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_BUILD_VERSION } from '../engine/src/lib/plugin-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_COMPATIBILITY_FILES = Object.freeze([
  'plugin/code.js',
  'plugin/ui.html',
  'plugin/manifest.json',
  'plugin/manifest.dev.json',
  'engine/src/lib/protocol-contract.js',
  'engine/src/lib/asset-stream-protocol.js',
  'engine/src/lib/dispatch-receipt.js',
  'engine/src/lib/plugin-execution-timing.js',
  'engine/src/lib/typed-read-operations.js',
  'engine/src/lib/structured-render-executor.js',
]);
const HISTORY_PATH = join(ROOT, 'plugin', 'compatibility-history.json');
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

const normalizeLf = (value) => String(value).replace(/\r\n?/g, '\n');

function semver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = semver(left);
  const b = semver(right);
  if (!a || !b) throw new Error(`Plugin compatibility versions must be x.y.z (${left}, ${right}).`);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function pluginCompatibilityFingerprint({ root = ROOT, read = readFileSync } = {}) {
  const hash = createHash('sha256');
  for (const file of PLUGIN_COMPATIBILITY_FILES) {
    const content = normalizeLf(read(join(root, file), 'utf8'));
    hash.update(file);
    hash.update('\0');
    hash.update(String(Buffer.byteLength(content, 'utf8')));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function pluginUiVersion(source) {
  const matches = [...normalizeLf(source).matchAll(/\bconst PLUGIN_VERSION = '([^']+)';/g)];
  if (matches.length !== 1 || !semver(matches[0][1])) {
    throw new Error('plugin/ui.html must declare exactly one semantic PLUGIN_VERSION.');
  }
  return matches[0][1];
}

export function validateCompatibilityHistory(history) {
  if (!history || history.schemaVersion !== 1 || !Array.isArray(history.entries)
    || history.entries.length < 1) {
    throw new Error('Plugin compatibility history must contain at least one schema v1 entry.');
  }
  let previous = null;
  for (let index = 0; index < history.entries.length; index++) {
    const entry = history.entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'fingerprint,previousFingerprint,version'
      || !semver(entry.version) || !FINGERPRINT_RE.test(entry.fingerprint)
      || entry.previousFingerprint !== previous) {
      throw new Error(`Plugin compatibility history entry ${index + 1} is invalid or breaks the append-only chain.`);
    }
    if (index > 0 && compareVersions(entry.version, history.entries[index - 1].version) <= 0) {
      throw new Error('Plugin compatibility history versions must increase strictly.');
    }
    previous = entry.fingerprint;
  }
  return history.entries.at(-1);
}

export function validatePluginCompatibilityState({ history, version, uiVersion, fingerprint }) {
  if (!semver(version)) throw new Error(`PLUGIN_BUILD_VERSION must be semantic, got ${version}.`);
  if (uiVersion !== version) {
    throw new Error(`Plugin UI version ${uiVersion} does not match PLUGIN_BUILD_VERSION ${version}.`);
  }
  if (!FINGERPRINT_RE.test(fingerprint)) throw new Error('Plugin compatibility fingerprint is invalid.');
  const current = validateCompatibilityHistory(history);
  if (current.version !== version || current.fingerprint !== fingerprint) {
    const sameVersion = current.version === version;
    throw new Error(sameVersion
      ? `Plugin compatibility changed without advancing ${version}. Bump PLUGIN_BUILD_VERSION and the UI version, then run npm run sync:plugin-compatibility.`
      : `Plugin compatibility history ends at ${current.version}, but the current build is ${version}. Run npm run sync:plugin-compatibility.`);
  }
  return current;
}

function readHistory() {
  if (!existsSync(HISTORY_PATH)) return null;
  return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
}

function currentFacts() {
  return {
    version: PLUGIN_BUILD_VERSION,
    uiVersion: pluginUiVersion(readFileSync(join(ROOT, 'plugin', 'ui.html'), 'utf8')),
    fingerprint: pluginCompatibilityFingerprint(),
  };
}

function record() {
  const facts = currentFacts();
  if (facts.uiVersion !== facts.version) {
    throw new Error(`Plugin UI version ${facts.uiVersion} does not match PLUGIN_BUILD_VERSION ${facts.version}.`);
  }
  const history = readHistory() || { schemaVersion: 1, entries: [] };
  if (history.entries.length) {
    const last = validateCompatibilityHistory(history);
    if (last.fingerprint === facts.fingerprint && last.version === facts.version) return false;
    if (compareVersions(facts.version, last.version) <= 0) {
      throw new Error(`Refusing to rewrite Plugin compatibility ${last.version}; advance PLUGIN_BUILD_VERSION first.`);
    }
  }
  const previousFingerprint = history.entries.at(-1)?.fingerprint || null;
  history.entries.push({
    version: facts.version,
    fingerprint: facts.fingerprint,
    previousFingerprint,
  });
  writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  return true;
}

function check() {
  const history = readHistory();
  if (!history) throw new Error(`Missing ${relative(ROOT, HISTORY_PATH)}; run npm run sync:plugin-compatibility.`);
  validatePluginCompatibilityState({ history, ...currentFacts() });
}

function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--check')) {
    check();
    process.stdout.write('Plugin compatibility fingerprint and version history are current.\n');
    return;
  }
  if (args.length === 1 && args[0] === '--record') {
    process.stdout.write(record()
      ? 'Appended the current Plugin compatibility fingerprint.\n'
      : 'Plugin compatibility fingerprint is already recorded.\n');
    return;
  }
  if (args.length === 1 && args[0] === '--print') {
    process.stdout.write(`${JSON.stringify(currentFacts(), null, 2)}\n`);
    return;
  }
  throw new Error('Usage: node scripts/check-plugin-compatibility.js [--check|--record|--print]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
