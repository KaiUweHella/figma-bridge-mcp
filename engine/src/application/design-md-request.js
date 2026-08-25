// Closed request Interface for `tokens import-design-md`.

export const MAX_DESIGN_MD_PATH_CODE_UNITS = 4_096;
export const MAX_DESIGN_MD_COLLECTION_CODE_UNITS = 512;
const UNSAFE_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069]/u;

function requestError(message) {
  return new Error(`Invalid DESIGN.md import command: ${message}.`);
}

function identity(value, label, maximum) {
  if (typeof value !== "string" || !value.trim())
    throw requestError(`${label} is required`);
  if (value.length > maximum)
    throw requestError(`${label} must be at most ${maximum} code units`);
  if (UNSAFE_CONTROLS.test(value))
    throw requestError(`${label} contains unsupported control characters`);
  return value;
}

function parsedRequest(args) {
  if (
    !Array.isArray(args) ||
    args[0] !== "tokens" ||
    args[1] !== "import-design-md"
  ) {
    throw new Error("Expected a tokens import-design-md command.");
  }
  if (args.some((value) => typeof value !== "string")) {
    throw new TypeError("DESIGN.md import arguments must be strings.");
  }
  let collection = null;
  let printContext = false;
  let literal = false;
  const positionals = [];
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token === "--print-context") {
      if (printContext)
        throw requestError("--print-context may be provided only once");
      printContext = true;
      continue;
    }
    let value;
    if (!literal && (token === "--collection" || token === "-c"))
      value = args[++index];
    else if (!literal && token.startsWith("--collection="))
      value = token.slice(13);
    else if (!literal && token.startsWith("-c") && token !== "-c")
      value = token.slice(2);
    if (value !== undefined) {
      if (collection !== null)
        throw requestError("--collection may be provided only once");
      if (!value || value === "--" || value.startsWith("-")) {
        throw requestError(
          "--collection requires a value; option-looking names must use --collection=<name>"
        );
      }
      collection = identity(
        value,
        "collection",
        MAX_DESIGN_MD_COLLECTION_CODE_UNITS
      );
      continue;
    }
    if (!literal && token.startsWith("-"))
      throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length < 1) throw requestError("file is required");
  if (positionals.length > 1) throw requestError("only one file is accepted");
  return Object.freeze({
    file: identity(positionals[0], "file", MAX_DESIGN_MD_PATH_CODE_UNITS),
    collection,
    printContext,
  });
}

export function parseDesignMdRequest(args) {
  return parsedRequest(args);
}

export function acceptsDesignMdArgv(args) {
  try {
    parseDesignMdRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => !["file", "collection", "printContext"].includes(key)
    )
  ) {
    throw new TypeError("DESIGN.md import request must be a closed object.");
  }
  return parsedRequest([
    "tokens",
    "import-design-md",
    ...(request.collection == null
      ? []
      : [`--collection=${request.collection}`]),
    ...(request.printContext === true ? ["--print-context"] : []),
    "--",
    request.file,
  ]);
}

export function designMdArgvFromRequest(request) {
  const input = typedRequest(request);
  return [
    "tokens",
    "import-design-md",
    ...(input.collection == null ? [] : [`--collection=${input.collection}`]),
    ...(input.printContext ? ["--print-context"] : []),
    "--",
    input.file,
  ];
}

export const designMdPlanningArgvFromRequest = designMdArgvFromRequest;
