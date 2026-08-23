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
const DISPATCH_CANONICAL_PATH = join(
  ROOT,
  "engine",
  "src",
  "lib",
  "dispatch-receipt.js"
);
const ARTIFACT_PATH = join(ROOT, "plugin", "code.js");
const BEGIN = "// BEGIN STRUCTURED RENDER RUNTIME";
const END = "// END STRUCTURED RENDER RUNTIME";
const DISPATCH_BEGIN = "// BEGIN DISPATCH RECEIPT RUNTIME";
const DISPATCH_END = "// END DISPATCH RECEIPT RUNTIME";

function normalizeLf(source) {
  return String(source).replace(/\r\n?/g, "\n");
}

function markedRuntime(source, label, begin = BEGIN, end = END) {
  const normalized = normalizeLf(source);
  const beginCount = normalized.split(begin).length - 1;
  const endCount = normalized.split(end).length - 1;
  const markerName = begin === BEGIN
    ? "structured-runtime"
    : "Dispatch Receipt runtime";
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(
      `${label} must contain exactly one ${markerName} marker pair`
    );
  }
  const beginAt = normalized.indexOf(begin);
  const start = beginAt + begin.length + 1;
  const endAt = normalized.indexOf(end, start);
  if (beginAt < 0 || normalized[beginAt + begin.length] !== "\n" || endAt < start)
    throw new Error(`${label} has malformed ${markerName} markers`);
  return { content: normalized.slice(start, endAt), start, end: endAt };
}

function replaceMarkedRuntime(canonicalSource, pluginSource, {
  begin = BEGIN,
  end = END,
  canonicalLabel = "canonical executor",
  artifactLabel = "plugin artifact",
} = {}) {
  const canonical = markedRuntime(
    canonicalSource,
    canonicalLabel,
    begin,
    end
  ).content.replace(/^export /gm, "");
  const plugin = normalizeLf(pluginSource);
  const current = markedRuntime(plugin, artifactLabel, begin, end);
  return plugin.slice(0, current.start) + canonical + plugin.slice(current.end);
}

export function renderPluginArtifact(canonicalSource, pluginSource) {
  return replaceMarkedRuntime(canonicalSource, pluginSource);
}

export function renderPluginDispatchArtifact(canonicalSource, pluginSource) {
  return replaceMarkedRuntime(canonicalSource, pluginSource, {
    begin: DISPATCH_BEGIN,
    end: DISPATCH_END,
    canonicalLabel: "canonical Dispatch Receipt",
  });
}

export function syncPluginArtifact({ check = false } = {}) {
  const canonical = readFileSync(CANONICAL_PATH, "utf8");
  const dispatchCanonical = readFileSync(DISPATCH_CANONICAL_PATH, "utf8");
  const current = readFileSync(ARTIFACT_PATH, "utf8");
  const structured = renderPluginArtifact(canonical, current);
  const expected = renderPluginDispatchArtifact(dispatchCanonical, structured);
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
