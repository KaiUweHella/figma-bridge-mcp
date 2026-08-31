# Resolve every command through a Command Capability

Every Adapter resolves a Figma Command into one immutable Command Plan before
execution. Unknown commands default to denied, mutating and non-retryable so
adding a command cannot accidentally bypass confirmation, targeting, path
normalization or audit policy.

Effects use one closed five-axis vocabulary: `figma`, `editor`, `workspace`,
`network` and `shared`, each with `none`, `read` or `write`. `figma` describes
document content; `editor` describes selection, viewport, focus and current-page
context. An editor write is auditable and non-retrying but does not by itself
require document-write confirmation. `network` records external outbound
access; the authenticated localhost Bridge transport remains an availability
fact. `shared` records persistent local state outside the workspace, including
downloaded reference material. Adapters may translate a Capability-owned
timeout class into deployment milliseconds, but they cannot replace that class
or the accepted outcome codes after planning.

The Capability Catalog resolves a closed recursive Figma Command Grammar before
those decisions. Every exposed nested action and documented alias has an
explicit canonical path; a contract compares that grammar with the real
Commander registration tree. Unknown nested actions are denied before
confirmation, Audit Trail creation, job scheduling or Adapter dispatch.
Accepted plans expose the canonical action path as a payload-free audit id,
never a positional value copied from argv.

The same Grammar resolution records only syntactic option names and indexes
before the first `--` terminator. Capability mutation, target, network,
shared-state, timeout and path policy consume those facts or a command's closed
request Interface; tokens after the terminator are always payload. The facts
never retain option values or payload content, and they do not replace
command-specific parsing, arity or validation.

Until a Legacy Command becomes a Command Application, every option that can
change those policies is declared in a small command-specific compatibility
schema inside the Grammar. It accepts Commander's separate, long-inline and
short-attached value spellings, but rejects unknown policy options, alias
duplicates, empty or missing values and declared conflicts before a Command
Plan can authorize effects. The global `--figma-file` target option receives
the same duplicate and value checks for every exposed action. This schema is a
bounded migration seam, not a second general-purpose Commander parser.

Path normalization happens before a lazy Design Link Registry lookup. The
Figma Target Context precedence is explicit caller target, a Figma URL from the
Command Capability's closed semantic target fields, Registry target, then
implicit single-window targeting. Whole argv is never searched, so text, JSX,
names, annotations, paths, labels, assets and unrelated option values cannot
retarget a Command. Repository-only commands carry a non-applicable target and
do not read the Registry.

The Command Application accepts only a Command Plan created by the Capability
Catalog. Process and in-process Adapters consume that exact plan; they do not
resolve the original arguments again. Confirmation, Audit Trail target,
tracked-job identity and Daemon Client targeting therefore describe the same
invocation. An implicit target remains implicit so the Bridge Daemon can reject
ambiguous multi-window execution rather than selecting an active file.

During incremental migration, a legacy Commander Adapter may still catch and
format an execution error locally, but it must retain a nonzero process outcome.
The shared error reporter sets `process.exitCode` without terminating reusable
code, and a source contract checks every user-visible top-level Action catch.
Inner recovery catches that deliberately continue a successful command remain
distinct; red failure output can never be the only failure signal.

Tracked jobs do not imply a process Adapter. `export assets` is an in-process
Command Application behind the same authentic plan used by Commander and MCP;
the MCP Adapter alone owns deduplication, bounded waiting, polling and the
short-lived success cache. Semantically equivalent default flags are
canonicalized before the job key is created. A total asset failure is an
execution failure and leaves an existing manifest unchanged; it is not added
to the plan's accepted domain outcomes.

Because Asset Export performs several Plugin reads, its Application requires
daemon-owned connection, file and document-revision metadata. The first read
pins that context, every later read must match, and a final revision fence runs
inside a process-safe output lock before the prior manifest is read. The lock
serializes the complete read-prior, plan and manifest-last publication across
CLI and MCP processes. Revision drift, an unsafe prior manifest filename, or a
lock deadline aborts without replacing the prior manifest.

The first representative canvas write, `node set-text`, also runs through one
Command Application from Commander and MCP. A closed request Interface owns
arity and the `--` literal boundary before confirmation. Its Command Plan is
non-retrying, one bounded readiness Adapter precedes exactly one Plugin
evaluation, and the same remaining deadline reaches both the Daemon Client
abort and the Daemon-to-Plugin execution timer. Every unique font preflight
settles before mutation, and invalid post-dispatch results cannot become code-0
success. Only the closed request's node-id field may contribute a Figma URL
file identity to the Figma Target Context; text payload never retargets the
write, while canonical argv retains only the semantic node id.

The representative top-level read, `inspect`, uses the same boundary rather
than treating a value-returning implementation alone as a completed migration.
Its closed request Interface preserves the established text, YAML, JSON and
Spec formats, accepts Commander options before or after the node, and projects
Figma URL identity only from that typed node field. Commander, `figma_run` and
`figma_inspect` execute the same authentic Plan, bounded readiness step,
decreasing deadline and safe-read retry policy without re-entering Commander.

The Figma-to-code `export code-spec` read follows the same rule. Its closed
request canonicalizes optional node/selection targeting, phase, depth, named
section, hidden-layer inclusion, output format and deduplication before the
Plan. Commander, `figma_run` and every bounded `figma_spec` read share one
Code Spec Command Application and decreasing capture deadline. MCP-only output
budgeting, lossless automatic deduplication and multi-node batching remain
presentation/orchestration concerns outside the Application; they do not
select another execution policy or re-enter Commander.

Neutral `export css` and `export dtcg` follow the same rule through one Token
Export Command Application. An explicit node captures bounded visible-subtree,
Style and paint bindings plus library Alias chains without whole-file fallback.
A file-wide request captures all local Variables in exact bounded chunks pinned
to one authenticated document revision and a stable final catalog. All modes
and declared defaults reach one host formatter; only DTCG may carry a planned
Workspace output, and publication follows complete capture and projection.

Verification screenshots follow the same rule. `verify`, `figma_screenshot`
and `figma_run` share one closed request and Screenshot Command Application.
Default temporary persistence, explicit workspace persistence and inline
Base64 are distinct Plan decisions; inline mode has no file output. Every
persisted PNG is an exact Verification Artifact in `plan.outputs` before
readiness. Private temporary paths use a command-owned namespace, while
workspace paths remain behind Workspace I/O.

Verification evidence never derives raster dimensions from logical node
geometry. The shared Application validates the bounded PNG signature and IHDR
before persistence and result projection, exposing exact pixel dimensions,
logical node dimensions and requested/applied scale as distinct facts.
When a nontrivial scaled node collapses to a one-pixel PNG axis, the Application
rejects that degenerate evidence before persistence. The error retains the
actual raster, logical and scaled geometry and points to a fresh Component
Inventory identity, exact Variant retry or parent Component Set capture. A
genuine one-pixel node remains valid.

Local structural history follows the same boundary. `history snapshot`,
`history list` and `history diff` use one closed request Interface and History
Command Application from Commander, `figma_run` and `figma_history`. The Plan
owns optional node targeting, exact local/shared and workspace effects,
changelog output paths, deadlines and the diff finding code. Snapshot
publication and reads remain behind the Structural Snapshot Store; JSON-only
snapshot preview declares no shared-state write and does not persist.

The lightweight `node tree` outline read follows the same boundary without
becoming a Design Capture. Its closed request owns the optional node, depth,
ID projection and URL target regardless of option order. Commander and
`figma_run` share one bounded Node Tree Command Application, safe-read policy
and decreasing deadline. Line, depth and total-output bounds are explicit and
truthful; malformed results and Plugin failures cannot become successful text.

Top-level `find` is a separate Node Discovery read over the fully loaded current
page. Its closed request owns the literal partial-name query, optional node type
and bounded result count before readiness. Commander and `figma_run` share one
safe-read Command Plan and Command Application; traversal stops at the requested
result count or a fixed visit ceiling, and both conditions remain explicit in
the output. Query and option values are data rather than generated executable
fragments, malformed Plugin results fail, and the command never implies a
cross-page Design Capture.

The neighbouring `node bindings` discovery read is a separate Node Binding
Facts Application rather than a partial Design Capture. Its closed request
owns optional node/selection targeting, JSON/text projection and semantic URL
identity. Scalar aliases, array positions and component-property names retain
their direct `node.boundVariables` topology together with bounded variable,
collection and type identity. Commander and `figma_run` share the same
safe-read Plan and decreasing deadline. Nested style/paint/effect and text-range
bindings, mode values, resolved values and provenance remain Design Capture
facts and are never implied by this outline.

Native Inspect `node css` is also a dedicated bounded read rather than a
Commander-owned eval. Its closed request owns the required node, JSON/text
projection and Figma URL target regardless of option order. Commander and
`figma_run` execute one safe-read Command Plan and Node CSS Command
Application with a decreasing deadline. Property count, names, values and
metadata are bounded below the Plugin protocol cap; invalid or oversized
results fail explicitly instead of being truncated into plausible CSS.

`component main` owns the adjacent Component Identity Facts read. Its closed
request accepts one semantic Instance Node Reference plus text or JSON
projection regardless of option order. Commander and `figma_run` execute one
target-bound safe-read Command Plan and Component Main Command Application.
Instance, main component, optional set, publish keys, variants and component
property facts cross the Plugin seam as one versioned, deeply bounded result;
invalid or oversized values fail rather than becoming plausible component
identity. Names remain display facts and never replace a key, node reference or
Design Entity link.

`style show` owns one exact Style Facts read rather than a polymorphic Legacy
eval. Its closed request accepts one bounded style id or local name; URL-shaped
names remain payload and cannot derive Figma Target Context. Commander and
`figma_run` execute one safe-read Command Plan and Style Facts Application.
PAINT, TEXT, EFFECT and GRID values, publishable Markdown/documentation
metadata and scalar/array Variable Alias topology cross the Plugin seam as one
versioned, deeply bounded result. Non-JSON numeric values use the explicit
Style Facts scalar tag instead of silently becoming `null`. Catalog and
consumer scans remain separate Applications with their own fanout limits.

`grid list` owns the node-side Layout Grid Facts read. Its closed request
canonicalizes optional node/selection targeting and text/JSON projection before
one safe-read Command Plan. Commander and `figma_run` share one versioned,
bounded Application that preserves `gridStyleId`, the exact ROWS/COLUMNS/GRID
union and Variable Alias topology. The official Auto count crosses JSON as the
shared `{"$figmaScalar":"Infinity"}` value; every other non-finite value and
every unknown union field fails before plausible output is returned.

`style list` owns a separate compact Style Catalog Application. Its closed
request canonicalizes optional family, bounded page limit and versioned
scope-bound cursor before one safe-read Plan. A family-scoped request loads
only that native catalog; an unscoped request loads all four independently and
sorts one deterministic identity view. Total, returned, omitted-before,
omitted-after, completeness and continuation are explicit, and malformed or
stale cursors fail rather than turning catalog drift into silent omissions.
Exact Style values and consumer scans remain separate Applications.

`style consumers` owns the document-wide native consumer read behind a longer
safe-read Plan. Its closed request canonicalizes bounded style resolution,
optional family, page limit and a query/family-bound continuation cursor.
The result distinguishes the complete but non-interruptible native
`getStyleConsumersAsync()` scan from the completeness of one projected page,
and preserves only compact node identity plus official inherited-style fields.
Candidate, page, byte and nested-value limits fail explicitly. This Application
does not claim a traversal budget the Figma API cannot enforce.

`style apply` owns a separate non-retrying mutation Application. Its closed
request canonicalizes one bounded Style reference, one field and at most 500
unique semantic Node References before confirmation or readiness. The Plugin
resolves the required Style family and preflights every target before the first
write, then mutates sequentially. A later failure rolls back confirmed prior
writes where their old Style ids remain recoverable and reports bounded possible
residue otherwise. Results contain compact identity only, so GRID Style values
cannot lose Auto Layout Guide counts through plain JSON. The readable
`layout-guide` field and backward-compatible `grid` alias both bind Grid Styles;
Auto Layout Grid remains exclusively under `layout grid`.

`style create` owns the adjacent journaled mutation Application. Its closed
request canonicalizes the Style family, bounded name and description, and one
type-specific bounded property object before confirmation or readiness. GRID
properties use the exact Layout Guide union and explicit Infinity scalar; TEXT
font resources load before the factory call. Once created, the local Style is
the only journal entry. Any later metadata, property, projection or size failure
removes it where Figma permits and otherwise reports one typed bounded Style
residue. Success projects compact identity only, so raw GRID values never cross
this mutation seam as lossy JSON.

`style update` owns the adjacent existing-resource mutation Application. Its
closed request canonicalizes one bounded Style reference, optional family,
metadata fields and one non-empty type-specific property object before
confirmation or readiness. Create and Update share one exact Style mutation
value contract. Font loading and all resolution checks precede the first
write; requested fields are snapshotted, assigned sequentially and restored
from the failing field backwards after an assignment error. Writes are never
retried. Success and failure expose compact identity plus field names rather
than raw Style values, so GRID Auto Layout Guide counts cannot become JSON
`null` on this compatibility path.

`style delete` owns the irreversible local Style removal Application. Its
closed request canonicalizes one bounded Style reference and optional family
before confirmation or readiness. Resolution is bounded, remote Styles are
rejected and removal is never retried. Success returns compact pre-removal
identity only; a thrown remover reports possible residue without claiming that
the existing Style was rolled back or projecting authored GRID values.

`style bind-font` and `style unbind-font` own one Text Style Variable Binding
Application. Their closed requests canonicalize one bounded Text Style
reference, one supported field and, for binding, one bounded local Variable
reference before confirmation or readiness. Style, type-compatible Variable
and prior binding resolution finish before the synchronous setter. A setter
failure attempts to restore the prior binding and reports possible residue if
that restoration fails. Writes are never retried, and only compact identities
cross the result seam.

`prototype inspect` is the exact bounded verification read for native Figma
prototype reactions. Its closed request owns one semantic Node Reference and
URL-derived target before readiness. Commander and `figma_run` execute one
safe-read Command Plan and Prototype Inspection Application. Trigger, action,
conditional, variable and transition facts remain complete within explicit
depth, collection, value, string and serialized-size limits; an excess fails
instead of returning a plausible partial interaction contract. Safe JSON text
escapes terminal controls without changing the parsed facts. Mutating
`prototype add`, `set` and `clear` share a separate action-discriminated
Prototype Mutation Application. It validates and bounds reaction JSON before
readiness, journals the complete prior set, invokes `setReactionsAsync()` once,
and compares a fresh readback. A mismatch restores the journal and reports
verified rollback, exact reaction residue or unavailable verification. A
native error followed by exact requested readback remains a successful
`verified-after-error` outcome. Both Adapters preserve this bounded result
through one decreasing non-retrying Plan deadline without Commander re-entry.

`var list` and `var find` own one bounded Variable Discovery Application.
Their closed request owns list/search intent, one optional literal `*`
wildcard pattern, output mode and result limit before readiness. Commander and
`figma_run` execute the same safe-read Command Plans. Results preserve stable
variable and collection identities plus type in deterministic order; candidate,
row, label and serialized-size limits fail or report explicit omission rather
than returning an unbounded name dump. Other regex syntax is inert text.

`col list` owns the adjacent compact Collection Catalog. Its closed request
owns output mode and result limit before readiness. Commander and `figma_run`
execute one safe-read Command Plan and deterministic Application that preserves
stable id, key, name, extension and publishing flags plus mode and Variable
counts. Collection, per-collection membership and serialized-size limits fail
or report explicit omission rather than returning an unbounded collection dump.

`col show` is a separate exact Collection Facts read. Its closed request owns
one collection id/name as payload and never derives Figma Target Context from
it. Commander and `figma_run` execute one safe-read Plan and Application that
preserves publish status, default mode, every mode identity and Variable
membership within explicit candidate, mode, string and serialized-size bounds.
Ambiguous names and malformed results fail rather than selecting a collection
or projecting plausible partial facts. Collection and Variable mutations remain
separate non-retrying Commands.

`var show` is a separate Variable Facts read for exact token metadata. Its
closed request owns one variable id/name and an optional collection id/name;
neither payload field contributes a Figma URL target. Commander and
`figma_run` execute one safe-read Command Plan and Variable Facts Application.
The versioned result preserves supported VariableValue shapes, mode and alias
identity, scopes, code syntax, collection metadata and publish status within
explicit depth, collection, value, string and serialized-size limits.
Ambiguous names and invalid or oversized results fail instead of selecting or
truncating. Consumer-specific resolution and all variable mutations remain
separate Commands.

`var resolve` owns the adjacent Resolved Variable Value read. Its closed
request keeps variable and collection queries as payload while one semantic
Node Reference alone may project a Figma URL target. Commander and `figma_run`
execute one target-bound safe-read Command Plan and Variable Resolution
Application. The versioned result preserves variable, collection and consumer
identity plus the official typed `resolveForConsumer` value within explicit
string and serialized-size limits. It neither claims the variable is directly
bound to the consumer nor replaces authored mode metadata from Variable Facts.

`font inspect` owns the adjacent Typography Inspection Facts read. Its closed
request preserves one semantic Text Node Reference, optional character range
and the complete OpenType feature projection flag regardless of option order.
Commander and `figma_run` execute one target-bound safe-read Command Plan and
Font Inspection Application. Character, segment, feature, binding, metadata
and serialized-size limits fail explicitly instead of returning plausible
partial typography. The result keeps Figma's numeric `fontWeight` and authored
Plugin axis metadata distinct: it does not invent the general variation-axis
tuple that the Figma Plugin API does not expose. Typography binding mutations
and metadata writes remain separate Commands.

`font bind` and `font unbind` own the adjacent Node Typography Variable Binding
write. Their closed request preserves one semantic Text Node Reference,
supported field, optional character range, and bounded Variable/Collection
queries regardless of option order. Commander and `figma_run` execute one
non-retrying Command Plan and Command Application. Success requires fresh
field/range readback of the exact requested Variable Alias id (or exact unbound
state); silent setter no-ops and mismatches restore the prior binding or report
bounded residue. The write never re-enters Commander or creates a second MCP
approval.

Current-page Canvas Awareness follows the same rule for `canvas info` and
`canvas next`. Their closed request Interface owns the complete option surface,
including bounded numeric gaps and the `right|below` direction. Commander and
`figma_run` execute one safe-read Command Plan and Canvas Awareness Command
Application after dynamic page loading. The Plugin result is structurally
validated before projection, and placement options select static generated
code rather than crossing the Plugin seam as executable input.

Page Navigation is adjacent but separate. `canvas pages` is a bounded safe
read with `editor: read`, while `canvas page` retains `figma: read`, declares
`editor: write`, requires no document-write confirmation and is never retried.
Their closed request Interface preserves literal dash-prefixed queries after
`--`; Commander and `figma_run` share one authentic Plan, deterministic
id/exact-name/unique-substring resolution, bounded ambiguity and result
validation, and control-safe text projection. Page creation and other document
mutations remain outside this Application.

The mutating `canvas page-create` and `canvas page-divider` actions form a
separate Page Structure Application. Their closed request owns page names,
switch intent, optional divider index and output format before confirmation.
Both Adapters execute one non-retrying write Plan. Duplicate page names and
divider indexes are checked before creation, and optional divider names must
retain Figma's native all-asterisk, all-dash or all-space semantics. If a later
rename, page switch or divider insertion fails, the Application removes the
object it created where Figma permits and reports bounded possible residue
otherwise. Page creation declares `editor: write` only when its closed switch
intent makes the new page current; `--no-switch` and page-divider creation
declare `editor: none`.

The incremental Legacy Write migration now also owns `node rename`. Its closed
request preserves empty and dash-prefixed names, projects URL target identity
only from the Node Reference and feeds one non-retrying Command Plan to the
same Application from Commander and `figma_run`. A matching name is a no-op;
otherwise a fresh exact-id readback, rather than the setter acknowledgement,
decides success. Mismatches restore the previous name once and emit the shared
bounded mutation outcome as verified rollback, partial residue or unavailable
verification. This reduces the explicit direct Node Write inventory without
changing another Legacy Command's compatibility behavior.

`node resize` follows as another bounded Legacy Write migration. Its closed
request treats numeric, KEEP, FILL and HUG axis intent as data, retains signed
numeric tokens through an explicit literal boundary and projects URL identity
only from the Node Reference. Commander and `figma_run` execute one
non-retrying Application. Numeric and KEEP postconditions verify both geometry
and sizing mode; FILL and HUG verify their native modes while reporting actual
dimensions separately. Failure restores and freshly verifies both prior sizes
and both prior modes, producing the shared rollback, residue or unavailable-
verification outcome instead of accepting a partial two-axis write.

`node reparent` follows the same incremental seam for hierarchy mutation. Its
closed request keeps child identity, destination identity, optional final
index, canvas-position intent and JSON projection together before readiness;
two Figma URLs must identify the same target file. Commander and `figma_run`
execute one non-retrying Application. The Application bounds and snapshots the
complete source and destination child order, rejects cycles before mutation,
and accepts success only after fresh exact hierarchy readback. Canvas-position
preservation remains a separate observed result because Auto Layout can make
it inapplicable. A mismatch restores the original parent, child index and local
position and then reports verified rollback, bounded residue or unavailable
verification rather than trusting the mutation acknowledgement.

`node group` is the adjacent multi-parent structural slice. Its closed request
bounds and canonicalizes every selected Node Reference plus optional parent,
final index, name and JSON projection; any URL identities must name one file.
Commander and `figma_run` execute one non-retrying Application. Preflight
captures every affected parent order and selected local position, including
cross-parent grouping behind an explicit destination. Success requires fresh
Group identity, exact selected membership and exact readback of every affected
parent. A mismatch uses the new Group as the rollback boundary, ungroups it,
restores original parents, indices and positions, and reports verified
rollback, bounded residue or unavailable verification.

`node ungroup` closes the inverse public action without pretending it is
generically reversible. One exact Group or Transform Group is preflighted with
its full bounded child order and original parent position. Commander and
`figma_run` execute one non-retrying Application and accept success only when a
fresh read proves the group absent, the ordered children spliced into its old
index and every child attached to the old parent. If the native operation
throws or verification disagrees, a freshly unchanged hierarchy is explicit;
otherwise the Application reports bounded group, parent-order and child-parent
residue or unavailable verification. It does not recreate a lossy stand-in for
an arbitrary Transform Group.

`node flatten` owns the adjacent irreversible Vector replacement. Its closed
request bounds all source Node References plus optional destination, final
index, name and JSON projection, rejecting duplicate or cross-file identities
before readiness. One non-retrying Application snapshots every affected
parent order and accepts success only after fresh proof of the native Vector,
its exact destination replacement, removal of obsolete source identities and
unchanged non-destination parent order. Because arbitrary source geometry
cannot be reconstructed losslessly, a mismatch reports freshly unchanged
state, bounded Vector/source/parent residue or unavailable verification rather
than fabricating rollback.

`node boolean` owns the adjacent Boolean Operation replacement. Its closed
request bounds and canonicalizes the operation, ordered source Node References,
optional destination, final index, name and JSON projection; URL identities
must name one file. Commander and `figma_run` execute one non-retrying
Application whose executable branch is selected only from the four closed
operations. Success requires fresh proof of a `BOOLEAN_OPERATION`, the matching
official operation enum, exact ordered source membership and exact replacement
in every affected parent. A thrown or mismatched native operation reports
freshly unchanged state, bounded Boolean/parent/member residue or unavailable
verification instead of trusting the returned node or claiming synthetic
reconstruction.

`node bind` owns the adjacent single-Node Variable mutation while the separate
`node bindings` Application remains its read-only discovery counterpart. The
closed request canonicalizes one Node Reference, supported property, Variable
query and optional Collection query; ambiguous resources and `--batch` fail
before readiness. One shared non-retrying Application journals the complete
prior scalar alias topology or Paint list, applies the exact legacy single-
property outcome and accepts success only from fresh alias readback. Padding
and independent-corner bindings are verified as multi-field topology. A
partial setter or postcondition mismatch restores and re-reads the full prior
topology, otherwise reporting bounded field residue or unavailable
verification. Commander and `figma_run` do not retain a second binding path.

`node set-fill` owns the narrower complete-Paint-list replacement. Its closed
request preserves literal RGB and explicit `var:` intent while rejecting
ambiguous exact Variable names instead of selecting the first matching
Collection. One shared non-retrying Application snapshots the complete prior
Paint list and accepts success only after fresh proof of the exact literal RGB
or Variable alias on the single resulting Solid Paint. A mismatch restores and
re-reads the complete prior list, otherwise reporting bounded fill residue or
unavailable verification. Commander and `figma_run` share that same outcome
semantics and retain no direct fill mutation path.

`node set-image` owns the adjacent workspace-backed Image Paint replacement.
Its closed request preserves the legacy scale modes and the legacy fallback of
unknown scale values to `FILL`, while the Capability Catalog canonicalizes and
authorizes the source path before Plugin readiness. One shared non-retrying
Application creates the Image resource, replaces the complete Paint list and
requires fresh Image-hash, scale-mode and default-presentation readback.
Placeholder annotation clearing remains best-effort but its effective outcome
is explicit. A mismatch restores and verifies the prior Paint and annotation
fields; because Figma has no Image-resource deletion operation, every failure
after `createImage()` still reports possible Image-resource residue instead of
claiming complete rollback. Commander and `figma_run` share this exact seam.

Generic `node set` completes the direct Node Write migration without widening
its disabled batch surface. Its closed request owns one Node Reference, the
legacy typed property vocabulary, optional Collection query and deterministic
property order. Commander and `figma_run` execute one non-retrying Command
Application. Before the first setter, the Application resolves every supported
Paint Variable without first-match ambiguity and journals every supported
scalar, Paint list, effect list, corner, constraint, padding and size field.
Unsupported properties remain bounded `skipped` facts; a request with no
supported property is a no-mutation refusal. Success requires one fresh read
matching every effective property. A setter failure or mismatch restores the
complete journal in reverse order and reports verified rollback, exact
property residue or unavailable verification. Explicit `var:` bindings remain
native aliases, literal colours remain literal, and `--batch` stays gated until
it has its own bounded typed mutation contract.

`create frame` is the first primitive-creation tracer off the compatibility
process seam. Its closed request canonicalizes bounded geometry, smart
positioning, optional parent/index, literal fill or explicit `var:` fill and
corner radius; a parent URL contributes target identity but never reaches the
Plugin payload. Commander and `figma_run` execute one non-retrying Application
under the Plan deadline. Resource and hierarchy preflight happen before the
single `createFrame()` call, and success requires fresh identity, membership,
geometry, Paint, radius and selection readback. Failure removes only the new
frame and restores selection, then reports verified rollback, exact created-
node/membership/selection residue or unavailable verification. A mechanical
public Create-family legacy-write budget records the remaining actions and may
only decrease as adjacent primitives migrate.

Rectangle, Ellipse, Polygon and Star form the adjacent solid-Shape creation
Application. One closed union preserves their aliases, defaults and distinct
options while allowing only the four corresponding native factory calls.
Literal and explicit Variable fill/stroke resources resolve before creation;
duplicate exact Variable names are a no-mutation refusal. The shared
Application freshly verifies factory type, parent order, geometry, Paints,
Rectangle radius/opacity and Polygon/Star point geometry, then removes only its
new Shape and restores selection on failure. Both Adapters consume the same
non-retrying Plan and bounded outcome. The mechanically pinned public Create
legacy-write count consequently falls from nine to five.

Vector and Slice share the adjacent Canvas Node creation Application. Its
closed union preserves their distinct options and existing smart-position gap;
VectorNetwork JSON is bounded before dispatch and compared exactly after the
asynchronous setter. Slice geometry and both kinds' identity, hierarchy,
position and selection require fresh readback after one native factory call.
Failure removes only the newly created node, restores selection and reports
verified rollback, exact residue or unavailable verification. Both Adapters
consume the same non-retrying Plan and bounded outcome. The mechanically pinned
public Create legacy-write count consequently falls from five to three.

Line creation is a separate closed Application because endpoint-derived
rotation and zero-height geometry do not share the solid-Shape contract. It
preserves the existing smart-position gap and length fallback, resolves an
explicit stroke Variable before the factory call without first-match
ambiguity, and freshly verifies hierarchy, geometry, rotation, Paint, stroke
weight and selection. Failure removes only the newly created Line, restores
selection and reports verified rollback, exact residue or unavailable
verification. Both Adapters use the same non-retrying Plan and bounded outcome;
the mechanically pinned public Create legacy-write count falls from three to
two.

Auto Layout creation remains distinct from generic Frame creation because its
closed result must prove layout direction, both hug-sizing modes, uniform gap
and padding as well as its optional Paint and radius. The Application preserves
the `al` alias and existing smart-position behavior, resolves explicit
Variables before its one factory call, then freshly verifies hierarchy,
selection and every requested layout fact. Failure removes only the new Frame
and reports verified rollback, exact residue or unavailable verification. Both
Adapters use the same non-retrying Plan and bounded outcome; the mechanically
pinned public Create legacy-write count falls from two to one.

Text creation completes the public Create-family migration. Its closed request
bounds content without echoing it in the result, normalizes the supported font
weights, and preserves intrinsic versus fixed-width auto-resize behavior. The
Application resolves an explicit fill Variable and loads the exact font before
the first factory call. It then freshly verifies characters, font, size, Paint,
geometry, hierarchy and selection. Failure removes only the new Text node and
reports verified rollback, exact residue or unavailable verification. Both
Adapters use the same non-retrying Plan and bounded outcome; the mechanically
pinned public Create legacy-write count reaches zero.

Dev Mode Measurement add, edit and delete form one action-discriminated write
Application. Its closed request canonicalizes endpoint sides, URL-derived file
identity, fixed/relative offsets and bounded free text. Preflight requires Dev
Mode, exact nodes or Measurement identity and a bounded unique page inventory.
Fresh collection readback proves every mutation. Add removes only its new
Measurement on failure; edit restores the prior offset and text; irreversible
delete distinguishes verified deletion, unchanged state, partial residue and
unavailable verification. Both Adapters consume the same non-retrying Plan and
bounded outcome without Commander re-entry.

Published Variable, Style, Component and Component Set imports form one closed
irreversible Library Import Application. The request admits exactly one bounded
stable key and selects exactly one corresponding native import method. After
that single call, a fresh lookup by returned id must prove the requested key,
resource kind and remote identity; Variable imports also prove their remote
Collection. Descriptions are bounded before crossing the Plugin seam. Because
Figma exposes no safe inverse and the imported resource may have existed before
the call, a native error or unavailable lookup reports possible unknown residue,
while a mismatched fresh identity reports partial residue. Neither case deletes
or retries the resource. CLI and MCP share the same decreasing deadline and
non-retrying Plan; the mechanically pinned direct Library Import legacy-write
count reaches zero.

Shader import and apply form one action-discriminated Shader Mutation
Application. Its closed request bounds the Shader id and property JSON, admits
only fill, stroke or effect placement, and projects file identity only from the
apply target Node Reference. Import invokes `importShaderById` exactly once and
then verifies exact id, imported state and type against a fresh bounded
`listAvailableShaders` result. With no safe inverse, native or verification
uncertainty reports possible residue and is never retried. Apply does not import:
it requires one uniquely available, already imported and type-compatible
Shader, journals the complete existing field, assigns once and verifies fresh
placement while preserving the existing prefix unless replacement was explicit.
A mismatch restores the journal when possible and otherwise reports exact field
residue. CLI and MCP share one decreasing deadline, bounded response and
non-retrying Plan; the mechanically pinned direct Shader legacy-write count
reaches zero.

Slot creation and Slot-property editing form one configuration Application,
while reset is a distinct irreversible Application. The closed request bounds the
Component Node Reference, generated property name, `SlotSettings`, preferred
published Component keys and description. Create snapshots existing Slot and
definition identities, calls `createSlot()` once, optionally edits the newly
created definition, and freshly proves one exact descendant plus one definition.
Failure removes only those new identities and reports any remaining or missing
topology. Edit resolves one exact full property name, journals its effective
configuration, preserves unspecified settings, and freshly proves the returned
name and definition; failure restores the journal when possible. CLI and MCP
share one decreasing deadline and non-retrying Plan without Commander re-entry.
`slot reset` separately snapshots bounded child identities and limit violations,
calls `resetSlot()` exactly once, then reads the resulting Slot facts freshly.
A normal native return plus fresh readback is `native-confirmed`, not an
independently derived default-state proof. Because the Plugin API exposes
neither the target default subtree nor a safe inverse, any dispatch error or
missing readback is `verification-unavailable` and is never retried. The
mechanically pinned direct Slot legacy-write count reaches zero.

`layout grid auto-flow` owns the first mutation slice of the Auto Layout Grid
family. Its closed request treats `gridAutoTracks` and
`gridItemsPositioning` as one coupled intent and preserves only the official
`NONE|ROWS` and `MANUAL|ROW_AUTO_FLOW` values. One shared, non-retrying
Application snapshots both fields, avoids exact no-ops, assigns each field at
most once, and requires fresh proof of both values. A thrown setter with an
exact fresh result is `verified-after-error`; every other mismatch restores
and re-reads both prior fields, then reports verified rollback, exact field
residue or unavailable verification. Commander and `figma_run` retain no
second auto-flow write path. The measured remaining Auto Layout Grid legacy
writes are `set`, `place`, `reorder-rows`, and `reorder-columns`.

All migrated Command Applications now share one Command Failure Outcome
projection. It validates the closed terminal Dispatch state and version-1
mutation report, accepts only the reviewed mutation outcomes and bounded
cardinalities, and drops residue identities plus implementation-specific
details. CLI error text, MCP structured error content and private Audit schema
6 therefore carry the same attempted, restored and residue counts. Existing
typed mutation-report property names remain readable through an explicit
allowlist; new Applications use `mutationReport`. Invalid or forged reports
are omitted rather than converted into policy evidence. Audit History keeps
schemas 2–5 readable and folds schema-6 Dispatch and mutation facts forward.
