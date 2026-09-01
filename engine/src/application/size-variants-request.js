// Closed request Interface for `sizes`.

import { NodeReferenceError, parseNodeReference } from "./node-reference.js";

export const SIZE_VARIANTS_DEFAULT_BASE = "medium";
export const SIZE_VARIANTS_DEFAULT_GAP = 40;
export const MAX_SIZE_VARIANTS_GAP = 100_000;

const BASE_SIZES = new Set(["small", "medium", "large"]);

function requestError(message) {
  return new Error(`Invalid sizes command: ${message}.`);
}

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw requestError(
      "nodeId must be a bounded Figma node id or URL containing node-id"
    );
  }
}

function baseSize(value) {
  if (typeof value !== "string" || !BASE_SIZES.has(value.toLowerCase())) {
    throw requestError("base must be small, medium, or large");
  }
  return value.toLowerCase();
}

function gapValue(value) {
  if (typeof value === "string" && value.trim().length === 0) {
    throw requestError(
      `gap must be a safe integer from -${MAX_SIZE_VARIANTS_GAP} to ${MAX_SIZE_VARIANTS_GAP}`
    );
  }
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    Math.abs(number) > MAX_SIZE_VARIANTS_GAP
  ) {
    throw requestError(
      `gap must be a safe integer from -${MAX_SIZE_VARIANTS_GAP} to ${MAX_SIZE_VARIANTS_GAP}`
    );
  }
  // Preserve the public Command's established `parseInt(value) || 40`
  // semantics while closing malformed and unbounded numeric spellings.
  return number === 0 ? SIZE_VARIANTS_DEFAULT_GAP : number;
}

function optionValue(args, index, token, names) {
  for (const name of names) {
    if (token === name) {
      const value = args[index + 1];
      if (typeof value !== "string" || !value || value === "--") {
        throw requestError(`${name} requires a value`);
      }
      return { value, consumed: 1 };
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1);
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
    if (name.length === 2 && token.startsWith(name) && token.length > 2) {
      const value = token.slice(2).replace(/^=/, "");
      if (!value) throw requestError(`${name} requires a value`);
      return { value, consumed: 0 };
    }
  }
  return null;
}

function parsedRequest(args) {
  if (!Array.isArray(args) || args[0] !== "sizes") {
    throw new Error("Expected a sizes command.");
  }
  if (args.some((value) => typeof value !== "string")) {
    throw new TypeError("Size Variants arguments must be strings.");
  }
  const positionals = [];
  let base = SIZE_VARIANTS_DEFAULT_BASE;
  let gap = SIZE_VARIANTS_DEFAULT_GAP;
  let baseSeen = false;
  let gapSeen = false;
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith("-")) {
      const parsedBase = optionValue(args, index, token, ["-b", "--base"]);
      if (parsedBase) {
        if (baseSeen) throw requestError("--base may appear only once");
        baseSeen = true;
        base = baseSize(parsedBase.value);
        index += parsedBase.consumed;
        continue;
      }
      const parsedGap = optionValue(args, index, token, ["-g", "--gap"]);
      if (parsedGap) {
        if (gapSeen) throw requestError("--gap may appear only once");
        gapSeen = true;
        gap = gapValue(parsedGap.value);
        index += parsedGap.consumed;
        continue;
      }
      throw requestError(`unknown option ${token}`);
    }
    positionals.push(token);
  }
  if (positionals.length > 1)
    throw requestError(`unexpected argument ${positionals[1]}`);
  return {
    node: positionals.length ? nodeReference(positionals[0]) : null,
    baseSize: base,
    gap,
  };
}

export function parseSizeVariantsRequest(args) {
  const input = parsedRequest(args);
  return Object.freeze({
    nodeId: input.node?.nodeId || null,
    baseSize: input.baseSize,
    gap: input.gap,
  });
}

export function acceptsSizeVariantsArgv(args) {
  try {
    parseSizeVariantsRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Size Variants request must be an object.");
  }
  return {
    node:
      request.nodeId === null || request.nodeId === undefined
        ? null
        : nodeReference(request.nodeId),
    baseSize: baseSize(request.baseSize ?? SIZE_VARIANTS_DEFAULT_BASE),
    gap: gapValue(request.gap ?? SIZE_VARIANTS_DEFAULT_GAP),
  };
}

function argvFromInput(input, { planning = false } = {}) {
  const args = ["sizes"];
  if (input.node)
    args.push(planning ? input.node.planningValue : input.node.nodeId);
  if (input.baseSize !== SIZE_VARIANTS_DEFAULT_BASE)
    args.push("--base", input.baseSize);
  if (input.gap !== SIZE_VARIANTS_DEFAULT_GAP)
    args.push("--gap", String(input.gap));
  return args;
}

export function sizeVariantsArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request));
  parseSizeVariantsRequest(args);
  return args;
}

export function sizeVariantsPlanningArgvFromRequest(request) {
  const args = argvFromInput(typedRequest(request), { planning: true });
  parseSizeVariantsRequest(args);
  return args;
}

export function sizeVariantsFigmaUrlFileKeyFromArgv(args) {
  return parsedRequest(args).node?.fileKey || null;
}
