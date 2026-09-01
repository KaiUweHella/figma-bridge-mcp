// Process-safe serialization for one Asset Export output directory.
//
// A fixed, empty-parent lock directory is acquired atomically with mkdir.
// Owner metadata lets a later process recover a lock whose process died. The
// lock covers read-prior -> plan -> publish, so separate CLI and MCP processes
// cannot overwrite each other's manifest merge.
import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export const ASSET_OUTPUT_LOCK_DIRECTORY = '.figma-bridge-assets.lock';
const OWNER_FILE = 'owner.json';
const RECOVERY_CLAIM_PREFIX = '.figma-bridge-recovery-';
const OWNER_CREATION_GRACE_MS = 5000;
const MAX_OWNER_BYTES = 4096;
const MAX_RECOVERY_CLAIMS = 16;
const RECOVERY_CLAIM_NAME = /^\.figma-bridge-recovery-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(rel));
}

function timeoutError() {
  return Object.assign(new Error('Asset Export timed out while waiting for its output directory.'), {
    kind: 'timeout',
  });
}

function workspacePolicyError(message, cause) {
  return Object.assign(new Error(message), {
    kind: 'workspace-policy',
    ...(cause === undefined ? {} : { cause }),
  });
}

function exactChild(parent, candidate, basename) {
  return relative(parent, candidate) === basename;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOwner(io, ownerPath) {
  return JSON.parse(io.readText(ownerPath, {
    role: 'asset-export-lock-owner',
    maxBytes: MAX_OWNER_BYTES,
  }));
}

function lockFacts(io, canonicalOut, lockDir, ownerPath, now) {
  const metadata = lstatSync(lockDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw workspacePolicyError('Asset Export output lock is not a safe directory.');
  }
  const canonicalLock = realpathSync.native(lockDir);
  if (!contained(canonicalOut, canonicalLock)) {
    throw workspacePolicyError('Asset Export output lock resolves outside its output directory.');
  }
  let ownerMetadata;
  try {
    ownerMetadata = lstatSync(ownerPath);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.size > MAX_OWNER_BYTES) {
      throw new Error('unsafe owner metadata');
    }
    const owner = readOwner(io, ownerPath);
    if (!owner || typeof owner !== 'object'
      || typeof owner.token !== 'string' || owner.token.length < 1
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || !Number.isFinite(owner.startedAt)) {
      throw new Error('invalid owner metadata');
    }
    return { recoverable: !processAlive(owner.pid), owner };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { recoverable: now() - metadata.mtimeMs >= OWNER_CREATION_GRACE_MS, owner: null };
    }
    const creationMtime = Math.max(metadata.mtimeMs, ownerMetadata?.mtimeMs ?? 0);
    if (ownerMetadata?.isFile() && !ownerMetadata.isSymbolicLink()
      && ownerMetadata.size <= MAX_OWNER_BYTES
      && now() - creationMtime < OWNER_CREATION_GRACE_MS) {
      return { recoverable: false, owner: null };
    }
    throw workspacePolicyError('Asset Export output lock owner metadata is invalid.', error);
  }
}

function removeLockDirectory(lockDir) {
  try {
    rmdirSync(lockDir);
    return true;
  } catch (error) {
    // Another waiter may already have removed the stale directory, or a new
    // owner may have populated it between recovery syscalls. Both mean the
    // fixed lock name must be inspected/acquired again rather than failing or
    // removing the new owner's non-empty directory.
    if (error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false;
    throw error;
  }
}

function cleanupOrphanRecoveryClaims(lockDir) {
  let directory;
  try { directory = opendirSync(lockDir, { bufferSize: 1 }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const claims = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isFile() || !RECOVERY_CLAIM_NAME.test(entry.name)) {
        throw workspacePolicyError(
          'Asset Export output lock contains an unexpected recovery entry.',
        );
      }
      claims.push(entry.name);
      if (claims.length > MAX_RECOVERY_CLAIMS) {
        throw workspacePolicyError(
          'Asset Export output lock contains too many recovery claims.',
        );
      }
    }
  } finally {
    directory.closeSync();
  }
  for (const claim of claims) {
    try { unlinkSync(join(lockDir, claim)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

/**
 * Claim the exact inspected owner inode before removing it. The hard link
 * keeps the directory non-empty while concurrent recoverers finish. A delayed
 * recoverer that reaches a newly acquired lock links the new owner, observes
 * the token mismatch and leaves it untouched.
 */
function recoverInspectedLock(io, lockDir, ownerPath, inspectedOwner) {
  if (!inspectedOwner) {
    cleanupOrphanRecoveryClaims(lockDir);
    return removeLockDirectory(lockDir);
  }
  const claimPath = join(lockDir, `${RECOVERY_CLAIM_PREFIX}${randomUUID()}.json`);
  try {
    linkSync(ownerPath, claimPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  let matches = false;
  try {
    const claimedOwner = readOwner(io, claimPath);
    matches = claimedOwner.token === inspectedOwner.token
      && claimedOwner.pid === inspectedOwner.pid
      && claimedOwner.startedAt === inspectedOwner.startedAt;
    if (!matches) return false;
    try { unlinkSync(ownerPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  } finally {
    try { unlinkSync(claimPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return matches ? removeLockDirectory(lockDir) : false;
}

function releaseOwnedLock(lockDir, ownerPath) {
  try { unlinkSync(ownerPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return removeLockDirectory(lockDir);
}

/**
 * Execute one publication transaction while holding the output lock.
 * The output directory is first canonicalized by the supplied WorkspaceIO.
 * @param {string} outputDir
 * @param {{io?: {ensureDirectory:(path:string, options?:object)=>string, readText:(path:string, options?:object)=>string, write:(path:string, data:string, options?:object)=>string}, lockDirectory?:string, remainingMs?:()=>number, now?:()=>number, wait?:(delay:number)=>Promise<void>, testHooks?:{beforeRecover?:(owner:object|null)=>Promise<void>|void}}} options
 * @param {()=>Promise<any>} operation
 */
export async function withAssetOutputLock(outputDir, {
  io,
  lockDirectory = ASSET_OUTPUT_LOCK_DIRECTORY,
  remainingMs = () => Number.POSITIVE_INFINITY,
  now = () => Date.now(),
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  testHooks = {},
} = {}, operation) {
  if (!io || typeof io.ensureDirectory !== 'function'
    || typeof io.readText !== 'function' || typeof io.write !== 'function') {
    throw new TypeError('Asset output lock requires WorkspaceIO.');
  }
  if (typeof operation !== 'function') throw new TypeError('Asset output lock requires an operation.');
  if (typeof lockDirectory !== 'string' || lockDirectory.length > 128
    || !/^\.[a-z0-9][a-z0-9.-]*\.lock$/u.test(lockDirectory)) {
    throw new TypeError('Asset output lock requires one safe sibling lock-directory name.');
  }
  const canonicalOut = io.ensureDirectory(outputDir, { role: 'asset-export-directory' });
  const lockDir = join(canonicalOut, lockDirectory);
  const ownerPath = join(lockDir, OWNER_FILE);
  const token = randomUUID();

  for (;;) {
    if (Number(remainingMs()) <= 0) throw timeoutError();
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        // mkdir is the atomic ownership decision, but its parent can change
        // before owner metadata is written. Re-enter WorkspaceIO after mkdir,
        // then let WorkspaceIO safely open the owner leaf as well.
        const canonicalLock = io.ensureDirectory(lockDir, { role: 'asset-export-lock-directory' });
        if (!exactChild(canonicalOut, canonicalLock, lockDirectory)) {
          throw workspacePolicyError('Asset Export output lock changed during acquisition.');
        }
        const canonicalOwner = io.write(
          join(canonicalLock, OWNER_FILE),
          `${JSON.stringify({ token, pid: process.pid, startedAt: now() })}\n`,
          {
            role: 'asset-export-lock-owner',
            mode: 0o600,
            exclusive: true,
          },
        );
        if (!exactChild(canonicalLock, canonicalOwner, OWNER_FILE)) {
          throw workspacePolicyError('Asset Export output lock owner changed during acquisition.');
        }
      } catch (error) {
        try { rmdirSync(lockDir); } catch {}
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let facts;
      try {
        facts = lockFacts(io, canonicalOut, lockDir, ownerPath, now);
      } catch (inspectionError) {
        if (inspectionError?.code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (facts.recoverable) {
        await testHooks.beforeRecover?.(facts.owner);
        recoverInspectedLock(io, lockDir, ownerPath, facts.owner);
        continue;
      }
      await wait(Math.max(1, Math.min(100, Number(remainingMs()))));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const owner = readOwner(io, ownerPath);
      if (owner.token === token) releaseOwnedLock(lockDir, ownerPath);
    } catch {}
  }
}
