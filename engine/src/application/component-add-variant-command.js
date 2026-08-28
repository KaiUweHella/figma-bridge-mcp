// Plan-bound, rollback-owned Component Add Variant Command Application.

import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import { nearestVariant, variantNamePairs } from "../lib/variant-snippets.js";
import {
  componentSetReferenceArgvFromRequest,
  componentSetReferencePlanningArgvFromRequest,
  MAX_COMPONENT_ADD_VARIANT_AXES,
  MAX_COMPONENT_ADD_VARIANT_AXIS_CODE_UNITS,
  MAX_COMPONENT_ADD_VARIANT_VALUE_CODE_UNITS,
  parseComponentSetReferenceRequest,
} from "./component-set-reference-request.js";

export {
  componentSetReferenceArgvFromRequest,
  componentSetReferencePlanningArgvFromRequest,
} from "./component-set-reference-request.js";

const APPLICATION_ID = "component.add-variant";
export const MAX_COMPONENT_ADD_VARIANT_VARIANTS = 1_024;
export const MAX_COMPONENT_ADD_VARIANT_SCAN_NODES = 100_000;
export const MAX_COMPONENT_ADD_VARIANT_SETS = 10_000;
export const MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS = 512;
export const MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS = 96;
export const MAX_COMPONENT_ADD_VARIANT_SERIALIZED_CODE_UNITS = 262_144;
const NODE_ID = /^I?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function normalizedRequest(request) {
  return parseComponentSetReferenceRequest(
    componentSetReferenceArgvFromRequest(request)
  );
}

export function componentAddVariantCode(request) {
  const input = normalizedRequest(request);
  return `(async () => {
    const reference = ${JSON.stringify({ kind: input.reference.kind, value: input.reference.value })};
    const target = JSON.parse(${JSON.stringify(JSON.stringify(input.pairs))});
    const fromName = ${JSON.stringify(input.fromName)};
    const __pairsFromName = ${variantNamePairs.toString()};
    const __nearest = ${nearestVariant.toString()};
    const clean = (value, maximum) => typeof value === 'string'
      ? value.slice(0, maximum).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const bounded = (payload) => {
      const serialized = JSON.stringify(payload);
      if (serialized.length > ${MAX_COMPONENT_ADD_VARIANT_SERIALIZED_CODE_UNITS}) {
        throw new Error('Component Add Variant result exceeded the bounded response limit.');
      }
      return serialized;
    };

    try {
    let set = null;
    let resolution = null;
    if (reference.kind === 'node') {
      const node = await figma.getNodeByIdAsync(reference.value);
      if (!node) throw new Error('Component Set node not found.');
      if (node.type !== 'COMPONENT_SET') {
        throw new Error('Target node is not a COMPONENT_SET (got ' + clean(node.type, 64) + ').');
      }
      set = node; resolution = 'node';
    } else {
      await figma.loadAllPagesAsync();
      const found = [];
      const stack = [...figma.root.children].reverse();
      let visited = 0;
      while (stack.length) {
        const node = stack.pop();
        visited++;
        if (visited > ${MAX_COMPONENT_ADD_VARIANT_SCAN_NODES}) {
          throw new Error('Component Set lookup exceeded the bounded node scan. Use node:<id>.');
        }
        if (node.type === 'COMPONENT_SET') {
          found.push(node);
          if (found.length > ${MAX_COMPONENT_ADD_VARIANT_SETS}) {
            throw new Error('Component Set lookup exceeded the bounded candidate count. Use node:<id>.');
          }
        }
        if ('children' in node && Array.isArray(node.children)) {
          for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
        }
      }
      let matches = found.filter((candidate) => candidate.name === reference.value);
      if (matches.length === 1) resolution = 'exact-name';
      if (matches.length === 0 && reference.kind === 'query') {
        matches = found.filter((candidate) => norm(candidate.name) === norm(reference.value));
        if (matches.length === 1) resolution = 'normalized-query';
      }
      if (matches.length === 0) throw new Error('No unique Component Set matched the requested reference.');
      if (matches.length > 1) throw new Error('Component Set reference is ambiguous. Use node:<id>.');
      set = matches[0];
    }
    if (!set || set.type !== 'COMPONENT_SET' || set.remote !== false) {
      throw new Error('Component Add Variant requires one local Component Set.');
    }
    if (!Array.isArray(set.children) || set.children.length < 1
      || set.children.length > ${MAX_COMPONENT_ADD_VARIANT_VARIANTS}) {
      throw new Error('Component Set has no variants or exceeds the bounded variant count.');
    }
    let axes;
    try { axes = set.variantGroupProperties; }
    catch { throw new Error('Component Set has conflicting or malformed Variant names.'); }
    if (!axes || typeof axes !== 'object' || Array.isArray(axes)) {
      throw new Error('Component Set returned invalid Variant axis metadata.');
    }
    const axisNames = Object.keys(axes);
    if (axisNames.length > ${MAX_COMPONENT_ADD_VARIANT_AXES}
      || axisNames.some((axis) => !axis || axis.length > ${MAX_COMPONENT_ADD_VARIANT_AXIS_CODE_UNITS})) {
      throw new Error('Component Set Variant axes exceed the bounded contract.');
    }
    const variants = set.children.map((node, index) => {
      if (!node || node.type !== 'COMPONENT' || node.remote !== false
        || node.parent?.id !== set.id || typeof node.id !== 'string'
        || typeof node.name !== 'string' || node.name.length > ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}
        || ![node.x, node.y, node.width, node.height].every(Number.isFinite)
        || node.width <= 0 || node.height <= 0) {
        throw new Error('Component Set contains an incompatible Variant member.');
      }
      return { id: node.id, name: node.name, pairs: __pairsFromName(node.name), node, index };
    });
    if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
      throw new Error('Component Set contains duplicate Variant identities.');
    }
    let source = null;
    if (fromName !== null) {
      let matches = variants.filter((variant) => variant.name === fromName);
      if (matches.length === 0) matches = variants.filter((variant) => norm(variant.name) === norm(fromName));
      if (matches.length !== 1) throw new Error('--from must resolve one exact Variant.');
      source = matches[0];
    } else {
      let defaultId = null;
      try { defaultId = set.defaultVariant?.id || null; } catch {}
      source = __nearest(variants, target, defaultId);
    }
    if (!source) throw new Error('Component Add Variant could not choose a clone source.');

    const finalPairs = {};
    for (const axis of [...Object.keys(source.pairs), ...Object.keys(target)]) {
      const sourceValue = Object.prototype.hasOwnProperty.call(target, axis)
        ? target[axis] : source.pairs[axis];
      Object.defineProperty(finalPairs, axis, {
        value: sourceValue, enumerable: true, configurable: true, writable: true,
      });
    }
    const order = axisNames.slice();
    for (const axis of Object.keys(target)) if (!order.includes(axis)) order.push(axis);
    for (const axis of Object.keys(finalPairs)) if (!order.includes(axis)) order.push(axis);
    const newName = order.filter((axis) => finalPairs[axis] !== undefined)
      .map((axis) => axis + '=' + finalPairs[axis]).join(', ');
    if (!newName || newName.length > ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) {
      throw new Error('Resulting Variant name exceeds the bounded Figma name contract.');
    }
    const canon = (pairs) => JSON.stringify(Object.keys(pairs).sort().map((axis) => [axis, pairs[axis]]));
    const wanted = canon(finalPairs);
    if (variants.some((variant) => canon(variant.pairs) === wanted)) {
      throw new Error('The requested Variant combination already exists.');
    }
    const createdAxes = Object.keys(target).filter((axis) => !axisNames.includes(axis));
    const setSizeBefore = { width: set.width, height: set.height };
    if (![setSizeBefore.width, setSizeBefore.height].every(Number.isFinite)
      || setSizeBefore.width <= 0 || setSizeBefore.height <= 0) {
      throw new Error('Component Set returned invalid geometry.');
    }
    const renamePlan = variants.map((variant) => {
      let after = variant.name;
      for (const axis of createdAxes) {
        const targetValue = String(target[axis]);
        const fill = targetValue === 'true' || targetValue === 'false' ? 'false' : 'Default';
        after += ', ' + axis + '=' + fill;
      }
      if (after.length > ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) {
        throw new Error('New-axis backfill would exceed a Variant name bound.');
      }
      return { id: variant.id, before: variant.name, after, node: variant.node };
    });

    let attemptedRenames = 0;
    let clone = null;
    let resizeAttempted = false;
    try {
      for (const entry of renamePlan) {
        if (entry.before === entry.after) continue;
        attemptedRenames++;
        entry.node.name = entry.after;
      }
      clone = source.node.clone();
      if (!clone || clone.type !== 'COMPONENT' || typeof clone.id !== 'string') {
        throw new Error('Component clone factory returned an incompatible node.');
      }
      clone.name = newName;
      set.appendChild(clone);
      try {
        if (!set.layoutMode || set.layoutMode === 'NONE') {
          let maxX = 0;
          for (const child of set.children) if (child !== clone) maxX = Math.max(maxX, child.x + child.width);
          clone.x = maxX + 20; clone.y = source.node.y;
          const neededWidth = Math.max(set.width, clone.x + clone.width);
          const neededHeight = Math.max(set.height, clone.y + clone.height);
          if (neededWidth > set.width || neededHeight > set.height) {
            resizeAttempted = true;
            set.resizeWithoutConstraints(neededWidth, neededHeight);
          }
        }
      } catch (error) {
        throw new Error('Component Set expansion failed: ' + (error?.message || 'unknown failure'));
      }
      delete globalThis.__invCache;

      const verifiedSet = await figma.getNodeByIdAsync(set.id);
      const verifiedClone = await figma.getNodeByIdAsync(clone.id);
      const expectedIds = [...variants.map((variant) => variant.id), clone.id];
      if (!verifiedSet || verifiedSet.type !== 'COMPONENT_SET' || verifiedSet.remote !== false
        || !Array.isArray(verifiedSet.children) || verifiedSet.children.length !== expectedIds.length
        || new Set(verifiedSet.children.map((child) => child.id)).size !== expectedIds.length
        || expectedIds.some((id) => !verifiedSet.children.some((child) => child.id === id))
        || !verifiedClone || verifiedClone.type !== 'COMPONENT'
        || verifiedClone.parent?.id !== verifiedSet.id || verifiedClone.name !== newName
        || ((!verifiedSet.layoutMode || verifiedSet.layoutMode === 'NONE')
          && (verifiedSet.width + 0.001 < verifiedClone.x + verifiedClone.width
            || verifiedSet.height + 0.001 < verifiedClone.y + verifiedClone.height))
        || renamePlan.some((entry) => {
          const child = verifiedSet.children.find((candidate) => candidate.id === entry.id);
          return !child || child.type !== 'COMPONENT' || child.parent?.id !== verifiedSet.id
            || child.name !== entry.after;
        })) {
        throw new Error('Component Add Variant fresh postcondition failed.');
      }
      const warnings = createdAxes.map((axis) => {
        const selected = String(target[axis]);
        const fill = selected === 'true' || selected === 'false' ? 'false' : 'Default';
        return 'Axis "' + axis + '" did not exist: every existing Variant now carries '
          + axis + '=' + fill + '. Rename those values if a different default fits.';
      });
      return bounded({
        schemaVersion: 1, status: 'created', resolution,
        set: { id: clean(verifiedSet.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
          name: clean(verifiedSet.name, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) },
        source: { id: clean(source.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
          name: clean(source.name, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) },
        variant: { id: clean(verifiedClone.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
          name: clean(verifiedClone.name, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) },
        createdAxes,
        renamed: renamePlan.filter((entry) => entry.before !== entry.after).map((entry) => ({
          id: clean(entry.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
          before: clean(entry.before, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}),
          after: clean(entry.after, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}),
        })),
        warnings, residue: [],
      });
    } catch (error) {
      let cloneRemoved = clone === null;
      if (clone) {
        try { clone.remove(); } catch {}
      }
      if (resizeAttempted) {
        try { set.resizeWithoutConstraints(setSizeBefore.width, setSizeBefore.height); } catch {}
      }
      let restoredRenames = 0;
      for (let index = renamePlan.length - 1; index >= 0; index--) {
        const entry = renamePlan[index];
        if (entry.before === entry.after) continue;
        try { entry.node.name = entry.before; } catch {}
      }
      const residue = { clone: [], renamed: [], setSize: [] };
      let verifiable = true;
      let sizeRestored = !resizeAttempted;
      try {
        const currentSet = await figma.getNodeByIdAsync(set.id);
        if (!currentSet || currentSet.type !== 'COMPONENT_SET' || !Array.isArray(currentSet.children)) {
          verifiable = false;
        } else {
          if (clone) {
            cloneRemoved = !currentSet.children.some((child) => child.id === clone.id);
            if (!cloneRemoved) residue.clone.push(clean(clone.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}));
          }
          if (resizeAttempted) {
            sizeRestored = Math.abs(currentSet.width - setSizeBefore.width) <= 0.001
              && Math.abs(currentSet.height - setSizeBefore.height) <= 0.001;
            if (!sizeRestored) residue.setSize.push({
              id: clean(currentSet.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
              beforeWidth: setSizeBefore.width,
              beforeHeight: setSizeBefore.height,
              actualWidth: currentSet.width,
              actualHeight: currentSet.height,
            });
          }
          for (const entry of renamePlan) {
            if (entry.before === entry.after) continue;
            const current = currentSet.children.find((child) => child.id === entry.id);
            if (current && current.name === entry.before) restoredRenames++;
            else residue.renamed.push({
              id: clean(entry.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
              before: clean(entry.before, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}),
              actual: clean(current?.name || '', ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}),
            });
          }
        }
      } catch { verifiable = false; }
      const outcome = !verifiable ? 'verification-unavailable'
        : residue.clone.length || residue.renamed.length || residue.setSize.length
          ? 'partial-residue' : 'rolled-back';
      return bounded({
        schemaVersion: 1, status: 'failed', outcome,
        set: { id: clean(set.id, ${MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS}),
          name: clean(set.name, ${MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS}) },
        attempted: { renames: attemptedRenames, clone: clone !== null, resize: resizeAttempted },
        restored: { renames: restoredRenames, cloneRemoved, size: sizeRestored },
        residue,
        failure: clean(error?.message || 'mutation failed', 1024),
      });
    }
    } catch (error) {
      return bounded({
        schemaVersion: 1,
        status: 'refused',
        outcome: 'no-mutation',
        failure: clean(error?.message || 'preflight refused', 1024),
      });
    }
  })()`;
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function validString(value, maximum, empty = true) {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (empty || value.length > 0) &&
    !UNSAFE.test(value)
  );
}

function validId(value) {
  return (
    validString(value, MAX_COMPONENT_ADD_VARIANT_ID_CODE_UNITS, false) &&
    NODE_ID.test(value)
  );
}

function validNode(value) {
  return (
    exactKeys(value, ["id", "name"]) &&
    validId(value.id) &&
    validString(value.name, MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS)
  );
}

function validRename(value) {
  return (
    exactKeys(value, ["id", "before", "after"]) &&
    validId(value.id) &&
    validString(value.before, MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS) &&
    validString(value.after, MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS)
  );
}

function validSuccess(value, input) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "resolution",
      "set",
      "source",
      "variant",
      "createdAxes",
      "renamed",
      "warnings",
      "residue",
    ]) ||
    value.schemaVersion !== 1 ||
    value.status !== "created" ||
    !["node", "exact-name", "normalized-query"].includes(value.resolution) ||
    !validNode(value.set) ||
    !validNode(value.source) ||
    !validNode(value.variant) ||
    value.source.id === value.variant.id ||
    (input.reference.kind === "node" &&
      (value.resolution !== "node" ||
        value.set.id !== input.reference.value)) ||
    !Array.isArray(value.createdAxes) ||
    value.createdAxes.length > MAX_COMPONENT_ADD_VARIANT_AXES ||
    value.createdAxes.some(
      (axis) =>
        !validString(axis, MAX_COMPONENT_ADD_VARIANT_AXIS_CODE_UNITS, false) ||
        !Object.hasOwn(input.pairs, axis)
    ) ||
    new Set(value.createdAxes).size !== value.createdAxes.length ||
    !Array.isArray(value.renamed) ||
    value.renamed.length > MAX_COMPONENT_ADD_VARIANT_VARIANTS ||
    value.renamed.some((entry) => !validRename(entry)) ||
    new Set(value.renamed.map((entry) => entry.id)).size !==
      value.renamed.length ||
    !Array.isArray(value.warnings) ||
    value.warnings.length !== value.createdAxes.length ||
    value.warnings.some((warning) => !validString(warning, 2048)) ||
    !Array.isArray(value.residue) ||
    value.residue.length !== 0
  )
    return false;
  const pairs = variantNamePairs(value.variant.name);
  return (
    Object.entries(input.pairs).every(
      ([axis, selected]) => pairs[axis] === selected
    ) &&
    (value.createdAxes.length === 0
      ? value.renamed.length === 0
      : value.renamed.length > 0)
  );
}

function validFailure(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "status",
      "outcome",
      "set",
      "attempted",
      "restored",
      "residue",
      "failure",
    ]) ||
    value.schemaVersion !== 1 ||
    value.status !== "failed" ||
    !["rolled-back", "partial-residue", "verification-unavailable"].includes(
      value.outcome
    ) ||
    !validNode(value.set) ||
    !exactKeys(value.attempted, ["renames", "clone", "resize"]) ||
    !Number.isSafeInteger(value.attempted.renames) ||
    value.attempted.renames < 0 ||
    value.attempted.renames > MAX_COMPONENT_ADD_VARIANT_VARIANTS ||
    typeof value.attempted.clone !== "boolean" ||
    typeof value.attempted.resize !== "boolean" ||
    !exactKeys(value.restored, ["renames", "cloneRemoved", "size"]) ||
    !Number.isSafeInteger(value.restored.renames) ||
    value.restored.renames < 0 ||
    value.restored.renames > value.attempted.renames ||
    typeof value.restored.cloneRemoved !== "boolean" ||
    typeof value.restored.size !== "boolean" ||
    !exactKeys(value.residue, ["clone", "renamed", "setSize"]) ||
    !Array.isArray(value.residue.clone) ||
    value.residue.clone.length > 1 ||
    value.residue.clone.some((id) => !validId(id)) ||
    !Array.isArray(value.residue.renamed) ||
    value.residue.renamed.length > MAX_COMPONENT_ADD_VARIANT_VARIANTS ||
    value.residue.renamed.some(
      (entry) =>
        !exactKeys(entry, ["id", "before", "actual"]) ||
        !validId(entry.id) ||
        !validString(entry.before, MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS) ||
        !validString(entry.actual, MAX_COMPONENT_ADD_VARIANT_NAME_CODE_UNITS)
    ) ||
    !Array.isArray(value.residue.setSize) ||
    value.residue.setSize.length > 1 ||
    value.residue.setSize.some(
      (entry) =>
        !exactKeys(entry, [
          "id",
          "beforeWidth",
          "beforeHeight",
          "actualWidth",
          "actualHeight",
        ]) ||
        !validId(entry.id) ||
        ![
          entry.beforeWidth,
          entry.beforeHeight,
          entry.actualWidth,
          entry.actualHeight,
        ].every((number) => Number.isFinite(number) && number > 0)
    ) ||
    !validString(value.failure, 1024, false)
  )
    return false;
  const residueCount =
    value.residue.clone.length +
    value.residue.renamed.length +
    value.residue.setSize.length;
  if (value.outcome === "rolled-back") {
    return (
      residueCount === 0 &&
      value.restored.renames === value.attempted.renames &&
      value.restored.cloneRemoved &&
      value.restored.size
    );
  }
  if (value.outcome === "partial-residue") return residueCount > 0;
  return true;
}

function validRefusal(value) {
  return (
    exactKeys(value, ["schemaVersion", "status", "outcome", "failure"]) &&
    value.schemaVersion === 1 &&
    value.status === "refused" &&
    value.outcome === "no-mutation" &&
    validString(value.failure, 1024, false)
  );
}

function safePrettyJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function formatComponentAddVariantResult(result, { json = false } = {}) {
  if (json) return safePrettyJson(result);
  const lines = [
    `Added variant ${JSON.stringify(result.variant.name)} to ${JSON.stringify(result.set.name)} ` +
      `(${result.variant.id}), cloned from ${JSON.stringify(result.source.name)}`,
  ];
  for (const warning of result.warnings) lines.push(`  ⚠ ${warning}`);
  lines.push(`  Now edit only what differs on ${result.variant.id}.`);
  return lines.join("\n");
}

export async function executeComponentAddVariant(request, adapters = {}) {
  if (typeof adapters.evaluate !== "function") {
    throw new TypeError(
      "Component Add Variant requires a Figma evaluate adapter."
    );
  }
  const input = normalizedRequest(request);
  const serialized = await adapters.evaluate(componentAddVariantCode(input));
  if (
    typeof serialized !== "string" ||
    serialized.length > MAX_COMPONENT_ADD_VARIANT_SERIALIZED_CODE_UNITS
  ) {
    const error = new Error(
      "Component Add Variant returned an invalid bounded result."
    );
    error.kind = "plugin-result";
    error.phase = "plugin-response";
    error.outcome = "unknown-after-dispatch";
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new Error("Component Add Variant returned invalid JSON.");
  }
  if (payload?.status === "refused") {
    if (!validRefusal(payload)) {
      throw new Error(
        "Component Add Variant returned an invalid bounded result."
      );
    }
    const error = new Error(
      `Component Add Variant made no mutation: ${payload.failure}`
    );
    error.kind = "execution";
    error.phase = "plugin-execution";
    error.outcome = "unknown-after-dispatch";
    error.dispatchState = "failed";
    error.mutationOutcome = "no-mutation";
    error.mutationReport = {
      version: 1,
      outcome: "no-mutation",
      attempted: 0,
      restored: 0,
      residueCount: 0,
    };
    throw error;
  }
  if (payload?.status === "failed") {
    if (!validFailure(payload))
      throw new Error(
        "Component Add Variant returned an invalid bounded result."
      );
    const residueCount =
      payload.residue.clone.length +
      payload.residue.renamed.length +
      payload.residue.setSize.length;
    const error = new Error(
      payload.outcome === "rolled-back"
        ? `Component Add Variant failed and restored the prior Component Set: ${payload.failure}`
        : `Component Add Variant failed; ${residueCount} Component mutation(s) may remain: ${payload.failure}`
    );
    error.kind = "execution";
    error.phase = "plugin-execution";
    error.outcome = "unknown-after-dispatch";
    error.dispatchState = "failed";
    error.mutationOutcome = payload.outcome;
    error.mutationReport = {
      version: 1,
      outcome: payload.outcome,
      attempted:
        payload.attempted.renames +
        (payload.attempted.clone ? 1 : 0) +
        (payload.attempted.resize ? 1 : 0),
      restored:
        payload.restored.renames +
        (payload.attempted.clone && payload.restored.cloneRemoved ? 1 : 0) +
        (payload.attempted.resize && payload.restored.size ? 1 : 0),
      residueCount,
    };
    throw error;
  }
  if (!validSuccess(payload, input)) {
    const error = new Error(
      "Component Add Variant returned an invalid bounded result."
    );
    error.kind = "plugin-result";
    error.phase = "plugin-response";
    error.outcome = "unknown-after-dispatch";
    throw error;
  }
  return {
    stdout: formatComponentAddVariantResult(payload, { json: input.json }),
    stderr: "",
    result: payload,
  };
}

export function componentAddVariantPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Component Add Variant routing requires a Command Plan created by the Capability Catalog."
    );
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? "command-application"
    : "not-component-add-variant";
}

export async function executeComponentAddVariantPlan(plan, adapters = {}) {
  if (componentAddVariantPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by Component Add Variant.`
    );
  }
  return executeComponentAddVariant(
    parseComponentSetReferenceRequest(plan.argv),
    adapters
  );
}
