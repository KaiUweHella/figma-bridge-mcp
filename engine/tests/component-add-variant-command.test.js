import assert from "node:assert/strict";
import test from "node:test";
import { planFigmaCommand } from "../../src/capability-catalog.js";
import {
  componentAddVariantCode,
  componentAddVariantPlanRoute,
  executeComponentAddVariant,
  executeComponentAddVariantPlan,
} from "../src/application/component-add-variant-command.js";

function fixture({
  appendThrows = false,
  duplicateSet = false,
  resizeThrowsOnce = false,
} = {}) {
  let next = 10;
  let resizeCalls = 0;
  const nodes = new Map();
  const page = { id: "1:1", type: "PAGE", name: "Test", children: [] };
  const set = {
    id: "2:1",
    type: "COMPONENT_SET",
    name: "Button",
    remote: false,
    parent: page,
    children: [],
    layoutMode: "NONE",
    width: 220,
    height: 40,
    get variantGroupProperties() {
      return {
        State: {
          type: "VARIANT",
          values: this.children.map((child) => child.name.split("=")[1]),
        },
      };
    },
    appendChild(child) {
      if (!this.children.includes(child)) this.children.push(child);
      child.parent = this;
      if (appendThrows)
        throw new Error("injected append failure after mutation");
    },
    resizeWithoutConstraints(width, height) {
      resizeCalls++;
      this.width = width;
      this.height = height;
      if (resizeThrowsOnce && resizeCalls === 1)
        throw new Error("injected resize failure after mutation");
    },
  };
  nodes.set(set.id, set);
  page.children.push(set);
  const cloneDescendant = (source, parent) => {
    const copy = {
      ...source,
      id: `2:${next++}`,
      parent,
    };
    // Model the live Figma behavior that motivated this regression: native
    // clone preserves structure but drops per-layer Component Property refs.
    delete copy.componentPropertyReferences;
    if (Array.isArray(source.children)) {
      copy.children = source.children.map((child) => cloneDescendant(child, copy));
    }
    return copy;
  };
  const makeComponent = (name, id = `2:${next++}`) => {
    const component = {
      id,
      type: "COMPONENT",
      remote: false,
      parent: set,
      name,
      x: set.children.length * 120,
      y: 0,
      width: 100,
      height: 40,
      children: [],
      clone() {
        const clone = makeComponent(this.name);
        clone.x = this.x;
        clone.y = this.y;
        clone.width = this.width;
        clone.height = this.height;
        clone.children = this.children.map((child) => cloneDescendant(child, clone));
        set.children = set.children.filter((child) => child !== clone);
        clone.parent = null;
        return clone;
      },
      remove() {
        set.children = set.children.filter((child) => child !== this);
        nodes.delete(this.id);
        this.parent = null;
      },
    };
    nodes.set(id, component);
    set.children.push(component);
    return component;
  };
  const normal = makeComponent("State=Default", "2:2");
  const pressed = makeComponent("State=Pressed", "2:3");
  set.defaultVariant = normal;
  if (duplicateSet) {
    const second = { ...set, id: "3:1", children: [], parent: page };
    second.name = "Button";
    page.children.push(second);
    nodes.set(second.id, second);
  }
  const figma = {
    root: { children: [page] },
    loadAllPagesAsync: async () => {},
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
  };
  return { figma, set, nodes, normal, pressed };
}

const evaluate = (figma) => async (code) =>
  new Function("figma", `return ${code};`)(figma);

test("Component Add Variant code is valid and creates an existing-axis Variant", async () => {
  const live = fixture();
  const request = {
    reference: { kind: "node", value: live.set.id },
    pairs: { State: "Hover" },
    fromName: null,
    json: false,
  };
  assert.doesNotThrow(() => new Function(componentAddVariantCode(request)));
  const result = await executeComponentAddVariant(request, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, "created");
  assert.equal(result.result.source.id, live.normal.id);
  assert.equal(result.result.variant.name, "State=Hover");
  assert.deepEqual(result.result.createdAxes, []);
  assert.deepEqual(result.result.renamed, []);
  assert.equal(live.set.children.length, 3);
  assert.equal(live.set.width, 340);
});

test("a quoted payload cannot break out of the eval", async () => {
  const live = fixture();
  const axis = 'a"); figma.closePlugin(); //';
  const selected = "c`d\\e";
  const request = {
    reference: { kind: "node", value: live.set.id },
    pairs: Object.fromEntries([[axis, selected]]),
    fromName: null,
    json: false,
  };
  const code = componentAddVariantCode(request);
  assert.doesNotThrow(() => new Function(code));
  const result = await executeComponentAddVariant(request, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(result.result.createdAxes, [axis]);
  assert.equal(
    result.result.variant.name,
    `State=Default, ${axis}=${selected}`
  );
});

test("magic axis names retain own-property semantics", async () => {
  const live = fixture();
  const request = {
    reference: { kind: "node", value: live.set.id },
    pairs: Object.fromEntries([["__proto__", "Custom"]]),
    fromName: null,
    json: false,
  };
  const result = await executeComponentAddVariant(request, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(result.result.createdAxes, ["__proto__"]);
  assert.equal(result.result.variant.name, "State=Default, __proto__=Custom");
});

test("new-axis creation backfills every existing Variant and reports the warning", async () => {
  const live = fixture();
  const result = await executeComponentAddVariant(
    {
      reference: { kind: "node", value: live.set.id },
      pairs: { Tone: "Brand" },
      fromName: "State=Pressed",
      json: true,
    },
    { evaluate: evaluate(live.figma) }
  );
  assert.deepEqual(result.result.createdAxes, ["Tone"]);
  assert.equal(result.result.renamed.length, 2);
  assert.equal(live.normal.name, "State=Default, Tone=Default");
  assert.equal(live.pressed.name, "State=Pressed, Tone=Default");
  assert.equal(result.result.variant.name, "State=Pressed, Tone=Brand");
  assert.equal(JSON.parse(result.stdout).status, "created");
});

test("cloned Variants restore scalar, swap, Slot and nested exposure wiring lost by native clone", async () => {
  const live = fixture();
  const body = { id: "2:20", type: "FRAME", name: "Body", children: [], parent: live.normal };
  const label = {
    id: "2:21", type: "TEXT", name: "Label", parent: body,
    componentPropertyReferences: { characters: "Label#2:0" },
  };
  body.children.push(label);
  const icon = {
    id: "2:22", type: "INSTANCE", name: "Icon", children: [], parent: live.normal,
    isExposedInstance: true,
    componentPropertyReferences: {
      visible: "Show icon#2:1",
      mainComponent: "Icon#2:2",
    },
  };
  const slot = {
    id: "2:23", type: "SLOT", name: "Content", children: [], parent: live.normal,
    componentPropertyReferences: { slotContentId: "Content#2:3" },
  };
  live.normal.children = [body, icon, slot];

  const result = await executeComponentAddVariant({
    reference: { kind: "node", value: live.set.id },
    pairs: { State: "Hover" },
    fromName: "State=Default",
    json: true,
  }, { evaluate: evaluate(live.figma) });

  const clone = live.nodes.get(result.result.variant.id);
  assert.deepEqual(clone.children[0].children[0].componentPropertyReferences, {
    characters: "Label#2:0",
  });
  assert.deepEqual(clone.children[1].componentPropertyReferences, {
    visible: "Show icon#2:1",
    mainComponent: "Icon#2:2",
  });
  assert.equal(clone.children[1].isExposedInstance, true);
  assert.deepEqual(clone.children[2].componentPropertyReferences, {
    slotContentId: "Content#2:3",
  });
});

test("duplicate and ambiguous references fail before any mutation", async () => {
  const live = fixture();
  await assert.rejects(
    () =>
      executeComponentAddVariant(
        {
          reference: { kind: "node", value: live.set.id },
          pairs: { State: "Pressed" },
          fromName: null,
          json: false,
        },
        { evaluate: evaluate(live.figma) }
      ),
    (error) => {
      assert.match(error.message, /made no mutation.*already exists/);
      assert.equal(error.mutationOutcome, "no-mutation");
      assert.deepEqual(error.mutationReport, {
        version: 1,
        outcome: "no-mutation",
        attempted: 0,
        restored: 0,
        residueCount: 0,
      });
      return true;
    }
  );
  assert.deepEqual(
    live.set.children.map((child) => child.name),
    ["State=Default", "State=Pressed"]
  );

  const ambiguous = fixture({ duplicateSet: true });
  await assert.rejects(
    () =>
      executeComponentAddVariant(
        {
          reference: { kind: "query", value: "Button" },
          pairs: { State: "Hover" },
          fromName: null,
          json: false,
        },
        { evaluate: evaluate(ambiguous.figma) }
      ),
    (error) => {
      assert.match(error.message, /made no mutation.*ambiguous/);
      assert.equal(error.mutationOutcome, "no-mutation");
      return true;
    }
  );
});

test("an append failure after mutation removes the clone and restores sibling names", async () => {
  const live = fixture({ appendThrows: true });
  await assert.rejects(
    () =>
      executeComponentAddVariant(
        {
          reference: { kind: "node", value: live.set.id },
          pairs: { Tone: "Brand" },
          fromName: null,
          json: false,
        },
        { evaluate: evaluate(live.figma) }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.equal(error.mutationReport.residueCount, 0);
      return true;
    }
  );
  assert.deepEqual(
    live.set.children.map((child) => child.name),
    ["State=Default", "State=Pressed"]
  );
  assert.equal(live.nodes.size, 3);
});

test("a Component Set expansion failure restores size, clone and sibling names", async () => {
  const live = fixture({ resizeThrowsOnce: true });
  await assert.rejects(
    () =>
      executeComponentAddVariant(
        {
          reference: { kind: "node", value: live.set.id },
          pairs: { Tone: "Brand" },
          fromName: null,
          json: false,
        },
        { evaluate: evaluate(live.figma) }
      ),
    (error) => {
      assert.equal(error.mutationOutcome, "rolled-back");
      assert.equal(error.mutationReport.residueCount, 0);
      return true;
    }
  );
  assert.equal(live.set.width, 220);
  assert.equal(live.set.height, 40);
  assert.deepEqual(
    live.set.children.map((child) => child.name),
    ["State=Default", "State=Pressed"]
  );
});

test("Component Add Variant Plan is authoritative", async () => {
  const argv = [
    "component",
    "add-variant",
    "node:2:1",
    "State=Hover",
    "--json",
  ];
  const plan = planFigmaCommand(argv, { adapter: "cli" });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, "never");
  assert.equal(plan.effects.figma, "write");
  assert.equal(componentAddVariantPlanRoute(plan), "command-application");
  const live = fixture();
  const result = await executeComponentAddVariantPlan(plan, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.variant.name, "State=Hover");
  assert.equal(
    componentAddVariantPlanRoute(
      planFigmaCommand(["inspect"], { adapter: "cli" })
    ),
    "not-component-add-variant"
  );
});
