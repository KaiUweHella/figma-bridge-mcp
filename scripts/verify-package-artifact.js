#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { readPackageArtifactPolicy } from "./lib/package-artifact-policy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = join(ROOT, "release", "package-artifact-policy.json");
const PACKAGE_PATH = join(ROOT, "package.json");

function digest(algorithm, value, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function sameSortedValues(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function difference(left, right) {
  const allowed = new Set(right);
  return [...left].filter((value) => !allowed.has(value)).sort();
}

function readTarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readTarOctal(block, offset, length, label) {
  const raw = readTarString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`npm tarball has an invalid ${label} field`);
  }
  return Number.parseInt(raw, 8);
}

function tarHeaderChecksum(block) {
  let checksum = 0;
  for (let index = 0; index < block.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return checksum;
}

function writeTarOctal(block, offset, length, value) {
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error("npm tarball field exceeds the portable octal range");
  }
  block.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function writeTarChecksum(block) {
  block.fill(0x20, 148, 156);
  const checksum = tarHeaderChecksum(block);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function assertPortablePackagePath(path) {
  if (
    !path.startsWith("package/") ||
    path.includes("\\") ||
    path
      .slice("package/".length)
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`npm tarball has an unsafe package path: ${path}`);
  }
}

export function canonicalizePackageTarball(tarball, { executables = [] } = {}) {
  const archive = gunzipSync(tarball, { maxOutputLength: 128 * 1024 * 1024 });
  if (archive.length % 512 !== 0) {
    throw new Error("npm tarball payload is not block-aligned");
  }

  const approvedExecutables = new Set(executables);
  const seenPaths = new Set();
  const seenExecutables = new Set();
  const rawFiles = [];
  const files = [];
  let offset = 0;
  let terminated = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      terminated = true;
      break;
    }

    const storedChecksum = readTarOctal(header, 148, 8, "checksum");
    if (storedChecksum !== tarHeaderChecksum(header)) {
      throw new Error("npm tarball has an invalid header checksum");
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertPortablePackagePath(path);
    const relativePath = path.slice("package/".length);
    if (seenPaths.has(relativePath)) {
      throw new Error(`npm tarball has a duplicate path: ${relativePath}`);
    }
    seenPaths.add(relativePath);

    const type = readTarString(header, 156, 1) || "0";
    if (type !== "0") {
      throw new Error(
        `npm tarball entry is not a regular file: ${relativePath}`
      );
    }

    const size = readTarOctal(header, 124, 12, "size");
    const mode = readTarOctal(header, 100, 8, "mode") & 0o7777;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + 512 + paddedSize > archive.length) {
      throw new Error(`npm tarball entry exceeds the archive: ${relativePath}`);
    }

    rawFiles.push({ path: relativePath, size, mode });
    if ((mode & 0o022) !== 0) {
      throw new Error(
        `group/world-writable file in npm tarball: ${relativePath}`
      );
    }
    if ((mode & 0o111) !== 0 && !approvedExecutables.has(relativePath)) {
      throw new Error(`unreviewed executable in npm tarball: ${relativePath}`);
    }

    const canonicalMode = approvedExecutables.has(relativePath) ? 0o755 : 0o644;
    if (approvedExecutables.has(relativePath))
      seenExecutables.add(relativePath);
    writeTarOctal(header, 100, 8, canonicalMode);
    writeTarChecksum(header);
    files.push({ path: relativePath, size, mode: canonicalMode });
    offset += 512 + paddedSize;
  }

  if (!terminated || !isZeroBlock(archive.subarray(offset))) {
    throw new Error("npm tarball has invalid trailing data");
  }
  const missingExecutables = difference(executables, seenExecutables);
  if (missingExecutables.length) {
    throw new Error(
      `declared executable is missing from npm tarball: ${missingExecutables.join(", ")}`
    );
  }

  const canonicalTarball = gzipSync(archive, { level: 9 });
  // zlib writes a host-specific gzip OS byte (for example macOS=19 and
  // Windows=0). It is not covered by the payload checksum, so normalize it to
  // "unknown" and keep identical package bytes across operating systems.
  canonicalTarball[9] = 0xff;
  return { tarball: canonicalTarball, rawFiles, files };
}

function canonicalInventory(files) {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, size, mode }) => `${path}\0${size}\0${mode}\n`)
    .join("");
}

export function verifyPackageMetadata(
  metadata,
  {
    root = ROOT,
    packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")),
    policy = null,
  } = {}
) {
  const canonicalPolicy = readPackageArtifactPolicy({ root, policy });
  const failures = [];
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const paths = files.map((entry) => entry.path);
  const duplicates = paths.filter(
    (path, index) => paths.indexOf(path) !== index
  );

  if (
    metadata?.name !== packageJson.name ||
    metadata?.version !== packageJson.version
  ) {
    failures.push(
      `package identity is ${metadata?.name || "missing"}@${metadata?.version || "missing"}; ` +
        `expected ${packageJson.name}@${packageJson.version}`
    );
  }
  if (duplicates.length)
    failures.push(
      `duplicate tar entries: ${[...new Set(duplicates)].join(", ")}`
    );

  const unexpected = difference(paths, canonicalPolicy.files);
  const missing = difference(canonicalPolicy.files, paths);
  const allowedPaths = new Set(canonicalPolicy.files);
  if (unexpected.length)
    failures.push(`unexpected packed files: ${unexpected.join(", ")}`);
  if (missing.length)
    failures.push(`missing packed files: ${missing.join(", ")}`);

  const executables = files
    .filter((entry) => (Number(entry.mode) & 0o111) !== 0)
    .map((entry) => entry.path)
    .sort();
  if (!sameSortedValues(executables, canonicalPolicy.executables)) {
    failures.push(
      `executable file set is [${executables.join(", ")}]; expected ` +
        `[${canonicalPolicy.executables.join(", ")}]`
    );
  }

  for (const entry of files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !Number.isInteger(entry.size) ||
      !Number.isInteger(entry.mode)
    ) {
      failures.push("npm pack returned an invalid file inventory entry");
      continue;
    }
    if ((entry.mode & 0o022) !== 0)
      failures.push(`${entry.path} is group/world-writable in the tarball`);
    // An unexpected tar entry is already a terminal policy failure. Never
    // resolve it against the host filesystem: only canonical policy paths may
    // cross the source-tree read boundary.
    if (!allowedPaths.has(entry.path)) continue;
    try {
      const source = lstatSync(join(root, entry.path));
      if (source.isSymbolicLink())
        failures.push(
          `${entry.path} is a symbolic link; release artifacts must contain regular files`
        );
      else if (!source.isFile())
        failures.push(`${entry.path} is not a regular source file`);
    } catch (error) {
      failures.push(
        `${entry.path} cannot be verified in the source tree: ${error.message}`
      );
    }
  }

  if (failures.length) {
    throw new Error(
      `Package artifact policy failed:\n- ${failures.join("\n- ")}`
    );
  }

  const sortedFiles = [...files]
    .map(({ path, size, mode }) => ({ path, size, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    count: sortedFiles.length,
    sha256: digest("sha256", canonicalInventory(sortedFiles)),
    executables,
    files: sortedFiles,
  };
}

export function npmPackInvocation({
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  execPath = process.execPath,
} = {}) {
  if (platform !== "win32") return { command: "npm", args: [] };
  const npmCli =
    npmExecPath ||
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!npmExecPath && !existsSync(npmCli)) {
    throw new Error(
      "Cannot locate npm's JavaScript CLI for the Windows package verifier"
    );
  }
  return { command: execPath, args: [npmCli] };
}

function packInto(directory) {
  // npm run injects the user's configured npm cache into npm_config_cache.
  // The release verifier must stay hermetic (and work in restricted runners),
  // so only the purpose-specific opt-in can replace its scratch cache.
  const cache =
    process.env.FIGMA_BRIDGE_PACKAGE_CACHE ||
    join(tmpdir(), "figma-bridge-package-cache");
  const npm = npmPackInvocation();
  const stdout = execFileSync(
    npm.command,
    [
      ...npm.args,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      directory,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(
      `npm pack returned ${Array.isArray(result) ? result.length : "an invalid number of"} artifacts`
    );
  }
  const rawMetadata = result[0];
  const tarballPath = join(directory, rawMetadata.filename);
  const rawTarball = readFileSync(tarballPath);
  const rawSha1 = digest("sha1", rawTarball);
  const rawSha512 = digest("sha512", rawTarball, "base64");
  if (rawMetadata.shasum !== rawSha1)
    throw new Error("npm's tarball SHA-1 does not match the packed bytes");
  if (rawMetadata.integrity !== `sha512-${rawSha512}`) {
    throw new Error(
      "npm's tarball SHA-512 integrity does not match the packed bytes"
    );
  }

  const policy = readPackageArtifactPolicy({ root: ROOT });
  const canonical = canonicalizePackageTarball(rawTarball, {
    executables: policy.executables,
  });
  if (
    canonicalInventory(rawMetadata.files || []) !==
    canonicalInventory(canonical.rawFiles)
  ) {
    throw new Error("npm's JSON inventory does not match its tarball bytes");
  }

  const tarball = canonical.tarball;
  const sha1 = digest("sha1", tarball);
  const sha512 = digest("sha512", tarball, "base64");
  const metadata = {
    ...rawMetadata,
    size: tarball.length,
    shasum: sha1,
    integrity: `sha512-${sha512}`,
    files: canonical.files,
  };
  return {
    metadata,
    tarball,
    sha256: digest("sha256", tarball),
    inventory: verifyPackageMetadata(metadata, { policy }),
  };
}

export function buildVerifiedPackage({ outputDir = null } = {}) {
  const firstDir = mkdtempSync(join(tmpdir(), "figma-bridge-pack-a-"));
  const secondDir = mkdtempSync(join(tmpdir(), "figma-bridge-pack-b-"));
  try {
    const first = packInto(firstDir);
    const second = packInto(secondDir);
    if (
      first.sha256 !== second.sha256 ||
      !first.tarball.equals(second.tarball)
    ) {
      throw new Error("two clean npm pack runs produced different bytes");
    }

    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
    const policyBytes = readFileSync(POLICY_PATH);
    const evidence = {
      schema: "figma-bridge/package-integrity-evidence/v1",
      package: `${packageJson.name}@${packageJson.version}`,
      artifact: {
        file: "package.tgz",
        bytes: first.tarball.length,
        sha256: first.sha256,
        sha512: first.metadata.integrity,
        npmShasum: first.metadata.shasum,
      },
      reproducibility: {
        byteIdenticalPacks: 2,
      },
      policy: {
        file: "release/package-artifact-policy.json",
        sha256: digest("sha256", policyBytes),
      },
      inventory: first.inventory,
    };

    if (outputDir) {
      const destination = resolve(ROOT, outputDir);
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "package.tgz"), first.tarball, {
        mode: 0o644,
      });
      writeFileSync(
        join(destination, "integrity.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o644 }
      );
      const copied = readFileSync(join(destination, "package.tgz"));
      if (
        !copied.equals(first.tarball) ||
        digest("sha256", copied) !== first.sha256
      ) {
        throw new Error(
          "copied release artifact bytes do not match the verified tarball"
        );
      }
    }
    return evidence;
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      outputDir = argv[index + 1];
      if (!outputDir) throw new Error("--output-dir requires a path");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/verify-package-artifact.js [--output-dir <directory>]\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { outputDir };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence = buildVerifiedPackage(options);
    process.stdout.write(
      `Verified ${evidence.package}: ${evidence.inventory.count} allowlisted files, ` +
        `2 byte-identical packs, sha256 ${evidence.artifact.sha256}\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
