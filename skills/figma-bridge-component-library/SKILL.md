---
name: figma-bridge-component-library
description: Use when creating or updating reusable Figma components, component sets, variants, component properties, variables, styles, themes, or a design-system library from code with the Figma Bridge MCP. Trigger for requests such as "create this component in Figma", "build variants", "turn our code components into a Figma library", "add component properties", or "sync our design system to Figma". Enforce foundations-first token bindings, identity-safe reuse, sequential writes, and per-component visual validation. Do not use merely to compose a screen from components that already exist.
---

# Build Figma Components from Code

Create reusable Figma contracts that stay connected to the codebase. A visual
look-alike without tokens, variants, properties, and durable identity is not a
finished component.

## Lock the component contract

1. Inspect the code component, prop types and defaults, CSS or token sources,
   assets, states, responsive behavior, Storybook stories, and tests.
2. Inspect the target Figma file's pages, variables, styles, components,
   variant naming, and `figma-bridge.json` links. Call `figma_reference` with
   `name: "workflow:code-to-figma"` once.
3. Produce a concise gap map: what exists only in code, only in Figma, and on
   both sides with a conflict. Resolve real conflicts before mutation.
4. Define the component contract: variant axes and values, TEXT and BOOLEAN
   properties, INSTANCE_SWAP slots, interaction states, token bindings, assets,
   and the Design Entity id. Cap a Cartesian variant matrix at 30; split the
   component when the contract would explode beyond that.

## Build foundations first

- Reuse or sync existing variables and styles before creating components.
  Prefer DTCG/CSS token sync for maintained code tokens and use a dry-run plan
  before applying writes.
- Alias semantic variables to primitives instead of duplicating raw values.
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
   `component add-variant` when extending an existing set.
4. Expose TEXT, BOOLEAN, and INSTANCE_SWAP component properties deliberately.
   Use INSTANCE_SWAP for icons and swappable nested components; never create an
   icon-name variant axis.
5. Import exact SVG or raster source from the codebase. Do not redraw icons from
   primitives and do not detach imported design-system instances.
6. Validate the component before starting the next one: inspect the component
   main/set contract and property list, read the node tree, take a screenshot,
   and verify variant count, names, bindings, text overrides, clipping, states,
   and touch targets.
7. Link the result with `link set` to its source/export and Storybook story.
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
