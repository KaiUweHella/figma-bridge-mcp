# Resolve every command through a Command Capability

Every Adapter resolves a Figma Command into one immutable Command Plan before
execution. Unknown commands default to denied, mutating and non-retryable so
adding a command cannot accidentally bypass confirmation, targeting, path
normalization or audit policy.

Effects use one closed four-axis vocabulary: `figma`, `workspace`, `network`
and `shared`, each with `none`, `read` or `write`. `network` records external
outbound access; the authenticated localhost Bridge transport remains an
availability fact. `shared` records persistent local state outside the
workspace, including downloaded reference material. Adapters may translate a
Capability-owned timeout class into deployment milliseconds, but they cannot
replace that class or the accepted outcome codes after planning.

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
`prototype add`, `set` and `clear` remain separate non-retrying Commands.

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
read, while `canvas page` changes only the current editor page and is therefore
never retried. Their closed request Interface preserves literal dash-prefixed
queries after `--`; Commander and `figma_run` share one authentic Plan,
deterministic id/exact-name/unique-substring resolution, bounded ambiguity and
result validation, and control-safe text projection. Page creation and other
document mutations remain outside this Application.

The mutating `canvas page-create` and `canvas page-divider` actions form a
separate Page Structure Application. Their closed request owns page names,
switch intent, optional divider index and output format before confirmation.
Both Adapters execute one non-retrying write Plan. Duplicate page names and
divider indexes are checked before creation, and optional divider names must
retain Figma's native all-asterisk, all-dash or all-space semantics. If a later
rename, page switch or divider insertion fails, the Application removes the
object it created where Figma permits and reports bounded possible residue
otherwise.
