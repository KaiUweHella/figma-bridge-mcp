#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_PREFIX = "https://registry.npmjs.org/";

function componentName(path) {
  return path.split("node_modules/").at(-1);
}

function sortedRequirements(descriptor) {
  return Object.fromEntries(
    Object.entries(descriptor || {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

export function installedDependencyEvidence(lock) {
  if (
    lock?.lockfileVersion !== 3 ||
    !lock.packages ||
    typeof lock.packages !== "object"
  ) {
    throw new Error(
      "installed package evidence requires an npm lockfileVersion 3 package-lock"
    );
  }

  const failures = [];
  const components = [];
  for (const [path, descriptor] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (
      !path.startsWith("node_modules/") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      failures.push(`invalid installed package path: ${path}`);
      continue;
    }
    const name = componentName(path);
    if (!name || typeof descriptor?.version !== "string") {
      failures.push(`installed package has no exact name/version: ${path}`);
      continue;
    }
    if (descriptor.hasInstallScript === true) {
      failures.push(`${name}@${descriptor.version} declares an install script`);
    }

    const localArtifact =
      name === "figma-bridge-mcp" &&
      String(descriptor.resolved || "").startsWith("file:");
    if (!localArtifact) {
      if (
        typeof descriptor.resolved !== "string" ||
        !descriptor.resolved.startsWith(REGISTRY_PREFIX)
      ) {
        failures.push(
          `${name}@${descriptor.version} is not resolved from the canonical npm registry`
        );
      }
      if (
        typeof descriptor.integrity !== "string" ||
        !descriptor.integrity.startsWith("sha512-")
      ) {
        failures.push(
          `${name}@${descriptor.version} has no SHA-512 registry integrity`
        );
      }
    }

    components.push({
      path,
      name,
      version: descriptor.version,
      source: localArtifact ? "verified-package-artifact" : descriptor.resolved,
      integrity: localArtifact
        ? "see integrity.json#artifact"
        : descriptor.integrity,
      requires: sortedRequirements(descriptor.dependencies),
      optional: sortedRequirements(descriptor.optionalDependencies),
      peers: sortedRequirements(descriptor.peerDependencies),
      ...(typeof descriptor.license === "string"
        ? { license: descriptor.license }
        : {}),
    });
  }
  components.sort((a, b) => a.path.localeCompare(b.path));

  if (!components.some((component) => component.name === "figma-bridge-mcp")) {
    failures.push("fresh install does not contain figma-bridge-mcp");
  }
  if (failures.length) {
    throw new Error(
      `Installed dependency policy failed:\n- ${failures.join("\n- ")}`
    );
  }

  const canonical = JSON.stringify(components);
  return {
    schema: "figma-bridge/installed-dependency-evidence/v1",
    packageManager: "npm",
    componentCount: components.length,
    installScriptCount: 0,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    components,
  };
}

function main(argv) {
  if (argv.length !== 2 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/write-installed-dependency-evidence.js <installed-prefix> <output-json>\n"
    );
    return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
  }
  const prefix = resolve(argv[0]);
  const output = resolve(argv[1]);
  const lock = JSON.parse(
    readFileSync(resolve(prefix, "package-lock.json"), "utf8")
  );
  const evidence = installedDependencyEvidence(lock);
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o644,
  });
  process.stdout.write(
    `Recorded ${evidence.componentCount} installed production components with no install scripts.\n`
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
