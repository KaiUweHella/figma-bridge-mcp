// Plan-owned persistence for verification PNGs.
//
// A Command Plan names every exact artifact path before Figma readiness. This
// Module is the only persistence Interface used by screenshot and Render
// verification: workspace files stay behind WorkspaceIO, while private
// temporary artifacts receive a command-owned 0700 directory and 0600 files.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hardenPrivateTree } from '../lib/private-state-permissions.js';

export const VERIFICATION_ARTIFACT_ROLE = 'verification-image-output';
export const MAX_VERIFICATION_ARTIFACTS = 100;
export const MAX_VERIFICATION_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_VERIFICATION_BASE64_CODE_UNITS = 16 * 1024 * 1024;
export const MAX_VERIFICATION_PNG_DIMENSION = 16_384;
export const MAX_VERIFICATION_PNG_PIXELS = 64_000_000;
const PRIVATE_DIRECTORY_PREFIX = 'figma-bridge-verify-';
const SAFE_NONCE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function artifactError(reason, code = 'VERIFICATION_ARTIFACT_REJECTED') {
  const error = /** @type {Error & {code:string, kind:string}} */ (
    new Error(`Verification artifact rejected: ${reason}.`)
  );
  error.name = 'VerificationArtifactError';
  error.code = code;
  error.kind = 'artifact-policy';
  return error;
}

/** Parse only the bounded PNG signature and mandatory IHDR dimensions. */
export function inspectVerificationPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24
    || bytes.length > MAX_VERIFICATION_ARTIFACT_BYTES) {
    throw artifactError(`PNG payload must be between 24 and ${MAX_VERIFICATION_ARTIFACT_BYTES} bytes`, 'VERIFICATION_ARTIFACT_BYTE_LIMIT');
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw artifactError('invalid PNG signature');
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw artifactError('PNG does not begin with the mandatory IHDR chunk');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1
    || width > MAX_VERIFICATION_PNG_DIMENSION
    || height > MAX_VERIFICATION_PNG_DIMENSION
    || width * height > MAX_VERIFICATION_PNG_PIXELS) {
    throw artifactError('PNG dimensions exceed the verification evidence limit', 'VERIFICATION_ARTIFACT_DIMENSION_LIMIT');
  }
  return Object.freeze({ width, height });
}

/** Strictly decode one bounded canonical Base64 PNG and inspect its IHDR. */
export function decodeVerificationPngBase64(value) {
  if (typeof value !== 'string' || !value
    || value.length > MAX_VERIFICATION_BASE64_CODE_UNITS
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw artifactError('invalid bounded Base64 PNG');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw artifactError('non-canonical Base64 PNG');
  const dimensions = inspectVerificationPng(bytes);
  return Object.freeze({ bytes, ...dimensions });
}

function countValue(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERIFICATION_ARTIFACTS) {
    throw artifactError(`count must be between 1 and ${MAX_VERIFICATION_ARTIFACTS}`);
  }
  return value;
}

function privateDirectory(tempRoot, nonce) {
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) {
    throw artifactError('temporary root must be absolute');
  }
  if (typeof nonce !== 'string' || !SAFE_NONCE.test(nonce)) {
    throw artifactError('temporary nonce is invalid');
  }
  return path.join(tempRoot, `${PRIVATE_DIRECTORY_PREFIX}${nonce}`);
}

function privateOutput(directory, index, count, tempRoot) {
  const filename = count === 1 ? 'capture.png' : `root-${String(index + 1).padStart(3, '0')}.png`;
  return Object.freeze({
    role: VERIFICATION_ARTIFACT_ROLE,
    path: path.join(directory, filename),
    scope: 'private-temporary',
    temporaryRoot: tempRoot,
    cleanup: 'retained-for-caller',
  });
}

/** Plan exact output paths without creating them. */
export function planVerificationArtifacts({
  count = 1,
  explicitPath = null,
  temporaryRoot = tmpdir(),
  nonce = randomUUID(),
  plannedDirectory = null,
} = {}) {
  const total = countValue(count);
  if (explicitPath !== null) {
    if (total !== 1) throw artifactError('an explicit file path supports exactly one artifact');
    if (typeof explicitPath !== 'string' || !path.isAbsolute(explicitPath)) {
      throw artifactError('workspace output path must be absolute');
    }
    return Object.freeze([Object.freeze({
      role: VERIFICATION_ARTIFACT_ROLE,
      path: explicitPath,
      scope: 'workspace',
      cleanup: 'caller-owned',
    })]);
  }

  let root;
  try { root = realpathSync.native(path.resolve(temporaryRoot)); }
  catch { throw artifactError('temporary root is unavailable'); }
  const directory = plannedDirectory === null
    ? privateDirectory(root, nonce)
    : path.resolve(plannedDirectory);
  const relative = path.relative(root, directory);
  if (!relative || relative.includes(path.sep) || path.isAbsolute(relative)
    || !relative.startsWith(PRIVATE_DIRECTORY_PREFIX)
    || !SAFE_NONCE.test(relative.slice(PRIVATE_DIRECTORY_PREFIX.length))) {
    throw artifactError('planned temporary directory is outside the private artifact namespace');
  }
  return Object.freeze(Array.from({ length: total }, (_, index) =>
    privateOutput(directory, index, total, root)));
}

export function verificationArtifactDirectory(outputs) {
  const temporary = (outputs || []).filter((output) => output?.scope === 'private-temporary');
  if (!temporary.length) return null;
  const directories = new Set(temporary.map((output) => path.dirname(output.path)));
  if (directories.size !== 1) throw artifactError('temporary outputs do not share one directory');
  return [...directories][0];
}

function inodeMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateOutputs(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > MAX_VERIFICATION_ARTIFACTS) {
    throw artifactError('the owning Command Plan has no bounded verification outputs');
  }
  for (const output of outputs) {
    if (!output || output.role !== VERIFICATION_ARTIFACT_ROLE || typeof output.path !== 'string'
      || !path.isAbsolute(output.path) || !['workspace', 'private-temporary'].includes(output.scope)) {
      throw artifactError('the owning Command Plan contains an invalid verification output');
    }
  }
  const scopes = new Set(outputs.map((output) => output.scope));
  if (scopes.size !== 1) throw artifactError('one artifact set cannot mix workspace and temporary scopes');
  if (scopes.has('private-temporary')) {
    const directory = verificationArtifactDirectory(outputs);
    for (let index = 0; index < outputs.length; index++) {
      const output = outputs[index];
      if (typeof output.temporaryRoot !== 'string' || !path.isAbsolute(output.temporaryRoot)
        || path.dirname(output.path) !== directory) {
        throw artifactError('temporary artifact authority is incomplete');
      }
      const relativeDirectory = path.relative(output.temporaryRoot, directory);
      if (!relativeDirectory || relativeDirectory.includes(path.sep) || path.isAbsolute(relativeDirectory)
        || !relativeDirectory.startsWith(PRIVATE_DIRECTORY_PREFIX)
        || !SAFE_NONCE.test(relativeDirectory.slice(PRIVATE_DIRECTORY_PREFIX.length))) {
        throw artifactError('temporary artifact directory is outside its private namespace');
      }
      const expectedName = outputs.length === 1
        ? 'capture.png'
        : `root-${String(index + 1).padStart(3, '0')}.png`;
      if (path.basename(output.path) !== expectedName) {
        throw artifactError('temporary artifact filename is outside the planned sequence');
      }
    }
  }
  return outputs;
}

/**
 * Create the one persistence Adapter for the Plan's exact artifacts.
 * @param {readonly object[]} outputs
 * @param {{workspaceIO?: object}} adapters
 */
export function createVerificationArtifactWriter(outputs, { workspaceIO = null } = {}) {
  const planned = validateOutputs(outputs);
  const created = new Set();
  let privateParent = null;
  let privateParentStat = null;

  function ensurePrivateParent(output) {
    const parent = path.dirname(output.path);
    if (privateParent) {
      if (parent !== privateParent) throw artifactError('temporary outputs changed directory');
      const current = lstatSync(parent);
      if (!inodeMatches(current, privateParentStat) || !current.isDirectory() || current.isSymbolicLink()) {
        throw artifactError('private temporary directory changed after allocation');
      }
      return;
    }
    const root = realpathSync.native(output.temporaryRoot);
    const expected = path.join(root, path.basename(parent));
    if (parent !== expected) throw artifactError('private temporary parent is outside its root');
    try {
      mkdirSync(parent, { mode: 0o700 });
    } catch (error) {
      throw artifactError(error?.code === 'EEXIST'
        ? 'private temporary directory already exists'
        : 'private temporary directory could not be created');
    }
    const canonical = realpathSync.native(parent);
    const metadata = lstatSync(canonical);
    if (canonical !== parent || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw artifactError('private temporary directory did not retain its exact identity');
    }
    hardenPrivateTree(parent, {
      kind: 'verification-artifact',
      create: false,
    });
    privateParent = parent;
    privateParentStat = lstatSync(parent);
  }

  async function write(index, bytes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= planned.length) {
      throw artifactError('artifact index is outside the owning Command Plan');
    }
    inspectVerificationPng(bytes);
    const output = planned[index];
    if (created.has(output.path)) throw artifactError('artifact was already persisted');
    if (output.scope === 'workspace') {
      if (!workspaceIO || typeof workspaceIO.write !== 'function') {
        throw new TypeError('Workspace verification output requires WorkspaceIO.');
      }
      await workspaceIO.write(output.path, bytes, {
        role: VERIFICATION_ARTIFACT_ROLE,
        createParents: true,
      });
      created.add(output.path);
      return output.path;
    }

    ensurePrivateParent(output);
    let fd;
    let opened = null;
    let ownsLeaf = false;
    const unlinkOwnedLeaf = () => {
      if (!ownsLeaf || !opened) return;
      try {
        const currentParent = lstatSync(privateParent);
        const currentLeaf = lstatSync(output.path);
        if (inodeMatches(currentParent, privateParentStat) && inodeMatches(currentLeaf, opened)
          && !currentLeaf.isSymbolicLink()) {
          unlinkSync(output.path);
        }
      } catch {}
    };
    try {
      fd = openSync(output.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
        0o600);
      opened = fstatSync(fd);
      if (!opened.isFile()) throw artifactError('temporary output is not a regular file');
      const canonicalLeaf = realpathSync.native(output.path);
      const currentParent = lstatSync(privateParent);
      const currentLeaf = lstatSync(canonicalLeaf);
      ownsLeaf = canonicalLeaf === output.path
        && inodeMatches(currentLeaf, opened)
        && !currentLeaf.isSymbolicLink();
      if (canonicalLeaf !== output.path
        || !inodeMatches(currentParent, privateParentStat)
        || !ownsLeaf) {
        throw artifactError('temporary output changed while it was opened');
      }
      writeFileSync(fd, bytes);
      closeSync(fd);
      fd = undefined;
      hardenPrivateTree(privateParent, {
        kind: 'verification-artifact',
        create: false,
      });
      created.add(output.path);
      return output.path;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
        fd = undefined;
      }
      unlinkOwnedLeaf();
      if (privateParent && created.size === 0) {
        try {
          const currentParent = lstatSync(privateParent);
          if (inodeMatches(currentParent, privateParentStat)) rmdirSync(privateParent);
        } catch {}
        privateParent = null;
        privateParentStat = null;
      }
      if (error?.kind === 'artifact-policy') throw error;
      throw artifactError('temporary PNG could not be persisted');
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  return Object.freeze({ outputs: planned, write });
}
