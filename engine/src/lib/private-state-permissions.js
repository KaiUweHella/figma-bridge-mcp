// Platform-specific privacy enforcement for exact Bridge-owned state trees.
//
// POSIX uses real 0700/0600 mode bits. Windows needs direct DACL evidence:
// Node exposes synthesized Unix bits there, so chmod alone cannot prove that a
// different local account is excluded. Callers must name one closed ownership
// kind; arbitrary workspace, profile and temporary roots are never accepted.
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIVATE_STATE_MAX_ENTRIES = 4096;
export const PRIVATE_STATE_WINDOWS_TIMEOUT_MS = 10_000;
const MAX_WINDOWS_OUTPUT_BYTES = 64 * 1024;
const VERIFICATION_DIRECTORY =
  /^figma-bridge-verify-[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u;
const WINDOWS_PRINCIPALS = Object.freeze([
  "administrators",
  "current-user",
  "local-system",
]);
const WINDOWS_SCRIPT = fileURLToPath(
  new URL("./windows-private-state-acl.ps1", import.meta.url)
);

export class PrivateStatePermissionError extends Error {
  constructor(reason = "privacy could not be enforced") {
    super(
      "Figma Bridge could not secure its private local state. " +
        "Restore access for the current account, remove unsafe links from Bridge-owned state, " +
        "and restart Figma Bridge."
    );
    this.name = "PrivateStatePermissionError";
    this.code = "PRIVATE_STATE_PERMISSIONS";
    this.kind = "private-state-policy";
    this.reason = reason;
  }
}

function reject(reason) {
  throw new PrivateStatePermissionError(reason);
}

function ownedRoot(root, kind) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root
  ) {
    reject("owned root is not an exact absolute path");
  }
  const name = path.basename(root);
  if (kind === "bridge-state" && name !== ".figma-bridge-mcp") {
    reject("state root is outside the Bridge namespace");
  }
  if (kind === "verification-artifact" && !VERIFICATION_DIRECTORY.test(name)) {
    reject("artifact root is outside the Bridge namespace");
  }
  if (!["bridge-state", "verification-artifact"].includes(kind)) {
    reject("ownership kind is unsupported");
  }
  return root;
}

/** True only when every configured artifact remains at or below one exact root. */
export function privateStateOwns(root, candidates) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    !Array.isArray(candidates)
  ) {
    return false;
  }
  const canonicalRoot = path.resolve(root);
  return candidates.filter(Boolean).every((candidate) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate))
      return false;
    const relative = path.relative(canonicalRoot, path.resolve(candidate));
    return (
      relative === "" ||
      (!path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`))
    );
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function collectPosixTree(root, { create, maxEntries }) {
  if (!existsSync(root)) {
    if (!create) return [];
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch {
      reject("owned root could not be created");
    }
  }
  let canonical;
  let rootMetadata;
  try {
    canonical = realpathSync.native(root);
    rootMetadata = lstatSync(root);
  } catch {
    reject("owned root is unavailable");
  }
  if (
    canonical !== root ||
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory()
  ) {
    reject("owned root identity is unsafe");
  }

  const entries = [{ path: root, metadata: rootMetadata, directory: true }];
  const pending = [root];
  while (pending.length) {
    const directoryPath = pending.pop();
    let directory;
    try {
      directory = opendirSync(directoryPath);
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        const entryPath = path.join(directoryPath, entry.name);
        const metadata = lstatSync(entryPath);
        if (
          metadata.isSymbolicLink() ||
          (!metadata.isDirectory() && !metadata.isFile())
        ) {
          reject("owned tree contains an unsafe entry");
        }
        entries.push({
          path: entryPath,
          metadata,
          directory: metadata.isDirectory(),
        });
        if (entries.length > maxEntries)
          reject("owned tree exceeds its entry limit");
        if (metadata.isDirectory()) pending.push(entryPath);
      }
    } catch (error) {
      if (error?.kind === "private-state-policy") throw error;
      reject("owned tree could not be inspected");
    } finally {
      try {
        directory?.closeSync();
      } catch {}
    }
  }
  return entries;
}

function openExactPosix(entry) {
  let descriptor;
  try {
    let flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
    if (entry.directory) flags |= constants.O_DIRECTORY || 0;
    descriptor = openSync(entry.path, flags);
    const opened = fstatSync(descriptor);
    if (
      !sameIdentity(opened, entry.metadata) ||
      (entry.directory ? !opened.isDirectory() : !opened.isFile())
    ) {
      reject("owned entry changed during permission enforcement");
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    if (error?.kind === "private-state-policy") throw error;
    reject("owned entry could not be opened safely");
  }
}

function chmodExactPosix(entry, descriptor, expected, platform) {
  if (platform !== "darwin" || !entry.directory) {
    fchmodSync(descriptor, expected);
    return;
  }

  // macOS may reject fchmod(2) on an owned directory carrying system-managed
  // provenance metadata even though chmod(2) on the same exact inode is
  // permitted. Keep the descriptor open and verify path identity immediately
  // before and after the path-based call. A same-user replacement is already
  // outside the local attacker boundary; another account cannot replace an
  // entry below the now-private owning profile/tree.
  const before = lstatSync(entry.path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameIdentity(before, entry.metadata)
  ) {
    reject("owned entry changed during permission enforcement");
  }
  chmodSync(entry.path, expected);
  const after = lstatSync(entry.path);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameIdentity(after, entry.metadata)
  ) {
    reject("owned entry changed during permission enforcement");
  }
}

function posixPermissions(root, { create, maxEntries, platform, repair }) {
  const entries = collectPosixTree(root, { create, maxEntries });
  if (!entries.length) {
    return Object.freeze({
      version: 1,
      private: true,
      platform: "posix",
      count: 0,
      rootProtected: false,
      principals: Object.freeze(["owner"]),
      violations: Object.freeze([]),
    });
  }
  for (const entry of entries) {
    const descriptor = openExactPosix(entry);
    try {
      const expected = entry.directory ? 0o700 : 0o600;
      if (repair) chmodExactPosix(entry, descriptor, expected, platform);
      const current = fstatSync(descriptor);
      if ((current.mode & 0o777) !== expected)
        reject("POSIX mode verification failed");
    } catch (error) {
      if (error?.kind === "private-state-policy") throw error;
      reject("POSIX permissions could not be enforced");
    } finally {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
  return Object.freeze({
    version: 1,
    private: true,
    platform: "posix",
    count: entries.length,
    rootProtected: true,
    principals: Object.freeze(["owner"]),
    violations: Object.freeze([]),
  });
}

function parseWindowsReport(stdout, maxEntries) {
  let report;
  try {
    report = JSON.parse(String(stdout || "").trim());
  } catch {
    reject("Windows ACL verifier returned malformed evidence");
  }
  if (
    !report ||
    report.version !== 1 ||
    report.private !== true ||
    !Number.isSafeInteger(report.count) ||
    report.count < 1 ||
    report.count > maxEntries ||
    report.rootProtected !== true ||
    !Array.isArray(report.principals) ||
    report.principals.length !== WINDOWS_PRINCIPALS.length ||
    !report.principals.every(
      (value, index) => value === WINDOWS_PRINCIPALS[index]
    ) ||
    !Array.isArray(report.violations) ||
    report.violations.length !== 0
  ) {
    reject("Windows ACL verifier returned invalid evidence");
  }
  return Object.freeze({
    version: 1,
    private: true,
    platform: "win32",
    count: report.count,
    rootProtected: true,
    principals: WINDOWS_PRINCIPALS,
    violations: Object.freeze([]),
  });
}

function windowsPermissions(
  root,
  { maxEntries, repair, runWindowsAcl, timeoutMs }
) {
  const argv = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    WINDOWS_SCRIPT,
    "-Mode",
    repair ? "repair" : "verify",
    "-Path",
    root,
    "-MaxEntries",
    String(maxEntries),
  ];
  let outcome;
  try {
    outcome = runWindowsAcl("powershell.exe", argv, {
      encoding: "utf8",
      maxBuffer: MAX_WINDOWS_OUTPUT_BYTES,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    reject("Windows ACL verifier could not start");
  }
  if (!outcome || outcome.error || outcome.signal || outcome.status !== 0) {
    reject("Windows ACL enforcement failed");
  }
  return parseWindowsReport(outcome.stdout, maxEntries);
}

function permissions(
  root,
  { kind, create, maxEntries, platform, repair, runWindowsAcl, timeoutMs }
) {
  const exactRoot = ownedRoot(root, kind);
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > PRIVATE_STATE_MAX_ENTRIES
  ) {
    reject("entry limit is invalid");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > PRIVATE_STATE_WINDOWS_TIMEOUT_MS
  ) {
    reject("Windows verifier timeout is invalid");
  }
  if (platform === "win32") {
    if (!existsSync(exactRoot)) {
      if (!create) {
        return Object.freeze({
          version: 1,
          private: true,
          platform: "win32",
          count: 0,
          rootProtected: false,
          principals: WINDOWS_PRINCIPALS,
          violations: Object.freeze([]),
        });
      }
      try {
        mkdirSync(exactRoot, { mode: 0o700 });
      } catch {
        reject("owned root could not be created");
      }
    }
    return windowsPermissions(exactRoot, {
      maxEntries,
      repair,
      runWindowsAcl,
      timeoutMs,
    });
  }
  if (platform !== "linux" && platform !== "darwin") {
    reject("platform is unsupported");
  }
  return posixPermissions(exactRoot, { create, maxEntries, platform, repair });
}

/** Repair and then verify one exact Bridge-owned private tree. */
export function hardenPrivateTree(
  root,
  {
    kind = "bridge-state",
    create = false,
    maxEntries = PRIVATE_STATE_MAX_ENTRIES,
    platform = process.platform,
    runWindowsAcl = spawnSync,
    timeoutMs = PRIVATE_STATE_WINDOWS_TIMEOUT_MS,
  } = {}
) {
  return permissions(root, {
    kind,
    create,
    maxEntries,
    platform,
    repair: true,
    runWindowsAcl,
    timeoutMs,
  });
}

/** Verify without changing one exact Bridge-owned private tree. */
export function verifyPrivateTree(
  root,
  {
    kind = "bridge-state",
    maxEntries = PRIVATE_STATE_MAX_ENTRIES,
    platform = process.platform,
    runWindowsAcl = spawnSync,
    timeoutMs = PRIVATE_STATE_WINDOWS_TIMEOUT_MS,
  } = {}
) {
  return permissions(root, {
    kind,
    create: false,
    maxEntries,
    platform,
    repair: false,
    runWindowsAcl,
    timeoutMs,
  });
}
