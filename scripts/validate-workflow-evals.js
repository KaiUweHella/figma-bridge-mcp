#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEHAVIORS = new Set([
  "bounded-figma-reads",
  "source-assets",
  "project-stack",
  "pixel-verify",
  "design-entity-reconcile",
  "dom-capture",
  "token-bindings",
  "component-reuse",
  "sequential-figma-writes",
  "component-properties",
  "variant-cap",
  "no-browser-install",
]);

function skillNames(root) {
  return new Set(readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
}

export function validateWorkflowEvals(suite, skills) {
  const errors = [];
  if (suite.version !== 1) errors.push("suite.version must be 1");
  if (!Array.isArray(suite.positive) || suite.positive.length < 5) {
    errors.push("suite needs at least five positive cases");
  }
  if (!Array.isArray(suite.negative) || suite.negative.length < 3) {
    errors.push("suite needs at least three negative cases");
  }

  const positive = Array.isArray(suite.positive) ? suite.positive : [];
  const negative = Array.isArray(suite.negative) ? suite.negative : [];
  const cases = [...positive, ...negative];
  const ids = new Set();

  for (const item of cases) {
    if (typeof item.id !== "string" || !item.id) errors.push("every case needs an id");
    else if (ids.has(item.id)) errors.push(`duplicate case id: ${item.id}`);
    else ids.add(item.id);
    if (typeof item.prompt !== "string" || item.prompt.length < 20) {
      errors.push(`${item.id || "unknown"}: prompt is missing or too short`);
    }
    if (item.expectedSkill !== null && !skills.has(item.expectedSkill)) {
      errors.push(`${item.id}: unknown expectedSkill ${item.expectedSkill}`);
    }
    if (!Array.isArray(item.forbiddenSkills)) {
      errors.push(`${item.id}: forbiddenSkills must be an array`);
    } else {
      for (const name of item.forbiddenSkills) {
        if (!skills.has(name)) errors.push(`${item.id}: unknown forbidden skill ${name}`);
        if (name === item.expectedSkill) errors.push(`${item.id}: expected skill is also forbidden`);
      }
    }
  }

  for (const item of positive) {
    if (typeof item.expectedSkill !== "string") {
      errors.push(`${item.id}: positive case needs expectedSkill`);
    }
    if (!Array.isArray(item.expectations) || item.expectations.length === 0) {
      errors.push(`${item.id}: positive case needs expectations`);
    } else {
      for (const behavior of item.expectations) {
        if (!BEHAVIORS.has(behavior)) errors.push(`${item.id}: unknown expectation ${behavior}`);
      }
    }
  }

  for (const item of negative) {
    if (item.expectedSkill !== null) errors.push(`${item.id}: negative case must expect no workflow skill`);
    if (typeof item.reason !== "string" || !item.reason) errors.push(`${item.id}: negative case needs a reason`);
  }

  for (const skill of skills) {
    if (!positive.some((item) => item.expectedSkill === skill)) {
      errors.push(`no positive routing case covers ${skill}`);
    }
  }

  return errors;
}

export function loadAndValidateWorkflowEvals(root = ROOT) {
  const path = join(root, "evals", "workflow-routing.json");
  const suite = JSON.parse(readFileSync(path, "utf8"));
  const skills = skillNames(root);
  const errors = validateWorkflowEvals(suite, skills);
  if (errors.length) throw new Error(`Workflow eval validation failed:\n- ${errors.join("\n- ")}`);
  return { suite, skills };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { suite } = loadAndValidateWorkflowEvals();
    console.log(
      `Workflow evals valid: ${suite.positive.length} positive, ${suite.negative.length} negative.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
