// Closed request Interface for `combos`.
import { NodeReferenceError, parseNodeReference } from "./node-reference.js";

export const COMPONENT_COMBINATIONS_DEFAULT_GAP = 40;
export const MAX_COMPONENT_COMBINATIONS_GAP = 100_000;

const fail = (message) => new Error(`Invalid combos command: ${message}.`);

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw fail(
      "nodeId must be a bounded Figma node id or URL containing node-id"
    );
  }
}

function gapValue(value) {
  if (typeof value === "string" && !value.trim())
    throw fail("gap must be a bounded safe integer");
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    Math.abs(number) > MAX_COMPONENT_COMBINATIONS_GAP
  ) {
    throw fail(
      `gap must be from -${MAX_COMPONENT_COMBINATIONS_GAP} to ${MAX_COMPONENT_COMBINATIONS_GAP}`
    );
  }
  return number === 0 ? COMPONENT_COMBINATIONS_DEFAULT_GAP : number;
}

function parsed(args) {
  if (!Array.isArray(args) || args[0] !== "combos")
    throw new Error("Expected a combos command.");
  if (args.some((value) => typeof value !== "string"))
    throw new TypeError("Combos arguments must be strings.");
  let node = null;
  let gap = COMPONENT_COMBINATIONS_DEFAULT_GAP;
  let labels = true;
  let includeBoolean = true;
  let dryRun = false;
  let gapSeen = false;
  let labelsSeen = false;
  let booleanSeen = false;
  let dryRunSeen = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === "--") throw fail("option terminator is not supported");
    if (
      token === "-g" ||
      token === "--gap" ||
      token.startsWith("--gap=") ||
      (token.startsWith("-g") && token.length > 2)
    ) {
      if (gapSeen) throw fail("--gap may appear only once");
      gapSeen = true;
      let value;
      if (token === "-g" || token === "--gap") value = args[++index];
      else value = token.slice(token.indexOf("=") + 1).replace(/^-g/, "");
      if (typeof value !== "string" || !value)
        throw fail("--gap requires a value");
      gap = gapValue(value);
      continue;
    }
    if (token === "--no-labels") {
      if (labelsSeen) throw fail("--no-labels may appear only once");
      labelsSeen = true;
      labels = false;
      continue;
    }
    if (token === "--no-boolean") {
      if (booleanSeen) throw fail("--no-boolean may appear only once");
      booleanSeen = true;
      includeBoolean = false;
      continue;
    }
    if (token === "--dry-run") {
      if (dryRunSeen) throw fail("--dry-run may appear only once");
      dryRunSeen = true;
      dryRun = true;
      continue;
    }
    if (token.startsWith("-")) throw fail(`unknown option ${token}`);
    if (node) throw fail(`unexpected argument ${token}`);
    node = nodeReference(token);
  }
  return { node, gap, labels, includeBoolean, dryRun };
}

export function parseComponentCombinationsRequest(args) {
  const input = parsed(args);
  return Object.freeze({
    nodeId: input.node?.nodeId || null,
    gap: input.gap,
    labels: input.labels,
    includeBoolean: input.includeBoolean,
    dryRun: input.dryRun,
  });
}

export function acceptsComponentCombinationsArgv(args) {
  try {
    parseComponentCombinationsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typed(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Component Combinations request must be an object.");
  }
  for (const key of ["labels", "includeBoolean", "dryRun"]) {
    if (request[key] !== undefined && typeof request[key] !== "boolean")
      throw fail(`${key} must be boolean`);
  }
  return {
    node: request.nodeId == null ? null : nodeReference(request.nodeId),
    gap: gapValue(request.gap ?? COMPONENT_COMBINATIONS_DEFAULT_GAP),
    labels: request.labels ?? true,
    includeBoolean: request.includeBoolean ?? true,
    dryRun: request.dryRun ?? false,
  };
}

function argv(request, planning) {
  const input = typed(request);
  const args = ["combos"];
  if (input.node)
    args.push(planning ? input.node.planningValue : input.node.nodeId);
  if (input.gap !== COMPONENT_COMBINATIONS_DEFAULT_GAP)
    args.push("--gap", String(input.gap));
  if (!input.labels) args.push("--no-labels");
  if (!input.includeBoolean) args.push("--no-boolean");
  if (input.dryRun) args.push("--dry-run");
  return args;
}

export const componentCombinationsArgvFromRequest = (request) =>
  argv(request, false);
export const componentCombinationsPlanningArgvFromRequest = (request) =>
  argv(request, true);
export const componentCombinationsFigmaUrlFileKeyFromArgv = (args) =>
  parsed(args).node?.fileKey || null;
