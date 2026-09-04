# Command model — design decisions

The command model is how every Figma Command becomes a plan before it becomes
an effect: what it may touch, whether it needs confirmation, and which file
it targets. The decisions below protect against a command doing more than
what its plan explicitly authorized, whether that risk comes from a new
option, a URL buried in payload text, or an ambiguous alias.

## Capability catalog and command plans

### Resolve every command through one Capability Catalog

**Decision.** Every adapter resolves a Figma Command into one immutable
Command Plan before execution. Unknown commands default to denied, mutating,
and non-retryable. Effects are recorded on one closed five-axis vocabulary
(figma, editor, workspace, network, shared), each `none`, `read`, or `write`.
**Why.** Defaulting an unrecognized command to the most restrictive policy
means adding a command cannot accidentally bypass confirmation, targeting,
path normalization, or audit.
**What it means for you.**

- An accepted plan exposes only a canonical, payload-free action path as its
  audit id, never a raw positional value from argv.
- Adapters may translate a plan's timeout class into deployment
  milliseconds, but cannot replace the class or its accepted outcome codes.

<!-- source: 0002 -->

### Gate irreversible legacy bulk writes until they are typed

**Decision.** Legacy bulk writes that could start irreversible mutation
before a complete bounded preflight, currently `var delete-all`, page-wide
`tokens rebind --apply`, and `node set|bind --batch`, are refused through
both Commander and MCP before confirmation or dispatch.
**Why.** These specific modes could not yet report a truthful preflight,
target identity, or rollback outcome, so refusing them is safer than
shipping a plausible-looking but unsafe bulk mutation.
**What it means for you.**

- Exact single-target deletes, single-node sets and binds, and node-scoped
  Token Rebind apply remain fully available.
- A gated mode returns only once it has its own closed Command Application
  with explicit bounds, full preflight, and rollback or residue reporting.

<!-- source: 0022 -->

### Keep command aliases canonical and rejections closed

**Decision.** The Figma Command Grammar owns every public root name and its
supported aliases; every adapter normalizes an alias before capability,
target, and execution planning. A denied request projects bounded Command
Rejection Facts distinguishing an unknown root, unknown action, unsupported
option, or malformed value, without echoing payloads.
**Why.** If alias spelling could select a different action id or safety
policy, two spellings of the same command could carry different security
guarantees.
**What it means for you.**

- Every rejection names one canonical accepted form or a bounded action
  list; it never makes the request executable by itself.
- Variable Discovery keeps its closed `list` and `find` interfaces rather
  than silently growing a `--collection` filter with new semantics.

<!-- source: 0085 -->

## Targeting a file and a node

### Target exactly one Figma file per command

**Decision.** A single connected window may be implicit, but multiple
windows require an explicit Figma Target Context. A full Figma URL supplies
its file only from a Command Capability's closed semantic target field;
payload text is never searched.
**Why.** Convenience fan-out across every open file would turn a targeting
mistake into a cross-file mutation, so there is no all-files write.
**What it means for you.**

- Job identity and audit always include the resolved file key.
- With several files open, an ambiguous command stops before dispatch rather
  than picking one.

<!-- source: 0004 -->

### Derive a URL target only from a declared field

**Decision.** A Figma URL may derive a Figma Target Context only when it
appears in a command's closed semantic node field, never from a search
across the whole argument list. Target precedence is explicit caller file,
then a projected semantic URL, then the Design Link Registry, then implicit
single-window targeting.
**Why.** Searching text, names, labels, or unrelated option values for
anything URL-shaped would let an unrelated value silently retarget a
mutation to the wrong file.
**What it means for you.**

- Adding a command root without a declared projection contract stops
  startup rather than shipping an unprotected root.
- Without an explicit file, a node field naming more than one file stops
  before confirmation instead of guessing.

<!-- source: 0020 -->

### Parse union references before choosing a target

**Decision.** A field that historically accepted a node id, name, or label
in one string now parses as a closed Union Reference with explicit `node:`,
`name:`, `label:`, and `query:` variants. Only `node:` delegates to Node
Reference and may contribute a URL file key; an unprefixed value
canonicalizes to `query:`.
**Why.** Collapsing every kind of reference into one lookup made an authored
name that happened to look like a URL or node id ambiguous with real
targeting identity.
**What it means for you.**

- `label:` never falls through to a node lookup, and `node:` never falls
  through to a name lookup.
- A colliding literal value can be marked explicitly, for example
  `name:node:primary`.

<!-- source: 0080 -->

## Confirmation and preview

### Separate write confirmation from a guaranteed preview

**Decision.** `FIGMA_WRITE_CONFIRM` is an MCP execution policy, not a
dry-run contract; omitting `confirm` cannot express a portable non-mutating
intent. `figma_run` and `figma_render` instead accept `preview:true`, a
configuration-independent contract that plans and validates the request but
never dispatches it.
**Why.** Conflating a site's confirmation setting with an individual
caller's intent to preview made automation either always paused or never
previewable, depending on server configuration the caller could not see.
**What it means for you.**

- `preview:true` wins even when `confirm:true` is also present.
- Preview output is payload-free: capability, effects, target kind, timeout,
  and dispatch class, never JSX, payloads, file keys, or labels.

<!-- source: 0070 -->

## Generic node command applications

### Verify node movement by fresh coordinate readback

**Decision.** `node move` parses bounded finite X/Y positionals through one
closed request, translates them into parent-relative coordinates, and
requires a fresh absolute-coordinate readback within a small numeric
tolerance before it counts as success.
**Why.** A negative positional otherwise looks like an unknown option to a
generic parser, and a setter's return value alone is not proof that the node
actually moved.
**What it means for you.**

- `node set --x/--y` shares the same finite coordinate validator, so the two
  placement surfaces cannot silently diverge on numeric bounds.
- A mismatch after dispatch is reported as an execution failure, never as a
  successful move.

<!-- source: 0084 -->

### Verify deletion by hierarchy membership, not handle nullness

**Decision.** `node delete` attaches a target only when its observed parent
currently contains its id, sorts attached targets by ancestry depth, and
after each removal reads the captured former parent's current children to
confirm the id is actually gone.
**Why.** Figma can keep a direct node-id lookup readable after structural
removal, so neither a non-null handle nor a null one is reliable proof of
membership on its own.
**What it means for you.**

- A batch can delete both a child and its ancestor without the ancestor's
  removal mislabeling the child as a separate failure.
- A later failure reports exactly how many earlier removals were already
  confirmed instead of hiding partial, irreversible effects.

<!-- source: 0091 -->

### Roll back a duplicate that fails its postcondition

**Decision.** `node duplicate` preflights source and target membership
before the single `clone()` call, then freshly verifies type, name,
coordinates, and parent order. A failed postcondition removes the new copy
and verifies both parents; an Auto Layout-managed position is reported as
such rather than as a failure.
**Why.** Retrying an uncertain `clone()` risks creating an extra copy, so
the created node is the only resource the operation can safely roll back.
**What it means for you.**

- The result distinguishes verified rollback, bounded residue, and
  unavailable verification instead of ever guessing.
- Existing placement options, including the same-parent default offset,
  keep working exactly as before.

<!-- source: 0118 -->

## MCP interface shape

### Keep the MCP surface small and progressive

**Decision.** The MCP exposes a small, stable tool set and serves
workflows, Command Capability listings, and large design sections on demand
rather than through additional tools or long handshake prose.
**Why.** MCP context is a finite execution resource shared with the rest of
the conversation, not free documentation space.
**What it means for you.**

- Discover available commands and workflows through the existing tool
  parameters instead of expecting a new tool per feature.
- Large design sections are fetched progressively rather than dumped into
  every response.

<!-- source: 0005 -->
