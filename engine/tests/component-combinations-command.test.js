import assert from "node:assert/strict";
import test from "node:test";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  componentCombinationsCode,
  componentCombinationsPlanRoute,
  executeComponentCombinations,
  executeComponentCombinationsPlan,
} from "../src/application/component-combinations-command.js";
import { parseComponentCombinationsRequest } from "../src/application/component-combinations-request.js";

function fixture({
  failSet = 0,
  ignoreSet = false,
  retainRemovedHandles = false,
} = {}) {
  const registry = new Map();
  let next = 10;
  let setCalls = 0;
  const detach = (node) => {
    const index = node.parent?.children?.indexOf(node) ?? -1;
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  };
  const page = {
    id: "0:1",
    type: "PAGE",
    name: "Test",
    children: [],
    selection: [],
    appendChild(node) {
      detach(node);
      this.children.push(node);
      node.parent = this;
    },
  };
  registry.set(page.id, page);
  const removable = (node) =>
    Object.assign(node, {
      remove() {
        detach(this);
        if (!retainRemovedHandles) registry.delete(this.id);
      },
    });
  const componentSet = removable({
    id: "1:1",
    type: "COMPONENT_SET",
    name: "Button",
    width: 100,
    height: 40,
    x: 0,
    y: 0,
    parent: null,
    children: [],
    componentPropertyDefinitions: {
      State: { type: "VARIANT", variantOptions: ["Default", "Hover"] },
      Enabled: { type: "BOOLEAN" },
    },
  });
  const variant = removable({
    id: "1:2",
    type: "COMPONENT",
    name: "State=Default",
    width: 100,
    height: 40,
    x: 0,
    y: 0,
    parent: componentSet,
    children: [],
    createInstance() {
      const instance = removable({
        id: `9:${next++}`,
        type: "INSTANCE",
        name: "Instance",
        width: 100,
        height: 40,
        x: 0,
        y: 0,
        parent: null,
        children: [],
        componentProperties: {
          State: { type: "VARIANT", value: "Default" },
          Enabled: { type: "BOOLEAN", value: true },
        },
        setProperties(values) {
          setCalls++;
          if (setCalls === failSet) throw new Error("injected set failure");
          if (ignoreSet) return;
          for (const [key, value] of Object.entries(values)) {
            if (this.componentProperties[key]) {
              this.componentProperties[key].value = value;
            }
          }
        },
        detachInstance() {
          this.type = "FRAME";
          return this;
        },
      });
      registry.set(instance.id, instance);
      page.appendChild(instance);
      return instance;
    },
  });
  componentSet.children.push(variant);
  componentSet.defaultVariant = variant;
  registry.set(componentSet.id, componentSet);
  registry.set(variant.id, variant);
  page.appendChild(componentSet);
  page.selection = [componentSet];
  const figma = {
    currentPage: page,
    getNodeByIdAsync: async (id) => registry.get(id) || null,
    loadFontAsync: async () => {},
    createText() {
      const label = removable({
        id: `9:${next++}`,
        type: "TEXT",
        name: "",
        width: 20,
        height: 10,
        x: 0,
        y: 0,
        parent: null,
        children: [],
        characters: "",
        fontName: null,
        fontSize: 0,
        fills: [],
      });
      registry.set(label.id, label);
      page.appendChild(label);
      return label;
    },
    createComponentFromNode(node) {
      node.type = "COMPONENT";
      return node;
    },
    viewport: { scrollAndZoomIntoView() {} },
  };
  return { figma, page, componentSet };
}

const evaluate = (figma) => async (code) =>
  new Function("figma", `return ${code};`)(figma);

test("Component Combinations request is closed, canonical, and URL-targeted", () => {
  const url = "https://www.figma.com/design/FILE/Test?node-id=1-1";
  assert.deepEqual(
    parseComponentCombinationsRequest([
      "combos",
      "--dry-run",
      url,
      "-g=-8",
      "--no-labels",
    ]),
    {
      nodeId: "1:1",
      gap: -8,
      labels: false,
      includeBoolean: true,
      dryRun: true,
    }
  );
  for (const args of [
    ["combos", "bad"],
    ["combos", "1:1", "2:2"],
    ["combos", "--gap", "1.5"],
    ["combos", "--dry-run", "--dry-run"],
    ["combos", "--future"],
  ])
    assert.throws(
      () => parseComponentCombinationsRequest(args),
      /Invalid combos command/
    );
  const plan = planFigmaCommand(["combos", url, "--no-boolean"], {
    adapter: "mcp",
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.target.fileKey, "FILE");
  assert.deepEqual(plan.argv, ["combos", "1:1", "--no-boolean"]);
});

test("dry run returns bounded facts without creating nodes", async () => {
  const live = fixture();
  const output = await executeComponentCombinations(
    { nodeId: "1:1", dryRun: true },
    {
      evaluate: evaluate(live.figma),
    }
  );
  assert.equal(output.result.status, "analyzed");
  assert.equal(output.result.analysis.totalCombinations, 4);
  assert.match(output.stdout, /Properties:\n  State: Default, Hover/);
  assert.match(output.stdout, /Would create 4 components/);
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
});

test("write creates every combination and freshly verifies the labeled grid", async () => {
  const live = fixture();
  const output = await executeComponentCombinations(
    { nodeId: "1:1" },
    {
      evaluate: evaluate(live.figma),
    }
  );
  assert.equal(output.result.status, "created");
  assert.equal(output.result.count, 4);
  assert.equal(output.result.labelCount, 4);
  assert.equal(output.result.gridSize, "2x2");
  assert.equal(live.page.children.length, 9);
  assert.match(
    output.stdout,
    /^Created 4 components in 2x2 grid with 4 labels/
  );
  assert.equal(
    live.page.children.find(
      (node) => node.type === "TEXT" && node.characters === "Default"
    ).x,
    300,
    "row labels preserve the legacy left edge"
  );
});

test("a silent property setter cannot produce mislabeled default visuals", async () => {
  const live = fixture({ ignoreSet: true, retainRemovedHandles: true });
  await assert.rejects(
    () =>
      executeComponentCombinations(
        { nodeId: "1:1" },
        { evaluate: evaluate(live.figma) }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.equal(error.mutationReport.residueCount, 0);
      assert.match(error.message, /property postcondition failed/);
      return true;
    }
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
});

test("a failed combination removes labels and every intermediate node", async () => {
  const live = fixture({ failSet: 2, retainRemovedHandles: true });
  await assert.rejects(
    () =>
      executeComponentCombinations(
        { nodeId: "1:1" },
        {
          evaluate: evaluate(live.figma),
        }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.equal(error.mutationReport.residueCount, 0);
      return true;
    }
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
});

test("one authentic Plan crosses the shared Application seam", async () => {
  const plan = planFigmaCommand(["combos", "1:1", "--no-labels"], {
    adapter: "mcp",
  });
  assert.equal(componentCombinationsPlanRoute(plan), "command-application");
  const live = fixture();
  const output = await executeComponentCombinationsPlan(plan, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(output.result.count, 4);
  assert.equal(output.result.labelCount, 0);
  assert.doesNotThrow(
    () =>
      new Function(
        "figma",
        `return ${componentCombinationsCode({ nodeId: "1:1" })};`
      )
  );

  const dryPlan = planFigmaCommand(["combos", "1:1", "--dry-run"], {
    adapter: "mcp",
  });
  assert.equal(dryPlan.effects.figma, "read");
  assert.equal(dryPlan.confirmation, "none");
  assert.equal(dryPlan.execution.retry, "safe-read");
});

test("malformed Plugin facts never become a successful grid", async () => {
  for (const value of [
    null,
    {},
    "bad-json",
    JSON.stringify({
      status: "analyzed",
      analysis: { totalCombinations: 4, rows: 2, cols: 2, properties: [] },
    }),
    JSON.stringify({
      status: "created",
      analysis: {
        componentSetId: "1:1",
        componentSetName: "Button",
        properties: [{ name: "State", type: "VARIANT", options: ["Default"] }],
        totalCombinations: 1,
        rows: 1,
        cols: 1,
        instanceSize: { width: 100, height: 40 },
      },
      count: 1,
      labelCount: 0,
      gridSize: "not-a-grid",
      components: [],
      warnings: [],
    }),
    JSON.stringify({
      schemaVersion: 1,
      status: "analyzed",
      analysis: {
        componentSetId: "1:1",
        componentSetName: "Button",
        properties: [
          { name: "State", type: "VARIANT", options: ["Default", "Hover"] },
          { name: "Size", type: "VARIANT", options: ["Small", "Large"] },
        ],
        totalCombinations: 4,
        rows: 1,
        cols: 4,
        instanceSize: { width: 100, height: 40 },
      },
    }),
    JSON.stringify({
      schemaVersion: 1,
      status: "analyzed",
      analysis: {
        componentSetId: "1:1",
        componentSetName: "B".repeat(512),
        properties: [{ name: "State", type: "VARIANT", options: ["Default"] }],
        totalCombinations: 1,
        rows: 1,
        cols: 1,
        instanceSize: { width: 100, height: 40 },
      },
    }),
    JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      outcome: "rolled-back",
      attempted: 1,
      restored: 0,
      residue: {
        residueIds: [],
        pageChanged: false,
        selectionChanged: false,
      },
      failure: "forged rollback",
    }),
  ]) {
    await assert.rejects(
      () =>
        executeComponentCombinations(
          { nodeId: "1:1", dryRun: true },
          { evaluate: async () => value }
        ),
      /invalid bounded result|invalid JSON|invalid analysis|invalid creation|invalid dry-run|invalid failure/
    );
  }
});

test("unsafe or excessive option text refuses before document mutation", async () => {
  const live = fixture();
  live.componentSet.componentPropertyDefinitions.State.variantOptions = [
    "Default",
    `Hover\u001b[2J`,
  ];
  await assert.rejects(
    () =>
      executeComponentCombinations(
        { nodeId: "1:1", dryRun: true },
        { evaluate: evaluate(live.figma) }
      ),
    (error) => error.mutationOutcome === "no-mutation"
  );
  assert.deepEqual(
    live.page.children.map((node) => node.id),
    ["1:1"]
  );
});
