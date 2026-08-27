// Bounded, reverse-rollback-owned Variable Metadata Update Batch Application.

import { isDeepStrictEqual } from "node:util";
import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import {
  normalizeVariableScopes,
  VARIABLE_SCOPES,
} from "../lib/variable-management.js";
import { VARIABLE_SCOPES_BY_TYPE } from "../lib/variable-scope-policy.js";
import { MAX_VARIABLE_FACTS_STRING_CODE_UNITS } from "./variable-facts-command.js";
import { variableMutationPluginRuntimeCode } from "./variable-mutation-runtime.js";
import {
  parseVariableUpdateBatchRequest,
  variableUpdateBatchArgvFromRequest,
  variableUpdateBatchPlanningArgvFromRequest,
} from "./variable-update-batch-request.js";

export {
  variableUpdateBatchArgvFromRequest,
  variableUpdateBatchPlanningArgvFromRequest,
} from "./variable-update-batch-request.js";

const VARIABLE_UPDATE_BATCH_APPLICATION_ID = "var.update-batch";
export const MAX_VARIABLE_UPDATE_BATCH_CANDIDATES = 100_000;
export const MAX_VARIABLE_UPDATE_BATCH_SERIALIZED_CODE_UNITS = 1_000_000;
const UPDATE_FIELDS = ["name", "description", "hiddenFromPublishing", "scopes"];
const RESOLVED_TYPES = new Set([
  "BOOLEAN",
  "COLOR",
  "EASING",
  "FLOAT",
  "STRING",
  "TIMING",
]);
const SCOPE_SET = new Set(VARIABLE_SCOPES);

function normalizedRequest(request) {
  return parseVariableUpdateBatchRequest(
    variableUpdateBatchArgvFromRequest(request)
  );
}

function requestedFields(input) {
  return [
    ...(input.name === undefined ? [] : ["name"]),
    ...(input.description === undefined ? [] : ["description"]),
    ...(input.hidden === undefined ? [] : ["hiddenFromPublishing"]),
    ...(input.scopes === undefined ? [] : ["scopes"]),
  ];
}

export function variableUpdateBatchCommandCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const inputs = ${JSON.stringify(input.items)};
    const scopeOptions = ${JSON.stringify(VARIABLE_SCOPES_BY_TYPE)};
    ${variableMutationPluginRuntimeCode({ candidateLimit: MAX_VARIABLE_UPDATE_BATCH_CANDIDATES })}
    const fieldsFor = (item) => [
      ...(item.name === undefined ? [] : ['name']),
      ...(item.description === undefined ? [] : ['description']),
      ...(item.hidden === undefined ? [] : ['hiddenFromPublishing']),
      ...(item.scopes === undefined ? [] : ['scopes']),
    ];
    const identityFor = (entry) => ({
      index: entry.index, id: entry.variable.id, name: entry.matchedNameBefore,
      resolvedType: entry.variable.resolvedType,
    });
    const compactVariable = (facts) => ({
      id: facts.id, name: facts.name, description: facts.description,
      resolvedType: facts.resolvedType,
      hiddenFromPublishing: facts.hiddenFromPublishing, scopes: facts.scopes,
      collection: facts.collection,
    });
    const prepared = [];
    const resolvedIds = new Set();
    for (let index = 0; index < inputs.length; index++) {
      const item = inputs[index];
      const resolved = __bridgeResolveVariable(item.variable, item.collection);
      const variable = resolved.variable;
      const collection = resolved.collection;
      if (variable.remote || collection.remote) {
        throw new Error('Variable Metadata Update Batch cannot update remote Variables.');
      }
      if (resolvedIds.has(variable.id)) {
        throw new Error('Variable Metadata Update Batch contains a duplicate target.');
      }
      resolvedIds.add(variable.id);
      if (item.scopes !== undefined) {
        const allowedScopes = scopeOptions[variable.resolvedType] || ['ALL_SCOPES'];
        const incompatibleScopes = item.scopes.filter((scope) => !allowedScopes.includes(scope));
        if (incompatibleScopes.length) {
          throw new Error('Variable ' + variable.id + ' scopes '
            + incompatibleScopes.join(', ') + ' are incompatible with '
            + variable.resolvedType + '.');
        }
      }
      const preflightFacts = await __bridgeVariableFacts(variable, collection);
      if (!__bridgeValidateVariableFacts(preflightFacts)) {
        throw new Error('Variable Metadata Update Batch encountered incompatible preflight metadata.');
      }
      prepared.push({
        index, input: item, variable, collection, resolution: resolved.resolution,
        matchedNameBefore: variable.name, requestedFields: fieldsFor(item),
        previous: {
          name: variable.name, description: variable.description,
          hiddenFromPublishing: variable.hiddenFromPublishing, scopes: [...variable.scopes],
        },
      });
    }
    const attempted = [];
    const confirmed = [];
    const updates = [];
    try {
      for (const entry of prepared) {
        const item = entry.input;
        const variable = entry.variable;
        attempted.push(entry);
        if (item.name !== undefined) variable.name = item.name;
        if (item.description !== undefined) variable.description = item.description;
        if (item.hidden !== undefined) variable.hiddenFromPublishing = item.hidden;
        if (item.scopes !== undefined) variable.scopes = [...item.scopes];
        const facts = await __bridgeVariableFacts(variable, entry.collection);
        const affectedValid = (item.name === undefined || facts.name === item.name)
          && (item.description === undefined || facts.description === item.description)
          && (item.hidden === undefined || facts.hiddenFromPublishing === item.hidden)
          && (item.scopes === undefined || (facts.scopes.length === item.scopes.length
            && facts.scopes.every((scope, scopeIndex) => scope === item.scopes[scopeIndex])));
        if (!__bridgeValidateVariableFacts(facts) || !affectedValid) {
          throw new Error('Variable Metadata Update Batch encountered incompatible result metadata.');
        }
        confirmed.push(entry);
        updates.push({
          index: entry.index, query: item.variable, collectionHint: item.collection,
          resolution: entry.resolution, matchedNameBefore: entry.matchedNameBefore,
          requestedFields: entry.requestedFields, variable: compactVariable(facts),
        });
      }
      const complete = {
        schemaVersion: 1, status: 'updated', outcome: 'committed',
        attempted: attempted.map(identityFor), confirmed: confirmed.map(identityFor),
        restored: [], residual: [], restoreFailures: [], updates,
      };
      const serialized = JSON.stringify(complete);
      if (serialized.length > ${MAX_VARIABLE_UPDATE_BATCH_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Metadata Update Batch result exceeded the bounded result limit.');
      }
      return serialized;
    } catch {
      const restored = [];
      const residual = [];
      const restoreFailures = [];
      for (let index = attempted.length - 1; index >= 0; index--) {
        const entry = attempted[index];
        const variable = entry.variable;
        const failedFields = [];
        const restore = (field, apply, verify) => {
          if (!entry.requestedFields.includes(field)) return;
          try { apply(); } catch { failedFields.push(field); return; }
          if (!verify()) failedFields.push(field);
        };
        restore('scopes', () => { variable.scopes = [...entry.previous.scopes]; },
          () => variable.scopes.length === entry.previous.scopes.length
            && variable.scopes.every((scope, scopeIndex) => scope === entry.previous.scopes[scopeIndex]));
        restore('hiddenFromPublishing',
          () => { variable.hiddenFromPublishing = entry.previous.hiddenFromPublishing; },
          () => variable.hiddenFromPublishing === entry.previous.hiddenFromPublishing);
        restore('description', () => { variable.description = entry.previous.description; },
          () => variable.description === entry.previous.description);
        restore('name', () => { variable.name = entry.previous.name; },
          () => variable.name === entry.previous.name);
        const identity = identityFor(entry);
        if (failedFields.length) {
          residual.push(identity);
          restoreFailures.push({ index: entry.index, id: variable.id, fields: failedFields });
        } else restored.push(identity);
      }
      const outcome = residual.length ? 'partial-residue' : 'rolled-back';
      const failure = {
        schemaVersion: 1, status: 'failed', outcome,
        attempted: attempted.map(identityFor), confirmed: confirmed.map(identityFor),
        restored, residual, restoreFailures, updates: [],
      };
      const serialized = JSON.stringify(failure);
      if (serialized.length > ${MAX_VARIABLE_UPDATE_BATCH_SERIALIZED_CODE_UNITS}) {
        throw new Error('Variable Metadata Update Batch failure evidence exceeded the result limit.');
      }
      return serialized;
    }
  })()`;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function boundedString(value, { empty = true } = {}) {
  return (
    typeof value === "string" &&
    value.length <= MAX_VARIABLE_FACTS_STRING_CODE_UNITS &&
    (empty || value.length > 0)
  );
}

function sameMembers(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function validIdentity(value, itemCount) {
  return (
    exactKeys(value, ["index", "id", "name", "resolvedType"]) &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    value.index < itemCount &&
    boundedString(value.id, { empty: false }) &&
    boundedString(value.name, { empty: false }) &&
    RESOLVED_TYPES.has(value.resolvedType)
  );
}

function validIdentityList(value, itemCount) {
  return (
    Array.isArray(value) &&
    value.length <= itemCount &&
    value.every((identity) => validIdentity(identity, itemCount)) &&
    new Set(value.map((identity) => identity.index)).size === value.length &&
    new Set(value.map((identity) => identity.id)).size === value.length
  );
}

function validCompactVariable(value) {
  let normalizedScopes;
  try { normalizedScopes = normalizeVariableScopes(value?.scopes, value?.resolvedType); }
  catch { return false; }
  return (
    exactKeys(value, [
      "id",
      "name",
      "description",
      "resolvedType",
      "hiddenFromPublishing",
      "scopes",
      "collection",
    ]) &&
    boundedString(value.id, { empty: false }) &&
    boundedString(value.name, { empty: false }) &&
    boundedString(value.description) &&
    RESOLVED_TYPES.has(value.resolvedType) &&
    typeof value.hiddenFromPublishing === "boolean" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => SCOPE_SET.has(scope)) &&
    isDeepStrictEqual(normalizedScopes, value.scopes) &&
    exactKeys(value.collection, ["id", "name"]) &&
    boundedString(value.collection.id, { empty: false }) &&
    boundedString(value.collection.name, { empty: false })
  );
}

function validUpdate(value, input, index) {
  const fields = requestedFields(input);
  return (
    exactKeys(value, [
      "index",
      "query",
      "collectionHint",
      "resolution",
      "matchedNameBefore",
      "requestedFields",
      "variable",
    ]) &&
    value.index === index &&
    value.query === input.variable &&
    value.collectionHint === input.collection &&
    ["id", "name"].includes(value.resolution) &&
    boundedString(value.matchedNameBefore, { empty: false }) &&
    sameMembers(value.requestedFields, fields) &&
    validCompactVariable(value.variable) &&
    (value.resolution !== "id" || value.variable.id === input.variable) &&
    (input.collection === null ||
      value.variable.collection.id === input.collection ||
      value.variable.collection.name
        .toLowerCase()
        .includes(input.collection.toLowerCase())) &&
    (input.name === undefined || value.variable.name === input.name) &&
    (input.description === undefined ||
      value.variable.description === input.description) &&
    (input.hidden === undefined ||
      value.variable.hiddenFromPublishing === input.hidden) &&
    (input.scopes === undefined ||
      isDeepStrictEqual(value.variable.scopes, input.scopes))
  );
}

function sameIdentity(left, right) {
  return (
    left.index === right.index &&
    left.id === right.id &&
    left.name === right.name &&
    left.resolvedType === right.resolvedType
  );
}

function commonPayload(value, itemCount) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "attempted",
      "confirmed",
      "restored",
      "residual",
      "restoreFailures",
      "updates",
    ]) &&
    value.schemaVersion === 1 &&
    validIdentityList(value.attempted, itemCount) &&
    validIdentityList(value.confirmed, itemCount) &&
    validIdentityList(value.restored, itemCount) &&
    validIdentityList(value.residual, itemCount) &&
    Array.isArray(value.restoreFailures) &&
    value.restoreFailures.length <= itemCount &&
    Array.isArray(value.updates) &&
    value.updates.length <= itemCount
  );
}

function validSuccess(value, items) {
  if (
    !commonPayload(value, items.length) ||
    value.status !== "updated" ||
    value.outcome !== "committed" ||
    value.updates.length !== items.length ||
    value.attempted.length !== items.length ||
    value.confirmed.length !== items.length ||
    value.restored.length ||
    value.residual.length ||
    value.restoreFailures.length
  )
    return false;
  if (
    !value.updates.every((update, index) =>
      validUpdate(update, items[index], index)
    )
  )
    return false;
  return value.updates.every((update, index) => {
    const identity = {
      index,
      id: update.variable.id,
      name: update.matchedNameBefore,
      resolvedType: update.variable.resolvedType,
    };
    return (
      sameIdentity(value.attempted[index], identity) &&
      sameIdentity(value.confirmed[index], identity)
    );
  });
}

function validFailure(value, items) {
  if (
    !commonPayload(value, items.length) ||
    value.status !== "failed" ||
    !["rolled-back", "partial-residue"].includes(value.outcome) ||
    value.attempted.length < 1 ||
    value.updates.length ||
    value.confirmed.length > value.attempted.length
  )
    return false;
  if (
    !value.attempted.every((identity, index) => identity.index === index) ||
    !value.confirmed.every((identity, index) =>
      sameIdentity(identity, value.attempted[index])
    )
  ) {
    return false;
  }
  const attemptedByIndex = new Map(
    value.attempted.map((identity) => [identity.index, identity])
  );
  const concluded = [...value.restored, ...value.residual];
  if (
    concluded.length !== value.attempted.length ||
    new Set(concluded.map((identity) => identity.index)).size !==
      value.attempted.length ||
    !concluded.every((identity) => {
      const attempted = attemptedByIndex.get(identity.index);
      return attempted && sameIdentity(identity, attempted);
    })
  )
    return false;
  if (
    value.outcome === "rolled-back" &&
    (value.residual.length || value.restoreFailures.length)
  )
    return false;
  if (
    value.outcome === "partial-residue" &&
    (!value.residual.length ||
      value.restoreFailures.length !== value.residual.length)
  )
    return false;
  const residualByIndex = new Map(
    value.residual.map((identity) => [identity.index, identity])
  );
  if (
    new Set(value.restoreFailures.map((failure) => failure?.index)).size !==
    value.restoreFailures.length
  )
    return false;
  return value.restoreFailures.every((failure) => {
    if (!exactKeys(failure, ["index", "id", "fields"])) return false;
    const identity = residualByIndex.get(failure.index);
    const fields = requestedFields(items[failure.index] || {});
    return (
      identity &&
      failure.id === identity.id &&
      Array.isArray(failure.fields) &&
      failure.fields.length > 0 &&
      failure.fields.length <= fields.length &&
      failure.fields.every(
        (field, index) =>
          fields.includes(field) &&
          UPDATE_FIELDS.includes(field) &&
          failure.fields.indexOf(field) === index
      )
    );
  });
}

function mutationFailure(payload) {
  const rolledBack = payload.outcome === "rolled-back";
  const error = new Error(
    rolledBack
      ? "Variable Metadata Update Batch failed after mutation; every attempted Variable was restored."
      : `Variable Metadata Update Batch failed after mutation; ${payload.residual.length} Variable(s) retain residue.`
  );
  error.kind = "execution";
  error.phase = "plugin-execution";
  error.outcome = "unknown-after-dispatch";
  error.dispatchState = "failed";
  error.mutationOutcome = payload.outcome;
  error.variableUpdateBatchMutationReport = {
    version: 1,
    outcome: payload.outcome,
    attempted: payload.attempted.length,
    confirmed: payload.confirmed.length,
    restored: payload.restored.length,
    residual: payload.residual.length,
    restoreFailures: payload.restoreFailures,
  };
  throw error;
}

export async function executeVariableUpdateBatch(request, adapters = {}) {
  if (typeof adapters.evaluate !== "function") {
    throw new TypeError("executeVariableUpdateBatch requires evaluate(code)");
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(
    variableUpdateBatchCommandCode(input)
  );
  if (
    typeof serialized !== "string" ||
    serialized.length > MAX_VARIABLE_UPDATE_BATCH_SERIALIZED_CODE_UNITS
  ) {
    throw new Error(
      "Variable Metadata Update Batch returned an invalid bounded result."
    );
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error("Variable Metadata Update Batch returned invalid JSON.");
  }
  if (payload?.status === "failed") {
    if (!validFailure(payload, input.items)) {
      throw new Error(
        "Variable Metadata Update Batch returned an invalid bounded result."
      );
    }
    mutationFailure(payload);
  }
  if (!validSuccess(payload, input.items)) {
    throw new Error(
      "Variable Metadata Update Batch returned an invalid bounded result."
    );
  }
  return {
    stdout: `Updated ${payload.confirmed.length} variables`,
    stderr: "",
    result: payload,
  };
}

export function variableUpdateBatchPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Variable Metadata Update Batch routing requires a Command Plan created by the Capability Catalog."
    );
  }
  return plan.allowed && plan.id === VARIABLE_UPDATE_BATCH_APPLICATION_ID
    ? "command-application"
    : "not-variable-update-batch";
}

export async function executeVariableUpdateBatchPlan(plan, adapters = {}) {
  if (variableUpdateBatchPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by Variable Metadata Update Batch.`
    );
  }
  return executeVariableUpdateBatch(
    parseVariableUpdateBatchRequest(plan.argv),
    adapters
  );
}
