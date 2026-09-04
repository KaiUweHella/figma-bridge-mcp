# Variables and tokens — design decisions

This area covers Figma Styles, Variables, Collections and the design tokens
built on top of them: reading exact facts, mutating them safely, and moving
token sets between a repository and a Figma file. The decisions below protect
authored values from silent loss, keep every mutation either provably applied
or provably rolled back, and keep import and export exact rather than
approximate.

## Reading styles and their catalog

### Read exact style facts as one bounded call

**Decision.** `style show` and `grid list` return one closed, versioned set of
facts for a single style or node: publishable identity, remote state, and the
complete authored PAINT, TEXT, EFFECT or GRID topology, including Variable
Alias bindings. A Figma-native non-finite scalar, such as an Auto grid
`count`, crosses the JSON transport as an explicit `{"$figmaScalar":"Infinity"}`
tag rather than becoming `null`.
**Why.** Plain JSON cannot carry `Infinity`, and a missing `description` field
in the live runtime must not be silently coerced into a different shape.
**What it means for you.**

- `style show <id-or-name>` resolves by id, exact name, then one unique
  partial name; ambiguous or missing references fail with a bounded error.
- Resolved Variable values, style consumers and binary assets are not part of
  this read.

<!-- source: 0023, 0024 -->

### Paginate the style catalog and scan its consumers separately

**Decision.** `style list` returns a bounded, cursor-paginated catalog of
stable identity rows (id, key, name, family, remote state) rather than full
style facts. `style consumers` runs Figma's document-wide
`getStyleConsumersAsync()` as its own long-timeout operation and reports
whether the underlying native scan was itself interruptible.
**Why.** Catalog listing, exact-fact reads and document-wide consumer scans
have different fanout and deadlines; conflating them would force every caller
to pay for the slowest one.
**What it means for you.**

- A catalog page reports total, returned, omitted and whether it is
  `complete`; a final page is not a complete catalog by itself.
- `style consumers` can take substantially longer because Figma exposes no
  interruptible visit budget for it.

<!-- source: 0025, 0026 -->

### Report publish status as compact reads

**Decision.** `style publish-status` and `var/col publish-status` answer only
Figma's `UNPUBLISHED`, `CURRENT` or `CHANGED` state, without loading the full
authored value.
**Why.** Checking publish state does not need paints, typography or complete
Variable metadata, and reusing the heavier read would waste the read lane on
routine polling.
**What it means for you.**

- These are safe, retryable reads with no write confirmation.
- Full authored values remain available separately through `style show` or a
  Variable read.

<!-- source: 0029, 0036 -->

## Creating, updating and applying styles

### Create, update and delete styles behind one preflighted mutation

**Decision.** `style create`, `style update` and `style delete` each run one
non-retrying mutation. Creation and update snapshot every touched field before
writing and restore it on failure; deletion has no undo handle from Figma, so
a failed remove is reported as unknown outcome rather than rolled back.
**Why.** Figma's Style API gives no transaction boundary, so honesty about
what could and could not be restored matters more than pretending atomicity.
**What it means for you.**

- A partial update reports exactly which fields restored and which remain
  bounded residue; it never claims full atomicity.
- Remote (library) styles cannot be updated or deleted.

<!-- source: 0031, 0032, 0033 -->

### Apply a style to nodes with reverse rollback

**Decision.** `style apply` resolves the target style once, checks every node
for the matching setter before the first write, then applies sequentially. A
later failure restores every already-confirmed node in reverse order.
**Why.** Applying to many nodes in one command should not leave some nodes
styled and others not, without at least an honest accounting of which is
which.
**What it means for you.**

- Up to 500 node references may be targeted in one call.
- The canonical option for grid application is `grid`; `layout-guide` is a
  readable alias for the same operation and never touches Auto Layout Grid
  settings.

<!-- source: 0030 -->

### Bind Variables into typography with verified readback

**Decision.** `style bind-font`/`style unbind-font` (on a Text Style) and
`font bind`/`font unbind` (on a text node's character range) never trust a
setter's return value. Each reads the binding back afterward and only reports
success when the observed Variable Alias matches what was requested.
**Why.** A setter can appear to succeed while leaving the prior binding, or a
partial range, in place; only a fresh read proves the field actually changed.
**What it means for you.**

- A mixed-styled character range is captured as segments before being
  overwritten, so a failed write can restore each segment individually.
- Failure is reported as `rolled-back` or bounded residue, never retried.

<!-- source: 0034, 0081 -->

## Creating and managing variables and collections

### Create and extend variables and collections with journaled cleanup

**Decision.** `var create`, `var create-batch`, `col create` and `col extend`
journal every native identity immediately after Figma returns it, verify it
with a fresh read, and remove everything they created if a later step fails.
Native defaults that Figma writes into a mode without being asked are recorded
as `native-default` rather than treated as an error.
**Why.** Figma always materializes a value per mode on creation, so absence of
requested intent is not absence of a value, and only fresh reads (not the
factory's return value) can prove a resource is safe to keep or must be
removed.
**What it means for you.**

- Duplicate names fail by default; `--allow-duplicate` makes intent explicit.
- `var create-batch` accepts up to 256 items in one journaled transaction.

<!-- source: 0037, 0038, 0045, 0047, 0075, 0086 -->

### Update variable and collection metadata field by field

**Decision.** `var update`/`var update-batch` and `col update` snapshot every
requested field before assignment and restore each one independently if a
later field fails, rather than treating the whole update as one unit.
**Why.** One failed field restoring should never block another already-changed
field from being restored too.
**What it means for you.**

- `var update-batch` accepts at most 64 items and rejects two different
  queries that resolve to the same Variable before making any change.
- Restore failure reports the exact failed field names as bounded residue.

<!-- source: 0041, 0042 -->

### Manage collection modes without pretending removal is reversible

**Decision.** `col mode-add`, `col mode-rename` and `col mode-remove` each
follow the recovery path Figma's API actually offers: add can be undone by
removing the new mode, rename can be undone by restoring the old name, but
remove has no restoring API and a failure after it is reported as
`irreversible-applied`.
**Why.** Claiming a generic rollback for an operation Figma cannot reverse
would be a false safety guarantee.
**What it means for you.**

- Removing a mode counts and verifies that its authored values are gone, not
  just that the mode id disappeared.

<!-- source: 0043 -->

### Delete variables and collections, verified rather than assumed

**Decision.** `var delete` and `col delete` resolve every exact target before
the first removal, then re-read the catalog afterward to prove each id is
actually gone. `col delete --only-if-empty` refuses the write inside the same
preflight if the collection still owns a Variable.
**Why.** Figma can briefly return a just-removed resource from a direct id
lookup, so membership in a freshly re-read catalog, not a non-null check
alone, is the real removal proof.
**What it means for you.**

- Deletion is irreversible; failure evidence distinguishes nothing removed,
  partial irreversible removal, and unavailable verification.
- Duplicate or ambiguous names stop before the first removal.

<!-- source: 0044, 0046 -->

## Variable values, bindings and comparisons

### Set and batch mode values with best-effort rollback

**Decision.** `var set-value` and `var set-value-batch` snapshot the prior
value of every targeted mode before writing. Because Figma has no API to clear
a mode value back to empty, a mode that started empty is explicitly classified
as non-reversible before the write, not silently promised a rollback.
**Why.** Naming the exact recovery limit up front is more useful than a batch
result that only reveals it after a failure.
**What it means for you.**

- The batch policy is named `best-effort-rollback`; a formerly empty mode that
  ends up populated after a failure is reported as bounded residue.

<!-- source: 0039, 0074 -->

### Carry code syntax the same way as values

**Decision.** `var code-syntax` snapshots the previous WEB, ANDROID or iOS
syntax value (or its absence) before writing or removing it, and restores that
exact state on failure.
**Why.** Code syntax mutation shares the same non-retrying, verified mutation
shape as value mutation, so it reuses the same resolution and validation
runtime instead of a second implementation.
**What it means for you.**

- Exactly one syntax value or `--remove` is required per call.

<!-- source: 0040 -->

### Resolve variable bindings locally before remote lookup

**Decision.** Node Binding Facts resolves a bound Variable's identity from a
bounded local Variable and Collection catalog first. Only an id absent from
that local catalog triggers Figma's per-resource remote lookup, and if that is
unavailable the alias id is still returned, marked `resolved: false`.
**Why.** Calling the remote lookup for every alias would multiply document API
deadlines across a node's whole binding array for no benefit when the target
is already local.
**What it means for you.**

- This read never guesses a name or Collection for an unresolved alias.

<!-- source: 0083, 0092 -->

### Compare token collections without masking duplicate names

**Decision.** `tokens overlap` compares 2 to 32 collections and keeps
per-collection name occurrence counts, so a name that exists more than once in
any collection is reported in `ambiguous_here` instead of quietly joining the
"common" list of cleanly switchable tokens.
**Why.** A theme-switch tool that hides duplicate names would let a caller
rebind the wrong Variable without warning.
**What it means for you.**

- Common, only-here, missing-here and ambiguous-here lists are each
  independently bounded and deterministic.

<!-- source: 0051, 0093 -->

### Rebind aliases across a subtree with full rollback

**Decision.** `tokens rebind` retargets SOLID fill/stroke and scalar aliases
from one collection to same-named compatible Variables in another, scoped to
one explicit node subtree (never a whole page, per the legacy bulk-mutation
gate). Apply journals every original alias before rewriting it and restores
the complete set on failure.
**Why.** A theme switch that partially applies and cannot be told apart from a
complete one is worse than refusing the write.
**What it means for you.**

- Dry-run is a safe, retryable read; apply is confirmed and non-retrying.
- Already-target bindings are left untouched and reported separately.

<!-- source: 0052 -->

### Visualize variables as an editable palette

**Decision.** `var visualize` creates Figma frames and text nodes bound
directly to their source COLOR Variables (not flattened swatches), journals
every created node, and rolls the whole palette back on failure.
**Why.** An editable, live-bound palette stays useful as a design review
artifact in a way that Variable Facts or token export cannot replace.
**What it means for you.**

- An unresolved Variable in the selected mode still gets its native binding
  and is counted, not silently skipped.

<!-- source: 0048 -->

## Token presets and import

### Create neutral spacing and radius presets without collisions

**Decision.** `tokens spacing` and `tokens radii` create two small neutral
utility scales. They reuse an existing Variable only when its value and scope
already match; any mismatch is left untouched and reported as an explicit
conflict rather than overwritten.
**Why.** These presets are a convenience default, not a branded starter kit,
and must never silently replace a project's own token values.
**What it means for you.**

- Conflicts appear on stderr and in the structured result, not just as a
  count.

<!-- source: 0049 -->

### Add a single token with safe auto-collection creation

**Decision.** `tokens add` may create the default `Tokens` collection when it
does not exist, journals both the collection and the Variable, and only
removes an auto-created collection on failure if nothing else has since joined
it.
**Why.** Reusing the general `var create` path would not give this command's
auto-collection and safe-scope behavior its own verified journal boundary.
**What it means for you.**

- Ambiguous COLOR, FLOAT and STRING scope intent defaults to `ALL_SCOPES` and
  is reported back as a decision, not silently guessed narrower.

<!-- source: 0050 -->

### Import tokens into one collection exactly

**Decision.** `tokens import` writes JSON tokens into exactly one named
Figma Collection. It supports DTCG and legacy `{value,type}` shapes, internal
aliases, and explicit scopes and code syntax, but refuses a source carrying
Bridge's own multi-mode Snapshot extensions, directing that case to Snapshot
import instead.
**Why.** Single-collection import cannot faithfully preserve cross-collection
identity or multiple modes, so it must refuse rather than flatten them.
**What it means for you.**

- A collection name containing `/` requires explicit `--force-slash`.
- Existing same-name Variables must already match type and value or the
  import stops before any write.

<!-- source: 0053 -->

### Read and import DESIGN.md token context

**Decision.** `tokens import-design-md --print-context` and the generic
`import <source>` path project token context from a repository file without
ever needing a Figma target, confirmation or Plugin connection. When the
document contains simple COLOR, radius and spacing facts, import delegates to
the single-collection importer rather than re-implementing it.
**Why.** Repository-only planning should work even with no Figma connection,
and a document with only unsupported composites should still be useful.
**What it means for you.**

- Source text is escaped and length-capped before it reaches terminal or
  prompt output.
- An explicit `--save` is required for any workspace write; context alone
  never writes.

<!-- source: 0054, 0055, 0058 -->

### Version and import portable variable snapshots exactly

**Decision.** Generated DESIGN.md files carry a versioned
`variableSnapshot` block (`schemaVersion: 2`) that identifies every
collection, mode, Variable and alias by stable handle rather than array
position or name. Import creates new target collections rather than merging
by display name, and refuses a snapshot whose external dependencies cannot be
recreated exactly.
**Why.** Figma allows duplicate display names, so only stable handles keep a
capture-then-import round trip exact.
**What it means for you.**

- Re-running import into a file that already owns a source collection name is
  reported as a conflict, not merged automatically.
- A color alias with opacity (`COMPOSE_COLOR`) is preserved in the snapshot
  but rejected at import time, because Figma's own setter rejects it.

<!-- source: 0056, 0057 -->

### Import composite typography and shadow styles

**Decision.** Typography and shadow facts from a design source are imported
as native Text Styles and Effect Styles, not flattened into simple Variables.
Every construct without an exact owned mapping is listed as explicit
unsupported evidence instead of a silent partial import.
**Why.** A "composite" value like a text style or shadow stack loses meaning
if it is broken into scalar Variables.
**What it means for you.**

- Existing matching styles are left as no-ops; only missing styles are
  created and journaled.

<!-- source: 0059 -->

### Degrade large snapshot exports before refusing them

**Decision.** When a full DESIGN.md export would exceed the workspace byte or
entry budget, and the document contains a Variable Snapshot, the exporter
first drops only the migration-only legacy `v1` block and shortens
human-readable table previews, keeping the exact `v2` snapshot untouched. Only
if that still does not fit does export fail closed.
**Why.** A large but re-importable token system should not lose its exact
snapshot just because a redundant compatibility view made the file too big.
**What it means for you.**

- The degradation itself is recorded in the file's visible Markdown and
  machine-readable metadata.

<!-- source: 0095 -->

### Preserve native motion easing across the token boundary

**Decision.** Named and custom cubic-bezier EASING values round-trip through
the standard DTCG `cubicBezier` type and an exact CSS timing function. Spring
values remain typed native values in DTCG but get an explicit CSS limitation
comment instead of a fabricated curve approximation.
**Why.** Serializing a spring as a string would either lose its type or
produce an unusable value; approximating it as a curve would claim fidelity
the Bridge cannot prove.
**What it means for you.**

- A Bridge-authored DTCG file with the versioned extension restores the exact
  original named or custom easing variant on import.

<!-- source: 0099 -->

## Exporting and synchronizing tokens

### Export exact tokens to CSS and DTCG

**Decision.** `export css` and `export dtcg` share one Command Application for
both a bounded node-scoped subtree capture and a file-wide capture across
every local Collection and mode. Colliding Variable names across different
Collections are never dropped: CSS gets Collection-qualified custom
properties, DTCG groups them under deterministic paths.
**Why.** A node-scoped export must follow bindings into enabled libraries; a
file-wide export must cover every mode, and conflating the two would either
truncate or falsely combine unrelated design systems.
**What it means for you.**

- A file-wide export fails rather than silently truncating past 2,000
  referenced Variables, unlike the legacy scoped collector.
- Alias color opacity (`COMPOSE_COLOR`) resolves to a visible alpha value in
  both formats while the Bridge extension keeps the original alias identity.

<!-- source: 0098 -->

### Sync tokens three ways without silent overwrites

**Decision.** `tokens sync` compares a DTCG JSON or CSS source, a prior
lockfile, and the live Figma Collection, and treats every disagreement among
the three as an explicit conflict rather than picking a side. Apply re-checks
the same three-way comparison immediately before the first write and stops at
the first operation failure.
**Why.** Silently preferring the source, the file, or Figma would eventually
overwrite someone's intentional change without telling them.
**What it means for you.**

- `--ours`/`--theirs` resolve conflicts explicitly per run; they are mutually
  exclusive.
- A successful lock is only published with freshly verified Variable ids, and
  a lock-publication failure after a real Figma change is reported as
  committed with bounded residue, never as a safe-to-retry state.

<!-- source: 0127 -->
