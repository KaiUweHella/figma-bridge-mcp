#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_PATH = join(
  ROOT,
  "engine",
  "src",
  "lib",
  "structured-render-executor.js"
);
const ARTIFACT_PATH = join(ROOT, "plugin", "code.js");
const BEGIN = "// BEGIN STRUCTURED RENDER RUNTIME";
const END = "// END STRUCTURED RENDER RUNTIME";

function normalizeLf(source) {
  return String(source).replace(/\r\n?/g, "\n");
}

function markedRuntime(source, label) {
  const normalized = normalizeLf(source);
  const beginCount = normalized.split(BEGIN).length - 1;
  const endCount = normalized.split(END).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(
      `${label} must contain exactly one structured-runtime marker pair`
    );
  }
  const pattern = new RegExp(
    `${BEGIN.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]+?)${END.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}`
  );
  const match = normalized.match(pattern);
  if (!match)
    throw new Error(`${label} has malformed structured-runtime markers`);
  const start = match.index + BEGIN.length + 1;
  return { content: match[1], start, end: start + match[1].length };
}

export function renderPluginArtifact(canonicalSource, pluginSource) {
  const canonical = markedRuntime(
    canonicalSource,
    "canonical executor"
  ).content.replace(/^export /gm, "");
  const plugin = normalizeLf(pluginSource);
  const current = markedRuntime(plugin, "plugin artifact");
  return plugin.slice(0, current.start) + canonical + plugin.slice(current.end);
}

export function syncPluginArtifact({ check = false } = {}) {
  const canonical = readFileSync(CANONICAL_PATH, "utf8");
  const current = readFileSync(ARTIFACT_PATH, "utf8");
  const expected = renderPluginArtifact(canonical, current);
  const normalizedCurrent = normalizeLf(current);
  if (normalizedCurrent === expected)
    return { changed: false, path: ARTIFACT_PATH };
  if (check) {
    throw new Error(
      "plugin/code.js has generated-runtime drift; run npm run sync:plugin and review the artifact diff"
    );
  }
  writeFileSync(ARTIFACT_PATH, expected, "utf8");
  return { changed: true, path: ARTIFACT_PATH };
}

function parseArgs(argv) {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === "--check") return { check: true };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(
      "Usage: node scripts/sync-plugin-artifact.js [--check]\n"
    );
    process.exit(0);
  }
  throw new Error(`Unknown arguments: ${argv.join(" ")}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = syncPluginArtifact(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      result.changed
        ? "Updated plugin/code.js from the canonical structured executor.\n"
        : "Plugin artifact matches the canonical structured executor.\n"
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
