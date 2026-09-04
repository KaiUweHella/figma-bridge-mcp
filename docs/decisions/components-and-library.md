# Components and library — design decisions

This area covers Figma Components and Component Sets, how the Bridge keeps
repository code and Figma design entities linked, component discovery at
scale, and mirroring a Storybook index. The decisions below keep every
component mutation verified rather than assumed, keep the link between code
and design entities repairable instead of silently stale, and keep large
libraries readable within bounded time and payload.

## Linking code and design entities

### Link design entities through two anchors, neither authoritative alone

**Decision.** A Design Entity has one repository-owned id. `figma-bridge.json`
records its code, Storybook and Figma links in version control; the linked
Figma node stores only that id and a schema version in plugin data. The
Design Link Registry reconciles both sides and refuses duplicate ids or
conflicting handles instead of silently picking one.
**Why.** A repository-only record goes stale once a node is recreated, while
Figma-only data cannot be read before the document connects and cannot point
an agent back at code by itself.
**What it means for you.**

- Link writes are idempotent: repeating the same `link` operation repairs
  either side after a partial failure.
- Legacy `figma-map.json` remains readable for Storybook mappings, but new
  links are written only to `figma-bridge.json`.

<!-- source: 0007 -->

### Classify round trips from an explicitly accepted baseline

**Decision.** A Round-trip Plan compares the current code and Figma
fingerprints against one Accepted Design Baseline, created only by
`link accept` after a human or agent has visually verified both sides
correspond. The result is always one of `unchanged`, `code-only`,
`figma-only`, `conflict` or `untracked`; none of these values authorizes a
mutation.
**Why.** Linking two things is not the same claim as verifying they still
match, and a conflict must never have the tool silently pick a winner.
**What it means for you.**

- `link accept` on a screen entity requires a passing browser screenshot
  pixel-diff before it will record a baseline.
- A node carrying a stored semantic path lets a later plan report exactly
  which sub-paths changed, instead of only "figma-only".

<!-- source: 0008 -->

### Project design context on demand, never as a second memory file

**Decision.** Project Design Context is computed per request from the Design
Link Registry, the current Round-trip Plan and discoverable project design
files, all through the existing `figma_run ["link","context",...]` surface.
**Why.** A persisted context file would drift from the live registry and
would give Claude Code, Codex or another MCP client its own divergent copy of
workflow knowledge.
**What it means for you.**

- Live Figma facts inside this context are still gathered through the
  authenticated plugin transport and fingerprinted fresh each call.

<!-- source: 0009 -->

### Anchor nested design link registries to workspace authority

**Decision.** A Design Link Registry may live below the repository root,
including inside a private evidence directory, without changing the code
project's boundary. When a workspace authority is configured, the Registry
selects the deepest authorized root containing its own path and stores links
relative to that root.
**Why.** A link that can be created but not later inspected, planned or
accepted is a broken workflow, not a user path mistake.
**What it means for you.**

- Registry access still passes through the same path canonicalization,
  symlink containment and byte limits as any other workspace read or write.

<!-- source: 0064 -->

## Mirroring a Storybook index

Remote Storybook origins are a security decision, not a component one: how an
origin is authorized and pinned is stated under
[security-and-transport.md](security-and-transport.md).

## Discovering components at scale

### Bound component inventory at one shared seam

**Decision.** `component list`, `map storybook` and post-render reuse advice
all consume one Component Inventory module with explicit page, node-visit,
Variant, axis and string limits, capped so the final JSON stays below the
authenticated transport ceiling. A limit failure is always explicit; no limit
produces a silently partial "success".
**Why.** A partial component library returned as if it were complete would
mislead any caller that trusts it.
**What it means for you.**

- A limit failure recommends narrowing to the current page where that keeps
  normal use working.

<!-- source: 0066 -->

### List component properties and the full inventory as bounded reads

**Decision.** `component prop list` and `component list` are safe, retryable
reads shared by CLI and MCP. Property listing supports an explicit target or
the current selection; inventory listing supports current-page and
`--all-pages` scope, the latter using the longer read budget.
**Why.** Neither read mutates the document, so both can be retried freely and
both adapters should agree on exactly the same bounded result.
**What it means for you.**

- Malformed, oversized or scope-mismatched results fail rather than returning
  a plausible partial list.

<!-- source: 0104, 0107 -->

## Authoring component properties

### Set, add and delete component properties with verified outcomes

**Decision.** `component prop set`, `component prop add` and
`component prop delete` each verify their result with a fresh read rather
than trusting the setter's return value. Set and add restore the prior scalar
or remove the exact newly created definition on failure; delete has no
recreate-with-identity API, so a failed delete is reported as irreversible
residue rather than rolled back.
**Why.** Figma generates a property's `#suffix` identity itself, so a deleted
property can never be recreated with the same identity, so only a fresh,
verified read can tell you what actually happened.
**What it means for you.**

- `component prop add` refuses to create a `VARIANT` property directly and
  points to combining named Components instead.
- `--options` on `add` is accepted for compatibility but only produces a
  warning; it cannot configure a non-Variant property.

<!-- source: 0101, 0102, 0103 -->

### Wire properties to layers and expose nested instances

**Decision.** `component prop bind` connects a TEXT, BOOLEAN or INSTANCE_SWAP
property definition to the actual layer field it should control, verifying
the complete reference map afterward and restoring it on failure.
`component nested expose` toggles whether one primary nested Instance's own
properties surface on the wrapping Component, with the same verify-or-restore
pattern.
**Why.** A property definition with nothing wired to it can be reported as
"done" by an agent while doing nothing in the design; only a bound field
makes the contract real.
**What it means for you.**

- Existing bindings are preserved by default; changing one needs `--replace`.
- Component Property Facts (the read side) walk only the addressed subtree
  and report Slot settings, preferred values and nested exposure alongside
  scalar bindings.

<!-- source: 0119 -->

## Creating and combining components

### Create components and instantiate them with verified placement

**Decision.** `component create` and `component instantiate` each preflight
destination membership and insertion index before their one native factory
call, then freshly verify identity, parent order, index, name and geometry.
Failure removes only the exact created resource and re-verifies the original
destination order.
**Why.** A partially completed create-and-place operation must never leave an
unverifiable extra node with no record of what happened.
**What it means for you.**

- Library and remote Component sources remain supported for instantiation.
- `-h` is the documented height option for `create`, not a silent help
  shortcut that could bypass write confirmation.

<!-- source: 0105, 0106 -->

### Add a variant to an existing component set

**Decision.** `component add-variant` clones a nearest or explicitly chosen
source Variant, backfills any newly introduced axis across sibling Variants,
and journals every rename and the clone itself. A free-layout Component Set
that would otherwise clip the new Variant outside its visible bounds is
expanded as part of the same verified mutation.
**Why.** A Variant added beyond a clipped Set's bounds would be invisible
without any tool signal that anything went wrong.
**What it means for you.**

- Failure restores sibling names and Set geometry and reports the same
  rollback-or-residue outcome as other component mutations.
- `--from` snapshots the source Variant's TEXT, BOOLEAN, INSTANCE_SWAP and
  SLOT bindings and restores them on the clone, not just its structure.

<!-- source: 0100 -->

### Combine standalone components into one set

**Decision.** `component combine` accepts comma-separated and repeated node
references, requires every input to be a standalone local Component on the
same page, and re-reads the resulting Component Set afterward to verify its
membership, Variant parents and the mapping back to every requested input.
**Why.** The legacy handler silently dropped positionals after the first
comma-separated value; a mutation that can silently drop part of its own
request must be closed, not patched.
**What it means for you.**

- Remote library Components, Components already inside an Instance or
  Component Set, and mixed-page inputs are refused before any mutation.
- Combining into an existing Component Set is refused; use
  `component add-variant` for that instead.

<!-- source: 0087 -->

### Convert nodes to components irreversibly, but proven

**Decision.** `node to-component` converts Frames and Groups sequentially,
since Figma exposes no atomic batch or reversing operation. After each native
call, fresh parent membership, type, name, index and child identity must
match what was expected before the acknowledgement is trusted.
**Why.** A silently skipped or partially converted batch would leave an agent
unsure which targets actually became Components.
**What it means for you.**

- Nested target batches (one target inside another) are refused, because no
  ordering could preserve both conversions independently.
- A later failure reports every already-proven conversion as bounded residue;
  none of it is undone.

<!-- source: 0112 -->

## Editing and reusing instances

### Swap and detach instances without a false rollback

**Decision.** `component swap` performs exactly one `swapComponent` call and
does not automatically swap back on a later problem, because a second
heuristic swap could further change Instance overrides rather than restore
them. `component detach` similarly never tries to recreate the original
Instance, since Figma exposes no inverse for it.
**Why.** Figma's override-matching heuristics change state on every swap, so
an automatic "undo" swap would not truthfully restore the original.
**What it means for you.**

- A request for the Component a swap target already uses succeeds without any
  mutation.
- Detach failure is reported as unchanged, irreversible partial residue, or
  unavailable verification; recovery is always an explicit follow-up
  decision.

<!-- source: 0108, 0109 -->

### Remove instance overrides with a verified zero count

**Decision.** `component overrides` (`reset`/`remove`, kept as compatible
aliases) captures the exact override entries before calling the current
`removeOverrides()` API, then verifies from a fresh read that the direct
override count is exactly zero.
**Why.** The legacy path reported override counts from the same mutation
call without a fresh read, so an acknowledgement error could not be told
apart from a real partial result.
**What it means for you.**

- A zero-override Instance is reported as a verified no-op, not an error.
- An explicitly renamed layer is itself an override, so removing overrides
  restores the layer name to the Component's name.

<!-- source: 0110 -->

### Generate size variants and combinations without stray nodes

**Decision.** `sizes` clones exactly the three requested Small/Medium/Large
variants from a Component, Instance or Frame and never creates an extra
temporary Component, unlike its legacy path. `combos` bounds its Cartesian
property expansion to 256 combinations before creating anything, and creates
every combination or fails the whole request rather than silently skipping a
failed one.
**Why.** A partial grid of combinations reported as success would hide which
property assignments actually failed.
**What it means for you.**

- `combos` supports a dry-run that returns the same bounded analysis without
  creating any nodes.
- `combos` creates standalone derived Components; use `component add-variant`
  when the intent is to extend the source Component Set instead.

<!-- source: 0124, 0125 -->
