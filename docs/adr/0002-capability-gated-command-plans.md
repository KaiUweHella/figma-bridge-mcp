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
