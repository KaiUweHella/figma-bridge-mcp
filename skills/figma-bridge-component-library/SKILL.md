---
name: figma-bridge-component-library
description: Use when creating or updating reusable Figma components, component sets, variants, component properties, variables, styles, themes, or a design-system library from code with the Figma Bridge MCP. Trigger for requests such as "create this component in Figma", "build variants", "turn our code components into a Figma library", "add component properties", or "sync our design system to Figma". Enforce foundations-first token bindings, identity-safe reuse, sequential writes, and per-component visual validation. Do not use merely to compose a screen from components that already exist.
---

# Build Figma Components from Code

Create reusable Figma contracts that stay connected to the codebase. A visual
look-alike without tokens, variants, properties, and durable identity is not a
finished component.

## Pin the Figma Bridge transport

- Use the tools from the server bundled with this skill: namespace
  `figma-bridge`, server id `figma-bridge-mcp`. Do not select a similarly named
  Figma MCP by name alone.
- Start with this server's `figma_status`. Its result and every later result must
  identify `_mcp: "figma-bridge-mcp"`.
- A failed probe proves only that Figma Bridge transport is unavailable. It does
  not prove that Figma or another Figma MCP is unavailable.
- Do not silently switch to another Figma MCP for a write. Name the unavailable
  transport and ask the user before changing tools or write semantics.

## Lock the component contract

1. Inspect the code component, prop types and defaults, CSS or token sources,
   assets, states, responsive behavior, Storybook stories, and tests.
2. Inspect the target Figma file's pages, variables, styles, components,
   variant naming, and `figma-bridge.json` links. Call `figma_reference` with
   `name: "components"` once; add `name: "workflow:code-to-figma"` when a
   screen or code-render workflow is also in scope.
3. Produce a concise gap map: what exists only in code, only in Figma, and on
   both sides with a conflict. Resolve real conflicts before mutation.
4. Define the component contract across all five native property types: TEXT,
   BOOLEAN, INSTANCE_SWAP, VARIANT and SLOT. Record scalar definition-to-layer
   bindings, nested Instance exposure, Slot limits and preferred values,
   interaction states, token bindings, assets, and the Design Entity id. Cap a
   Cartesian variant matrix at 30; split the component when the contract would
   explode beyond that.

## Build foundations first

- Reuse or sync existing variables and styles before creating components.
- Treat generated resources as an explicit library decision. Semantic Render
  keeps unmatched implicit spacing/radius and typography literals literal by
  default; use `materializeResources:true` only when the reviewed component
  contract intentionally creates those Figma Variables and Text Styles, then
  verify the returned reuse/create/bind/literal report.
- Collect known metadata changes for several Variables into one `var
update-batch` call; keep `var update` for one target.
- Collect known value assignments for several Variable/mode pairs into one
  `var set-value-batch` call; do not reject previously empty modes, and inspect
  any failed best-effort rollback Outcome for exact residue.
  Prefer DTCG/CSS token sync for maintained code tokens and use a dry-run plan
  before applying writes.
- Alias semantic variables to primitives instead of duplicating raw values.
  When several Variables are new, use one `var create-batch` request with an
  explicit `alias` and optional `aliasCollection` on each semantic item. The
  target may be an exact existing Variable or another item in the same batch.
  Never turn a resolved equal value into an Alias unless the source itself
  declares that reference. If the user explicitly requests same-value linking,
  inspect every compatible primitive candidate first and emit `alias` only
  when exactly one target identity is provable; otherwise report the bounded
  ambiguity and leave the literal unchanged.
  Preserve source code syntax and assign deliberate compatible scopes. Present
  every `SCOPE DECISION REQUIRED` result to the user before narrowing it.
- Bind fills, strokes, padding, gaps, radii, dimensions, and typography wherever
  the corresponding variable or style exists. Keep intentionally fixed icon
  geometry fixed and document that exception.

## Build one component at a time

1. Reuse or update an exact linked component. A matching display name without
   a Design Entity, component key, or confirmed contract is not sufficient.
2. Build the base component with semantic Auto Layout and stable layer names.
   Give every overridable text layer an explicit name.
3. Create each variant from the closest valid base, edit only its differences,
   then combine and arrange the variants into one component set. Use
   `component add-variant` when extending an existing set; it preserves scalar
   and Slot references plus nested exposure that Figma's raw clone may drop.
4. Expose properties deliberately and use their native ownership model:
   - Add TEXT, BOOLEAN and INSTANCE_SWAP definitions, then bind each definition
     to a compatible descendant with `component prop bind`. Definition-only
     scalar properties are incomplete. TEXT binds `characters`, BOOLEAN binds
     `visible`, and INSTANCE_SWAP binds `mainComponent`.
   - Use INSTANCE_SWAP for icons and replaceable nested components; curate its
     picker with preferred values and never create an icon-name variant axis.
   - Treat VARIANT as a native Component Set axis produced by named variants,
     not as a scalar definition or sublayer binding.
   - Create SLOT as a native flexible region with the dedicated Slot commands.
     Set child limits, empty/default behavior, stretch behavior and preferred
     values deliberately; Slot contents remain structural instance overrides.
5. For Components inside Components, preserve the nested Instance. Use
   `component nested expose` only on a primary nested Instance when consumers
   of the wrapper should access that Instance's own properties. Do not detach,
   flatten, or claim exposure for an inherited Instance below another Instance.
6. Map representable state transitions and interactions to native prototype
   reactions, then verify them with `prototype inspect`. Do not invent a
   reaction when the source behavior depends on app state, routing or async
   work.
7. Import exact SVG or raster source from the codebase. Do not redraw icons from
   primitives and do not detach imported design-system instances.
8. Validate the component before starting the next one: inspect the component
   main/set contract and run `component prop list`. Require `wired` for every
   scalar property, `native-axis` for every Variant and `native-slot` for every
   Slot; verify nested exposure and run `slot validate`. Instantiate the
   component, exercise each control independently, and treat that Instance as
   authoritative for `minChildren` because an empty Slot on the main Component
   can report no violation. Read the node tree, take a screenshot, and verify
   clipping, states and touch targets.
9. Link the result with `link set` to its source/export and Storybook story.
   Run Storybook mapping only after the component and story names are final.

## Keep the workflow safe and resumable

- Execute Figma mutations sequentially. Parallelize repository analysis only;
  never run concurrent writes against the same file.
- Retain exact returned ids and use them for updates and cleanup. Never delete
  through guessed prefixes or broad name matching.
- Make each creation idempotent: check the Registry and existing Figma object
  before creating another copy.
- Stop on an error, inspect the result, and correct the smallest failed step.
  Do not rebuild already validated components.

Finish with a library summary covering variables/styles reused or created,
components and variants, property coverage, token-binding coverage, links,
screenshots inspected, and unresolved gaps.
