import assert from "node:assert/strict";
import test from "node:test";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  executeVariableUpdateBatch,
  executeVariableUpdateBatchPlan,
  variableUpdateBatchCommandCode,
  variableUpdateBatchPlanRoute,
} from "../src/application/variable-update-batch-command.js";
import {
  acceptsVariableUpdateBatchArgv,
  MAX_VARIABLE_UPDATE_BATCH_ITEMS,
  parseVariableUpdateBatchRequest,
  variableUpdateBatchArgvFromRequest,
} from "../src/application/variable-update-batch-request.js";

function fixture({
  count = 4,
  publishFailsFor = null,
  restoreFailsFor = null,
  invalidSyntaxFor = null,
  duplicateAlias = false,
} = {}) {
  const mode = { modeId: "ModeId:default", name: "Mode 1" };
  const collection = {
    id: "VariableCollectionId:1",
    name: "Tokens",
    remote: false,
    modes: [mode],
  };
  const writes = [];
  const variables = Array.from({ length: count }, (_, index) => {
    let description = `Old ${index}`;
    let descriptionWrites = 0;
    let publishCalls = 0;
    const variable = {
      id: `VariableID:${index + 1}`,
      key: `variable-key-${index + 1}`,
      name: `space/${index + 1}`,
      resolvedType: "FLOAT",
      remote: false,
      variableCollectionId: collection.id,
      hiddenFromPublishing: false,
      scopes: ["ALL_SCOPES"],
      codeSyntax: invalidSyntaxFor === index ? { FUTURE: "unsupported" } : {},
      valuesByMode: { [mode.modeId]: index + 1 },
      async getPublishStatusAsync() {
        publishCalls++;
        if (publishFailsFor === index && publishCalls > 1)
          throw new Error("publish failed");
        return "CURRENT";
      },
    };
    Object.defineProperty(variable, "description", {
      enumerable: true,
      get: () => description,
      set(value) {
        descriptionWrites++;
        writes.push(`${index}:${value}`);
        if (restoreFailsFor === index && descriptionWrites > 1)
          throw new Error("restore failed");
        description = value;
      },
    });
    return variable;
  });
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () =>
        duplicateAlias ? [...variables, { ...variables[0] }] : variables,
    },
  };
  return { collection, figma, variables, writes };
}

const fourDescriptions = () => ({
  items: Array.from({ length: 4 }, (_, index) => ({
    variable: `space/${index + 1}`,
    collection: "Tokens",
    description: `New ${index}`,
  })),
});

async function runCode(request, figma) {
  return new Function(
    "figma",
    `return ${variableUpdateBatchCommandCode(request)};`
  )(figma);
}

test("Variable Metadata Update Batch closes and canonicalizes a bounded typed item list", () => {
  const request = {
    items: [
      {
        variable: "space/1",
        collection: "Tokens",
        description: "",
        hidden: false,
      },
      { variable: "space/2", name: "space/lg", scopes: ["gap", "font_size"] },
    ],
  };
  const argv = variableUpdateBatchArgvFromRequest(request);
  assert.deepEqual(parseVariableUpdateBatchRequest(argv), {
    items: [
      {
        variable: "space/1",
        collection: "Tokens",
        description: "",
        hidden: false,
      },
      {
        variable: "space/2",
        collection: null,
        name: "space/lg",
        scopes: ["GAP", "FONT_SIZE"],
      },
    ],
  });
  for (const args of [
    ["var", "update-batch", "[]"],
    ["var", "update-batch", '[{"variable":"x","future":true}]'],
    ["var", "update-batch", '[{"variable":"x"}]'],
    ["var", "update-batch", '[{"variable":"x","hidden":"true"}]'],
    ["var", "update-batch", '[{"variable":"x","scopes":["ALL_SCOPES","GAP"]}]'],
    [
      "var",
      "update-batch",
      '[{"variable":"x","description":"a"},{"variable":"x","description":"b"}]',
    ],
    ["var", "update-batch", "--future", "private-value"],
  ])
    assert.equal(acceptsVariableUpdateBatchArgv(args), false, args.join(" "));
  assert.throws(
    () =>
      variableUpdateBatchArgvFromRequest({
        items: Array.from(
          { length: MAX_VARIABLE_UPDATE_BATCH_ITEMS + 1 },
          (_, index) => ({
            variable: `space/${index}`,
            description: "x",
          })
        ),
      }),
    /at most/
  );
});

test("Variable Metadata Update Batch preflights every target before its first write", async () => {
  const invalid = fixture({ invalidSyntaxFor: 3 });
  await assert.rejects(
    () => runCode(fourDescriptions(), invalid.figma),
    /preflight metadata/
  );
  assert.equal(invalid.writes.length, 0);

  const incompatible = fixture();
  incompatible.variables[3].resolvedType = "COLOR";
  const incompatibleRequest = fourDescriptions();
  incompatibleRequest.items[3] = { variable: "space/4", scopes: ["GAP"] };
  await assert.rejects(
    () => runCode(incompatibleRequest, incompatible.figma),
    /Variable .* scopes.*incompatible with COLOR/
  );
  assert.equal(incompatible.writes.length, 0);

  const duplicate = fixture();
  await assert.rejects(
    () =>
      runCode(
        {
          items: [
            { variable: "VariableID:1", description: "One" },
            { variable: "space/1", description: "Two" },
          ],
        },
        duplicate.figma
      ),
    /duplicate target/
  );
  assert.equal(duplicate.writes.length, 0);

  const remote = fixture();
  remote.variables[3].remote = true;
  await assert.rejects(
    () => runCode(fourDescriptions(), remote.figma),
    /remote Variables/
  );
  assert.equal(remote.writes.length, 0);

  const missing = fixture();
  const missingRequest = fourDescriptions();
  missingRequest.items[3].variable = "space/missing";
  await assert.rejects(
    () => runCode(missingRequest, missing.figma),
    /Variable not found/
  );
  assert.equal(missing.writes.length, 0);

  const ambiguous = fixture();
  ambiguous.variables[1].name = "space/1";
  await assert.rejects(
    () => runCode(fourDescriptions(), ambiguous.figma),
    /Variable is ambiguous/
  );
  assert.equal(ambiguous.writes.length, 0);
});

test("Variable Metadata Update Batch updates and verifies four Variables in one execution", async () => {
  const state = fixture();
  const request = fourDescriptions();
  const serialized = await runCode(request, state.figma);
  const result = await executeVariableUpdateBatch(request, {
    evaluate: async () => serialized,
  });
  assert.equal(result.stdout, "Updated 4 variables");
  assert.equal(result.result.outcome, "committed");
  assert.deepEqual(
    state.variables.map((variable) => variable.description),
    ["New 0", "New 1", "New 2", "New 3"]
  );
  assert.equal(result.result.attempted.length, 4);
  assert.equal(result.result.confirmed.length, 4);
  assert.equal(result.result.restored.length, 0);
  assert.equal(result.result.residual.length, 0);
});

test("Variable Metadata Update Batch restores attempted Variables in reverse after a later failure", async () => {
  const state = fixture({ publishFailsFor: 1 });
  const request = fourDescriptions();
  const serialized = await runCode(request, state.figma);
  assert.deepEqual(
    state.variables.map((variable) => variable.description),
    ["Old 0", "Old 1", "Old 2", "Old 3"]
  );
  assert.deepEqual(state.writes, ["0:New 0", "1:New 1", "1:Old 1", "0:Old 0"]);
  await assert.rejects(
    () =>
      executeVariableUpdateBatch(request, { evaluate: async () => serialized }),
    (error) =>
      error.mutationOutcome === "rolled-back" &&
      error.variableUpdateBatchMutationReport.attempted === 2 &&
      error.variableUpdateBatchMutationReport.confirmed === 1 &&
      error.variableUpdateBatchMutationReport.restored === 2 &&
      error.variableUpdateBatchMutationReport.residual === 0
  );
});

test("Variable Metadata Update Batch reports exact residual identities after restore failure", async () => {
  const state = fixture({ publishFailsFor: 1, restoreFailsFor: 0 });
  const request = fourDescriptions();
  const serialized = await runCode(request, state.figma);
  await assert.rejects(
    () =>
      executeVariableUpdateBatch(request, { evaluate: async () => serialized }),
    (error) =>
      error.mutationOutcome === "partial-residue" &&
      error.variableUpdateBatchMutationReport.restored === 1 &&
      error.variableUpdateBatchMutationReport.residual === 1 &&
      error.variableUpdateBatchMutationReport.restoreFailures[0].fields[0] ===
        "description"
  );
});

test("Variable Metadata Update Batch rejects forged output and accepts only its authentic Plan", async () => {
  const request = fourDescriptions();
  await assert.rejects(
    () => executeVariableUpdateBatch(request, { evaluate: async () => "{}" }),
    /invalid bounded result/
  );
  const cli = planFigmaCommand(variableUpdateBatchArgvFromRequest(request), {
    adapter: "cli",
  });
  const mcp = planFigmaCommand(variableUpdateBatchArgvFromRequest(request), {
    adapter: "mcp",
  });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, "never");
  assert.equal(cli.confirmation, "configured");
  assert.equal(variableUpdateBatchPlanRoute(cli), "command-application");
  const state = fixture();
  const serialized = await runCode(request, state.figma);
  assert.equal(
    (
      await executeVariableUpdateBatchPlan(cli, {
        evaluate: async () => serialized,
      })
    ).result.confirmed.length,
    4
  );
  await assert.rejects(
    () =>
      executeVariableUpdateBatchPlan(
        { ...cli },
        { evaluate: async () => serialized }
      ),
    /requires a Command Plan created by the Capability Catalog/
  );
  assert.equal(
    variableUpdateBatchPlanRoute(planFigmaCommand(["var", "show", "space/1"])),
    "not-variable-update-batch"
  );
});
