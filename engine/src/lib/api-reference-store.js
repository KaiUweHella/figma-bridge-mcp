// Private, atomic Shared-State Module for the official Figma Plugin API
// reference. Acquisition is local: the exactly pinned npm dependency is
// validated, projected and published without a network or shell process.

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './state-dir.js';
import { API_REFERENCE_POLICY } from './api-reference-policy.js';

export const API_REFERENCE_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const MATERIAL_FILE = /^official-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{64}\.json$/;
const TEMP_FILE = /^\.reference-[0-9]+-[a-f0-9-]{36}\.tmp$/;

export class ApiReferenceStoreError extends Error {
  constructor(reason, code = 'API_REFERENCE_REJECTED') {
    super(`Figma API reference rejected: ${reason}.`);
    this.name = 'ApiReferenceStoreError';
    this.code = code;
    this.kind = 'shared-state-policy';
  }
}

function reject(reason, code) {
  throw new ApiReferenceStoreError(reason, code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inodeMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function safeText(value, maximum, { empty = true } = {}) {
  return typeof value === 'string' && value.length <= maximum
    && (empty || value.length > 0) && !UNSAFE_TEXT.test(value);
}

function sourceSummary(source, maximum) {
  const comment = source.match(/^\/\*\*([\s\S]*?)\*\//)?.[1] || '';
  const text = comment
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line && !line.startsWith('@'))
    .join(' ')
    .replace(/\{@link\s+([^}|]+)(?:\|[^}]+)?\}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function declarationMembers(source, limits) {
  const members = [];
  const seen = new Set();
  const member = /^  (?:readonly\s+)?([A-Za-z_$][\w$]*)\??(?:<[^>\n]*>)?\s*(?:\(|:)/gm;
  for (const match of source.matchAll(member)) {
    const name = match[1];
    if (seen.has(name)) continue;
    const lineEnd = source.indexOf('\n', match.index);
    const raw = source.slice(match.index, lineEnd === -1 ? source.length : lineEnd).trim();
    const signature = raw.length > limits.signatureCodeUnits
      ? `${raw.slice(0, limits.signatureCodeUnits - 1)}…`
      : raw;
    if (!safeText(name, limits.nameCodeUnits, { empty: false })
      || !safeText(signature, limits.signatureCodeUnits, { empty: false })) {
      reject('official declaration contains unsafe member text', 'API_REFERENCE_SOURCE_INVALID');
    }
    members.push({ name, signature });
    seen.add(name);
    if (members.length > limits.membersPerEntry) {
      reject('member limit exceeded', 'API_REFERENCE_ENTRY_LIMIT');
    }
  }
  return members;
}

/** Deterministically project official declarations into one bounded model. */
export function projectOfficialReference(source, policy = API_REFERENCE_POLICY) {
  const limits = policy.limits;
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes < 1 || bytes > limits.sourceBytes) {
    reject('official typings source byte limit exceeded', 'API_REFERENCE_SOURCE_SIZE');
  }
  if (sha256(source) !== policy.sourceSha256) {
    reject('official typings digest does not match the reviewed source', 'API_REFERENCE_PROVENANCE');
  }
  const declaration = /^(?:export\s+)?(?:declare\s+)?(interface|type|class|enum)\s+([A-Za-z_$][\w$]*)\b/gm;
  const matches = [...source.matchAll(declaration)];
  if (!matches.length || matches.length > limits.entries) {
    reject('official declaration count is outside policy', 'API_REFERENCE_ENTRY_LIMIT');
  }
  const entries = [];
  const names = new Set();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const name = match[2];
    if (!safeText(name, limits.nameCodeUnits, { empty: false }) || names.has(name)) {
      reject('official declaration name is invalid or duplicated', 'API_REFERENCE_SOURCE_INVALID');
    }
    let start = match.index;
    const commentStart = source.lastIndexOf('/**', match.index);
    if (commentStart >= 0) {
      const commentEnd = source.indexOf('*/', commentStart);
      if (commentEnd >= 0 && commentEnd < match.index
        && source.slice(commentEnd + 2, match.index).trim() === '') start = commentStart;
    }
    let end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    if (index + 1 < matches.length) {
      const nextComment = source.lastIndexOf('/**', matches[index + 1].index);
      if (nextComment >= end - 16_384) {
        const nextCommentEnd = source.indexOf('*/', nextComment);
        if (nextCommentEnd >= 0 && nextCommentEnd < matches[index + 1].index
          && source.slice(nextCommentEnd + 2, matches[index + 1].index).trim() === '') end = nextComment;
      }
    }
    const declarationSource = source.slice(start, end).trim();
    if (Buffer.byteLength(declarationSource, 'utf8') > limits.entryBytes
      || !safeText(declarationSource, limits.entryBytes, { empty: false })) {
      reject(`official declaration ${name} exceeds its entry bound`, 'API_REFERENCE_ENTRY_SIZE');
    }
    const summary = sourceSummary(declarationSource, limits.summaryCodeUnits);
    const kind = match[1] === 'interface' ? 'interface' : 'type';
    entries.push({
      kind,
      declarationKind: match[1],
      name,
      summary,
      source: declarationSource,
      members: declarationMembers(declarationSource, limits),
    });
    names.add(name);
  }
  return {
    schemaVersion: API_REFERENCE_SCHEMA_VERSION,
    materialVersion: policy.materialVersion,
    provenance: {
      packageName: policy.packageName,
      packageVersion: policy.packageVersion,
      sourceSha256: policy.sourceSha256,
      sourceBytes: bytes,
    },
    entries,
  };
}

function validateModel(value, policy) {
  const limits = policy.limits;
  if (!exactKeys(value, ['schemaVersion', 'materialVersion', 'provenance', 'entries'])
    || value.schemaVersion !== API_REFERENCE_SCHEMA_VERSION
    || value.materialVersion !== policy.materialVersion
    || !exactKeys(value.provenance, ['packageName', 'packageVersion', 'sourceSha256', 'sourceBytes'])
    || value.provenance.packageName !== policy.packageName
    || value.provenance.packageVersion !== policy.packageVersion
    || value.provenance.sourceSha256 !== policy.sourceSha256
    || !Number.isInteger(value.provenance.sourceBytes)
    || value.provenance.sourceBytes < 1 || value.provenance.sourceBytes > limits.sourceBytes
    || !Array.isArray(value.entries) || value.entries.length < 1
    || value.entries.length > limits.entries) return false;
  const names = new Set();
  for (const entry of value.entries) {
    if (!exactKeys(entry, ['kind', 'declarationKind', 'name', 'summary', 'source', 'members'])
      || !['interface', 'type'].includes(entry.kind)
      || !['interface', 'type', 'class', 'enum'].includes(entry.declarationKind)
      || !safeText(entry.name, limits.nameCodeUnits, { empty: false })
      || !safeText(entry.summary, limits.summaryCodeUnits)
      || !safeText(entry.source, limits.entryBytes, { empty: false })
      || Buffer.byteLength(entry.source, 'utf8') > limits.entryBytes
      || !Array.isArray(entry.members) || entry.members.length > limits.membersPerEntry
      || names.has(entry.name)) return false;
    names.add(entry.name);
    for (const member of entry.members) {
      if (!exactKeys(member, ['name', 'signature'])
        || !safeText(member.name, limits.nameCodeUnits, { empty: false })
        || !safeText(member.signature, limits.signatureCodeUnits, { empty: false })) return false;
    }
  }
  return true;
}

/** Create one authority for an exact private API-reference namespace. */
export function createApiReferenceStore({ root = STATE_DIR, policy = API_REFERENCE_POLICY } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) reject('root must be absolute');
  const lexicalRoot = path.resolve(root);
  const referenceDir = path.join(lexicalRoot, 'api-reference');
  const materialFile = `official-${policy.packageVersion}-${policy.sourceSha256}.json`;
  const materialPath = path.join(referenceDir, materialFile);

  function exactDirectory(candidate, parent, { create = false } = {}) {
    if (create && !existsSync(candidate)) {
      try { mkdirSync(candidate, { recursive: candidate === lexicalRoot, mode: PRIVATE_DIRECTORY_MODE }); }
      catch (error) { if (error?.code !== 'EEXIST') reject('private directory could not be created'); }
    }
    let metadata;
    try { metadata = lstatSync(candidate); } catch (error) {
      if (!create && error?.code === 'ENOENT') return null;
      reject('private directory is unavailable');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) reject('private directory is not exact');
    const canonical = realpathSync.native(candidate);
    if (parent && canonical !== path.join(parent, path.basename(candidate))) {
      reject('private directory escaped its namespace');
    }
    if (create) chmodSync(candidate, PRIVATE_DIRECTORY_MODE);
    return canonical;
  }

  function ownedDirectory({ create = false } = {}) {
    const rootCanonical = exactDirectory(lexicalRoot, null, { create });
    if (!rootCanonical) return null;
    return exactDirectory(referenceDir, rootCanonical, { create });
  }

  function boundedEntries({ create = false } = {}) {
    const directory = ownedDirectory({ create });
    if (!directory) return { directory: null, entries: [] };
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > policy.limits.files) reject('private file limit exceeded', 'API_REFERENCE_FILE_LIMIT');
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()
        || (!MATERIAL_FILE.test(entry.name) && !TEMP_FILE.test(entry.name))) {
        reject('private reference directory contains an unexpected entry', 'API_REFERENCE_PATH_UNSAFE');
      }
    }
    return { directory, directoryStat: lstatSync(directory), entries };
  }

  function readModel() {
    const { directory, directoryStat } = boundedEntries();
    if (!directory || !existsSync(materialPath)) {
      reject('material is not installed; run figma_run ["api","setup"]', 'API_REFERENCE_NOT_INSTALLED');
    }
    let descriptor;
    try {
      const lexical = lstatSync(materialPath);
      if (!lexical.isFile() || lexical.isSymbolicLink()) reject('material path is unsafe', 'API_REFERENCE_PATH_UNSAFE');
      descriptor = openSync(materialPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = fstatSync(descriptor);
      const current = lstatSync(materialPath);
      const currentDirectory = lstatSync(directory);
      if (!opened.isFile() || !inodeMatches(opened, current)
        || !inodeMatches(currentDirectory, directoryStat)) reject('material changed while opening');
      if (opened.size < 1 || opened.size > policy.limits.storeBytes) {
        reject('stored material byte limit exceeded', 'API_REFERENCE_STORE_SIZE');
      }
      const source = readFileSync(descriptor, 'utf8');
      let value;
      try { value = JSON.parse(source); } catch { reject('stored material is invalid JSON'); }
      if (!validateModel(value, policy)) reject('stored material does not match the reviewed model');
      return value;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  function validateSource() {
    let packageRoot;
    let packageRootStat;
    try {
      const sourceRoot = lstatSync(policy.sourceDirectory);
      if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) reject('official package directory is unsafe');
      packageRoot = realpathSync.native(policy.sourceDirectory);
      packageRootStat = sourceRoot;
    } catch (error) {
      if (error instanceof ApiReferenceStoreError) throw error;
      reject('official typings dependency is unavailable; reinstall the package', 'API_REFERENCE_SOURCE_MISSING');
    }
    const readExact = (candidate, maximum) => {
      const lexical = lstatSync(candidate);
      if (!lexical.isFile() || lexical.isSymbolicLink()
        || realpathSync.native(candidate) !== path.join(packageRoot, path.basename(candidate))) {
        reject('official package file is unsafe', 'API_REFERENCE_SOURCE_INVALID');
      }
      let descriptor;
      try {
        descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = fstatSync(descriptor);
        const current = lstatSync(candidate);
        const currentRoot = lstatSync(policy.sourceDirectory);
        if (!opened.isFile() || !inodeMatches(opened, lexical) || !inodeMatches(current, lexical)
          || !inodeMatches(currentRoot, packageRootStat)
          || realpathSync.native(policy.sourceDirectory) !== packageRoot) {
          reject('official package changed while opening', 'API_REFERENCE_SOURCE_INVALID');
        }
        if (opened.size < 1 || opened.size > maximum) reject('official package file exceeds its byte bound');
        return readFileSync(descriptor, 'utf8');
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    };
    let manifest;
    try { manifest = JSON.parse(readExact(policy.packagePath, 64 * 1024)); }
    catch (error) {
      if (error instanceof ApiReferenceStoreError) throw error;
      reject('official package manifest is invalid', 'API_REFERENCE_PROVENANCE');
    }
    if (!exactKeys(manifest, Object.keys(manifest))
      || manifest.name !== policy.packageName || manifest.version !== policy.packageVersion) {
      reject('official package identity does not match the reviewed version', 'API_REFERENCE_PROVENANCE');
    }
    const source = readExact(policy.sourcePath, policy.limits.sourceBytes);
    if (sha256(source) !== policy.sourceSha256) {
      reject('official typings digest does not match the reviewed source', 'API_REFERENCE_PROVENANCE');
    }
    return source;
  }

  function install() {
    const source = validateSource();
    const model = projectOfficialReference(source, policy);
    let serialized;
    try { serialized = `${JSON.stringify(model)}\n`; } catch { reject('reference model is not serializable'); }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > policy.limits.storeBytes) reject('projected material exceeds its store byte bound');
    const { directory, directoryStat } = boundedEntries({ create: true });
    if (existsSync(materialPath)) {
      const existing = readModel();
      return Object.freeze({
        materialVersion: existing.materialVersion,
        entries: existing.entries.length,
        bytes: statSync(materialPath).size,
        reused: true,
      });
    }
    const temporary = path.join(directory, `.reference-${process.pid}-${randomUUID()}.tmp`);
    let descriptor;
    let ownsTemporary = false;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        PRIVATE_FILE_MODE,
      );
      ownsTemporary = true;
      fchmodSync(descriptor, PRIVATE_FILE_MODE);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      if (!inodeMatches(lstatSync(directory), directoryStat)) {
        reject('private directory changed during publication', 'API_REFERENCE_PATH_UNSAFE');
      }
      let published = false;
      try {
        linkSync(temporary, materialPath);
        published = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      unlinkSync(temporary);
      ownsTemporary = false;
      if (published) chmodSync(materialPath, PRIVATE_FILE_MODE);
      const installed = readModel();
      return Object.freeze({
        materialVersion: installed.materialVersion,
        entries: installed.entries.length,
        bytes: statSync(materialPath).size,
        reused: !published,
      });
    } catch (error) {
      if (error instanceof ApiReferenceStoreError) throw error;
      reject('atomic publication failed; the previous material remains available', 'API_REFERENCE_PUBLICATION');
    } finally {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
      if (ownsTemporary) try { unlinkSync(temporary); } catch {}
      else if (existsSync(temporary)) try { unlinkSync(temporary); } catch {}
    }
  }

  function ageInDays() {
    try { readModel(); } catch (error) {
      if (error?.code === 'API_REFERENCE_NOT_INSTALLED') return Infinity;
      throw error;
    }
    return (Date.now() - statSync(materialPath).mtimeMs) / (1000 * 60 * 60 * 24);
  }

  return Object.freeze({
    install,
    load: readModel,
    ageInDays,
    materialVersion: policy.materialVersion,
  });
}

export const apiReferenceStore = createApiReferenceStore();
