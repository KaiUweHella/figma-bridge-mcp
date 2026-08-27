// Closed request Interface for `var update-batch`.

import {
  parseVariableUpdateRequest,
  variableUpdateArgvFromRequest,
} from "./variable-update-request.js";

export const MAX_VARIABLE_UPDATE_BATCH_ITEMS = 64;
export const MAX_VARIABLE_UPDATE_BATCH_JSON_CODE_UNITS = 262_144;
const ITEM_FIELDS = [
  "variable",
  "collection",
  "name",
  "description",
  "hidden",
  "scopes",
];

function requestError(message) {
  return new Error(`Invalid var update-batch command: ${message}.`);
}

function plainObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizedItem(value, index) {
  if (!plainObject(value))
    throw requestError(`item ${index + 1} must be an object`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !ITEM_FIELDS.includes(key));
  if (unknown.length) {
    throw requestError(
      `item ${index + 1} contains unknown fields: ${unknown.join(", ")}`
    );
  }
  if (!Object.hasOwn(value, "variable")) {
    throw requestError(`item ${index + 1} variable is required`);
  }
  if (
    Object.hasOwn(value, "collection") &&
    value.collection !== null &&
    typeof value.collection !== "string"
  ) {
    throw requestError(`item ${index + 1} collection must be text or null`);
  }
  if (Object.hasOwn(value, "name") && typeof value.name !== "string") {
    throw requestError(`item ${index + 1} name must be text`);
  }
  if (
    Object.hasOwn(value, "description") &&
    typeof value.description !== "string"
  ) {
    throw requestError(`item ${index + 1} description must be text`);
  }
  if (Object.hasOwn(value, "hidden") && typeof value.hidden !== "boolean") {
    throw requestError(`item ${index + 1} hidden must be a boolean`);
  }
  if (
    Object.hasOwn(value, "scopes") &&
    (!Array.isArray(value.scopes) ||
      value.scopes.some((scope) => typeof scope !== "string"))
  ) {
    throw requestError(`item ${index + 1} scopes must be an array of strings`);
  }
  let normalized;
  try {
    normalized = parseVariableUpdateRequest(
      variableUpdateArgvFromRequest({
        variable: value.variable,
        collection: Object.hasOwn(value, "collection")
          ? value.collection
          : null,
        ...(Object.hasOwn(value, "name") ? { name: value.name } : {}),
        ...(Object.hasOwn(value, "description")
          ? { description: value.description }
          : {}),
        ...(Object.hasOwn(value, "hidden") ? { hidden: value.hidden } : {}),
        ...(Object.hasOwn(value, "scopes") ? { scopes: value.scopes } : {}),
      })
    );
  } catch (error) {
    throw requestError(`item ${index + 1}: ${String(error?.message || error)}`);
  }
  return {
    variable: normalized.variable,
    collection: normalized.collection,
    ...(normalized.name === undefined ? {} : { name: normalized.name }),
    ...(normalized.description === undefined
      ? {}
      : { description: normalized.description }),
    ...(normalized.hidden === undefined ? {} : { hidden: normalized.hidden }),
    ...(normalized.scopes === undefined ? {} : { scopes: normalized.scopes }),
  };
}

function normalizedItems(value) {
  if (!Array.isArray(value) || value.length < 1) {
    throw requestError("JSON must be a non-empty array");
  }
  if (value.length > MAX_VARIABLE_UPDATE_BATCH_ITEMS) {
    throw requestError(
      `at most ${MAX_VARIABLE_UPDATE_BATCH_ITEMS} items are accepted`
    );
  }
  const items = value.map(normalizedItem);
  const identities = items.map((item) =>
    JSON.stringify([item.collection, item.variable])
  );
  if (new Set(identities).size !== identities.length) {
    throw requestError("duplicate targets are not accepted");
  }
  return items;
}

function parseJson(value) {
  if (typeof value !== "string") throw requestError("JSON must be text");
  if (value.length > MAX_VARIABLE_UPDATE_BATCH_JSON_CODE_UNITS) {
    throw requestError(
      `JSON must be at most ${MAX_VARIABLE_UPDATE_BATCH_JSON_CODE_UNITS} code units`
    );
  }
  try {
    return JSON.parse(value);
  } catch {
    throw requestError("JSON must be valid");
  }
}

export function parseVariableUpdateBatchRequest(args) {
  if (
    !Array.isArray(args) ||
    !["var", "variables"].includes(args[0]) ||
    args[1] !== "update-batch"
  )
    throw new Error("Expected a var update-batch command.");
  if (args.some((value) => typeof value !== "string")) {
    throw new TypeError(
      "Variable Metadata Update Batch arguments must be strings."
    );
  }
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith("-"))
      throw requestError(`unknown option ${token}`);
    positionals.push(token);
  }
  if (positionals.length !== 1)
    throw requestError("exactly one JSON value is required");
  return { items: normalizedItems(parseJson(positionals[0])) };
}

export function acceptsVariableUpdateBatchArgv(args) {
  try {
    parseVariableUpdateBatchRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typedRequest(request) {
  if (
    !plainObject(request) ||
    Object.keys(request).length !== 1 ||
    !Object.hasOwn(request, "items")
  ) {
    throw new TypeError(
      "Variable Metadata Update Batch request must contain only items."
    );
  }
  return { items: normalizedItems(request.items) };
}

export function variableUpdateBatchArgvFromRequest(request) {
  const input = typedRequest(request);
  const json = JSON.stringify(input.items);
  if (json.length > MAX_VARIABLE_UPDATE_BATCH_JSON_CODE_UNITS) {
    throw requestError(
      `JSON must be at most ${MAX_VARIABLE_UPDATE_BATCH_JSON_CODE_UNITS} code units`
    );
  }
  return ["var", "update-batch", "--", json];
}

export const variableUpdateBatchPlanningArgvFromRequest =
  variableUpdateBatchArgvFromRequest;
