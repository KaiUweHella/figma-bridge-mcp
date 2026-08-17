import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadAndValidateWorkflowEvals,
  validateWorkflowEvals,
} from "../scripts/validate-workflow-evals.js";

test("workflow routing suite covers every skill and negative non-build intents", () => {
  const { suite, skills } = loadAndValidateWorkflowEvals();
  assert.ok(suite.positive.length >= 5);
  assert.ok(suite.negative.length >= 3);
  assert.deepEqual(
    new Set(suite.positive.map((item) => item.expectedSkill)),
    skills,
  );
  assert.ok(suite.positive.some((item) => /Implementiere|Übertrage|Erstelle/.test(item.prompt)),
    "routing cases should cover the maintainer's German usage language");
  assert.ok(suite.negative.every((item) => item.expectedSkill === null));
});

test("workflow eval validator rejects unknown skills and missing behavior checks", () => {
  const errors = validateWorkflowEvals({
    version: 1,
    positive: Array.from({ length: 5 }, (_, index) => ({
      id: `positive-${index}`,
      prompt: "Create a sufficiently descriptive Figma workflow prompt.",
      expectedSkill: index === 0 ? "missing-skill" : "known-skill",
      forbiddenSkills: [],
      expectations: [],
    })),
    negative: Array.from({ length: 3 }, (_, index) => ({
      id: `negative-${index}`,
      prompt: "Perform a sufficiently descriptive non-workflow operation.",
      expectedSkill: null,
      forbiddenSkills: ["known-skill"],
      reason: "No workflow should run.",
    })),
  }, new Set(["known-skill"]));

  assert.ok(errors.some((error) => /unknown expectedSkill missing-skill/.test(error)));
  assert.ok(errors.some((error) => /positive-0: positive case needs expectations/.test(error)));
});
