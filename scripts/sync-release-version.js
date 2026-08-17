#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function writeJson(root, path, value) {
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

export function releaseVersionState(root = SCRIPT_ROOT) {
  const pkg = readJson(root, "package.json");
  const lock = readJson(root, "package-lock.json");
  const engine = readJson(root, "engine/package.json");
  const codex = readJson(root, ".codex-plugin/plugin.json");
  const claude = readJson(root, ".claude-plugin/plugin.json");
  const portable = readJson(root, "plugin.json");
  const codexMarketplace = readJson(root, ".agents/plugins/marketplace.json");
  const claudeMarketplace = readJson(root, ".claude-plugin/marketplace.json");
  const codexMcp = readJson(root, ".mcp.json");
  const portableMcp = readJson(root, "mcp.json");

  return {
    packageVersion: pkg.version,
    packageName: pkg.name,
    values: {
      "package-lock.json#version": lock.version,
      "package-lock.json#packages[\"\"].version": lock.packages?.[""]?.version,
      "engine/package.json#version": engine.version,
      ".codex-plugin/plugin.json#version": codex.version,
      ".claude-plugin/plugin.json#version": claude.version,
      "plugin.json#version": portable.version,
      ".agents/plugins/marketplace.json#source.ref": codexMarketplace.plugins?.[0]?.source?.ref,
      ".claude-plugin/marketplace.json#source.ref": claudeMarketplace.plugins?.[0]?.source?.ref,
      ".mcp.json#server-package": codexMcp.mcpServers?.["figma-bridge"]?.args?.at(-1),
      "mcp.json#server-package": portableMcp.mcpServers?.["figma-bridge"]?.args?.at(-1),
    },
  };
}

export function releaseVersionMismatches(root = SCRIPT_ROOT) {
  const state = releaseVersionState(root);
  const tag = `v${state.packageVersion}`;
  const packageSpec = `${state.packageName}@${state.packageVersion}`;
  const expected = {
    "package-lock.json#version": state.packageVersion,
    "package-lock.json#packages[\"\"].version": state.packageVersion,
    "engine/package.json#version": state.packageVersion,
    ".codex-plugin/plugin.json#version": state.packageVersion,
    ".claude-plugin/plugin.json#version": state.packageVersion,
    "plugin.json#version": state.packageVersion,
    ".agents/plugins/marketplace.json#source.ref": tag,
    ".claude-plugin/marketplace.json#source.ref": tag,
    ".mcp.json#server-package": packageSpec,
    "mcp.json#server-package": packageSpec,
  };

  return Object.entries(expected)
    .filter(([key, value]) => state.values[key] !== value)
    .map(([key, value]) => ({ key, expected: value, actual: state.values[key] }));
}

export function assertReleaseVersion(root = SCRIPT_ROOT) {
  const { packageVersion } = releaseVersionState(root);
  if (!SEMVER.test(packageVersion)) {
    throw new Error(`package.json version is not strict semver: ${packageVersion}`);
  }
  const mismatches = releaseVersionMismatches(root);
  if (mismatches.length) {
    throw new Error([
      `Release version ${packageVersion} is not synchronized:`,
      ...mismatches.map(({ key, expected, actual }) =>
        `- ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
      `Run: node scripts/sync-release-version.js ${packageVersion}`,
    ].join("\n"));
  }
  return packageVersion;
}

export function syncReleaseVersion(version, root = SCRIPT_ROOT) {
  if (!SEMVER.test(version)) throw new Error(`Version must be strict semver: ${version}`);

  const pkg = readJson(root, "package.json");
  const lock = readJson(root, "package-lock.json");
  const engine = readJson(root, "engine/package.json");
  const codex = readJson(root, ".codex-plugin/plugin.json");
  const claude = readJson(root, ".claude-plugin/plugin.json");
  const portable = readJson(root, "plugin.json");
  const codexMarketplace = readJson(root, ".agents/plugins/marketplace.json");
  const claudeMarketplace = readJson(root, ".claude-plugin/marketplace.json");
  const codexMcp = readJson(root, ".mcp.json");
  const portableMcp = readJson(root, "mcp.json");
  const packageSpec = `${pkg.name}@${version}`;

  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  engine.version = version;
  codex.version = version;
  claude.version = version;
  portable.version = version;
  codexMarketplace.plugins[0].source.ref = `v${version}`;
  claudeMarketplace.plugins[0].source.ref = `v${version}`;
  codexMcp.mcpServers["figma-bridge"].args[
    codexMcp.mcpServers["figma-bridge"].args.length - 1
  ] = packageSpec;
  portableMcp.mcpServers["figma-bridge"].args[
    portableMcp.mcpServers["figma-bridge"].args.length - 1
  ] = packageSpec;

  for (const [path, value] of [
    ["package.json", pkg],
    ["package-lock.json", lock],
    ["engine/package.json", engine],
    [".codex-plugin/plugin.json", codex],
    [".claude-plugin/plugin.json", claude],
    ["plugin.json", portable],
    [".agents/plugins/marketplace.json", codexMarketplace],
    [".claude-plugin/marketplace.json", claudeMarketplace],
    [".mcp.json", codexMcp],
    ["mcp.json", portableMcp],
  ]) writeJson(root, path, value);

  assertReleaseVersion(root);
  return version;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv[2] === "--check") {
      const version = assertReleaseVersion();
      console.log(`Release metadata is synchronized at ${version}.`);
    } else if (!process.argv[2]) {
      throw new Error("Usage: node scripts/sync-release-version.js <version> | --check");
    } else {
      const version = syncReleaseVersion(process.argv[2]);
      console.log(`Synchronized release metadata at ${version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
