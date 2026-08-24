import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_ARTIFACT_FILES = 4096;
const MAX_ARTIFACT_PATH_LENGTH = 512;
const POLICY_KEYS = Object.freeze(["executables", "files", "version"]);

function fail(message) {
  throw new Error(`Package artifact policy failed: ${message}`);
}

function artifactPath(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ARTIFACT_PATH_LENGTH ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    fail(`${field} contains an invalid package-relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${field} contains a non-canonical package-relative path`);
  }
  return value;
}

function uniquePaths(values, field) {
  if (!Array.isArray(values) || values.length > MAX_ARTIFACT_FILES) {
    fail(
      `${field} must be an array with at most ${MAX_ARTIFACT_FILES} entries`
    );
  }
  const paths = values.map((value) => artifactPath(value, field));
  if (new Set(paths).size !== paths.length)
    fail(`${field} contains duplicate paths`);
  return Object.freeze(paths);
}

export function validatePackageArtifactPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("must be an object");
  }
  const keys = Object.keys(policy).sort();
  if (
    keys.length !== POLICY_KEYS.length ||
    keys.some((key, index) => key !== POLICY_KEYS[index])
  ) {
    fail(`must use only the closed fields ${POLICY_KEYS.join(", ")}`);
  }
  if (policy.version !== 1) fail("must use supported schema version 1");
  const files = uniquePaths(policy.files, "files");
  if (files.length === 0) fail("files must not be empty");
  const executables = uniquePaths(policy.executables, "executables");
  const allowed = new Set(files);
  if (executables.some((path) => !allowed.has(path))) {
    fail("every executable must also be present in files");
  }
  return Object.freeze({ version: 1, files, executables });
}

export function readPackageArtifactPolicy({ root, policy = null } = {}) {
  if (policy !== null) return validatePackageArtifactPolicy(policy);
  if (!root) fail("a repository root is required");
  let parsed;
  try {
    parsed = JSON.parse(
      readFileSync(
        join(root, "release", "package-artifact-policy.json"),
        "utf8"
      )
    );
  } catch {
    fail("could not read release/package-artifact-policy.json");
  }
  return validatePackageArtifactPolicy(parsed);
}

export function packageArtifactSourceEntries({ root, policy = null } = {}) {
  if (!root) fail("a repository root is required");
  const repositoryRoot = resolve(root);
  const canonical = readPackageArtifactPolicy({ root: repositoryRoot, policy });
  return canonical.files.map((path) => {
    const sourcePath = resolve(repositoryRoot, path);
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch {
      fail(`${path} is missing from the source tree`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`${path} must be a regular source file`);
    }
    try {
      return Object.freeze({
        path,
        content: readFileSync(sourcePath),
        revision: "package artifact",
      });
    } catch {
      fail(`${path} could not be read from the source tree`);
    }
  });
}
