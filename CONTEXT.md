# Figma Bridge

Figma Bridge exposes safe, scriptable Figma operations to both MCP agents and
human CLI users while preserving one authenticated plugin transport.

## Language

**Figma Command**:
One validated request to read from or write to a specifically targeted Figma file. A command has one audit lifecycle regardless of which adapter invokes it.
_Avoid_: CLI command, MCP call

**Command Application**:
The value-returning execution of a **Figma Command**, independent of Commander, MCP, console output, or process exit behaviour.
_Avoid_: handler, command service

**Command Capability**:
The resolved policy for one concrete **Figma Command** before execution: Adapter exposure, Figma/workspace/external-network/shared-local-state effects, target requirement, normalized paths, confirmation, retry, timeout, accepted exit codes and background-job identity. External network excludes the authenticated localhost Bridge transport, which is recorded separately as availability.
_Avoid_: allowlist entry, command metadata

**Figma Command Grammar**:
The closed recursive set of exposed Figma Command action paths and documented aliases. It resolves argv to a stable payload-free action id and syntactic option facts from before the first `--` terminator before capability policy, confirmation, audit or Adapter dispatch. Migrated Command Applications own a closed request Interface; policy-relevant Legacy Commands instead have a small compatibility option schema that rejects unknown, duplicate, valueless or conflicting policy options while preserving Commander short and inline value forms. Unknown nested actions are not commands and later tokens are payload.
_Avoid_: Commander fallback, subcommand allowlist

**Command Plan**:
The immutable decision produced for one **Figma Command** after path normalization and **Figma Target Context** resolution. It carries the exact argv, effects, confirmation, retry, timeout, output, audit and tracked-job decisions consumed unchanged by the Command Application and its process or in-process Adapter.
_Avoid_: prepared arguments, execution options, mutable command context

**Design Capture**:
The canonical, lossless Figma facts collected for one node and one set of capture options, bound to a Bridge Daemon connection and document revision. It keeps authored Figma facts, Figma heuristics and Code-to-Figma source intent under explicit provenance rather than flattening them into one claim. Structure, style, deduplication, enrichment and serialization are projections of a Design Capture, never inputs that reduce it.
_Avoid_: walker output, cache entry

**Node Binding Facts**:
The bounded, versioned outline of direct `node.boundVariables` for one explicit node or the current selection. It preserves scalar aliases, array positions and component-property names, and resolves variable id, name, type and collection identity when available. It is a fast discovery read, not a complete provenance claim: bindings inside style, paint, effect or text-range structures, mode values and resolved runtime values remain Design Capture concerns.
_Avoid_: binding dump, token proof, complete variable capture

**Component Identity Facts**:
The exact, versioned and deeply bounded resolution of one explicit Figma
Instance to its main component and optional component set. It preserves native
node and publish keys, remote status, variants, current variant/property values
and property definitions through one shared safe-read Command Application. It
is identity evidence for reuse and follow-up reads, not a Design Entity link,
full component inventory or permission to mutate the instance.
_Avoid_: component dump, name-based component identity, component mutation

**Style Facts**:
The exact, versioned and deeply bounded read of one Figma PAINT, TEXT, EFFECT
or GRID style by id or unambiguous local name. It preserves publishable
identity and metadata, authored family-specific values, nested Variable Alias
topology and explicitly tagged non-JSON numeric semantics through one shared
safe-read Command Application. It is lightweight style evidence, not resolved
Variable values, consumer discovery, binary asset retrieval, shader
definitions, arbitrary Plugin data or a complete Design Capture.
_Avoid_: style dump, flattened CSS style, resolved token value, style consumer scan

**Style Catalog**:
The compact, versioned and bounded inventory of local Style identities. It
loads one requested family or all four families concurrently, sorts stable
type/name/id anchors, and reports total, returned, omitted, completeness and a
scope-bound continuation cursor through one safe-read Command Application.
Catalog rows are follow-up handles, not authored Style Facts or document-wide
consumer evidence.
_Avoid_: style dump, complete style values, offset-only pagination, consumer scan

**Style Consumer Facts**:
The compact, versioned and paginated evidence returned by Figma's native
document-wide Style consumer scan. It preserves resolved Style identity,
consumer node identity and exact inherited-style fields, while separately
reporting native-scan completeness and page completeness through one long
safe-read Command Application. The native API is complete but not
interruptible, so these facts do not claim a visit budget.
_Avoid_: bounded traversal claim, style dump, unpaged document scan, mutation

**Style Publish Status Facts**:
The compact, versioned read of one local Style's official UNPUBLISHED, CURRENT
or CHANGED state. It preserves resolved Style identity and optional family
scope through one shared safe-read Command Application, while complete authored
Style values remain a separate Style Facts read.
_Avoid_: style dump, authored values, publication write, inferred status

**Style Apply**:
The bounded, non-retrying application of one resolved PAINT, TEXT, EFFECT or
GRID Style to an explicit ordered node set. It resolves and preflights every
target before the first write, applies sequentially, rolls back confirmed prior
changes after a later failure where the previous Style id is recoverable, and
reports possible residue otherwise. Its `layout-guide` field and legacy `grid`
alias bind a Grid Style through `setGridStyleIdAsync`; they never mutate Auto
Layout Grid properties.
_Avoid_: style helper, bulk style eval, auto-layout grid mutation, atomic claim

**Style Creation**:
The bounded, non-retrying creation of one local PAINT, TEXT, EFFECT or GRID
Style. It closes the complete request and supported property shape before
readiness, performs fallible resource preflight such as font loading before the
factory call, journals the created Style immediately, and removes it if later
metadata or property assignment fails. Cleanup failure returns typed bounded
Style residue; success returns compact identity rather than raw Style values.
_Avoid_: create-then-configure helper, unjournaled Style factory, raw Style result

**Style Update**:
The bounded, non-retrying mutation of one resolved local PAINT, TEXT, EFFECT or
GRID Style. It closes metadata and type-specific property input before
readiness, loads fallible resources before the first write, snapshots every
requested field, mutates sequentially and restores the failing field plus
confirmed prior fields in reverse order after an assignment error. Results and
failure evidence contain compact identity and field names, never raw Style
values; failed restoration reports possible residue instead of atomicity.
_Avoid_: style patch eval, best-effort update, raw Style result, atomic update claim

**Style Deletion**:
The bounded, non-retrying removal of one resolved local Style. It closes query
and optional family narrowing before readiness, rejects remote Styles, and
returns only the removed compact identity. A removal error reports that the
target may remain; deletion is irreversible and never described as rollback.
_Avoid_: style delete eval, raw deleted Style, retryable delete, rollback claim

**Layout Grid Facts**:
The exact, versioned and deeply bounded read of layout guides on one explicit
Figma frame-like node or the current selection. It preserves the linked Grid
Style id, ROWS/COLUMNS/GRID union topology, colors, per-field Variable Aliases
and Auto counts through one shared safe-read Command Application. Auto is the
explicit scalar tag `{"$figmaScalar":"Infinity"}`, never lossy JSON `null`.
It is node-side layout-guide evidence, not auto-layout GRID, a mutation or a
complete Design Capture.
_Avoid_: grid dump, null Auto count, auto-layout grid, grid mutation

**Variable Facts**:
The exact, versioned and deeply bounded read of one local Figma variable by id
or unambiguous name, optionally scoped to one collection. It preserves authored
mode values and aliases, type, scopes, code syntax, collection/mode identity and
publish status through one shared safe-read Command Application. It is token
metadata, not a consumer-specific resolved value or permission to mutate a
variable.
_Avoid_: variable dump, resolved token value, variable edit

**Resolved Variable Value**:
The exact, versioned and bounded result of resolving one local Figma variable
for one explicit Scene Node. It preserves variable, collection and consumer
identity together with Figma's official typed `resolveForConsumer` value
through one shared safe-read Command Application. It is consumer-context
evidence, not authored mode metadata, a direct-binding claim or permission to
mutate the variable or node.
_Avoid_: resolved token dump, inferred binding, global token value

**Typography Inspection Facts**:
The exact, versioned and bounded Figma-reported typography for one explicit
Text Node or character range. It preserves styled segment boundaries, text,
font family/style, numeric weight, OpenType feature state and typography
Variable identities through one shared safe-read Command Application. Optional
variable-axis tuples are explicitly Plugin metadata and never claimed as Figma
rendering state because the Plugin API does not expose the general variation
axis tuple.
_Avoid_: font dump, inferred variable axes, CSS typography

**Node Discovery**:
The bounded depth-first search of the fully loaded current Figma page by
case-insensitive partial node name and optional node type. It returns stable
follow-up node ids through one shared safe-read Command Application and reports
result or traversal limits truthfully; it is neither a Design Capture nor an
implicit cross-page scan.
_Avoid_: find eval, document search, unbounded node walk

**Prototype Inspection**:
The exact, versioned and deeply bounded read of one explicit node's native
Figma prototype reactions. It preserves triggers, actions, conditional blocks,
variable operations and transitions as authored JSON facts through one shared
safe-read Command Application; it is interaction evidence, not executable
application behavior or permission to mutate reactions.
_Avoid_: reaction dump, prototype eval, application-flow proof

**Canvas Awareness**:
The bounded read-only aggregate of the fully loaded current Figma page used for
safe Code-to-Figma placement. It reports top-level bounds and counts or one
gap-aware next position through a shared Command Application; it is neither a
Design Capture nor permission to mutate or scan other pages.
_Avoid_: canvas eval, document layout dump, placement guess

**Page Navigation**:
The bounded listing of current-document pages and the explicit non-retrying
switch of Figma's current editor page through one shared Command Application.
It changes editor context, not document content, and never creates, deletes,
renames, or guesses a page when a query is ambiguous.
_Avoid_: page eval, document mutation, implicit page selection

**Page Structure**:
The non-retrying creation of a named Figma page or native page divider through
one shared Command Application. It preflights duplicates and document indexes
and enforces Figma's native divider-name grammar before mutation, owns rollback
of a Command-created object when a later stage fails, and reports possible
residue instead of claiming atomicity.
_Avoid_: page helper, unchecked divider insertion, silent partial creation

**Verification Artifact**:
A PNG evidence file whose exact path, scope, retention owner and output role are
fixed by the owning **Command Plan** before Figma readiness or dispatch.
Workspace artifacts use Workspace I/O; temporary artifacts use one private
directory. Inline Base64 declares no file. Bounded PNG IHDR dimensions stay
distinct from logical node geometry and requested/applied scale.
_Avoid_: screenshot temp file, incidental render output

**Structural Snapshot Store**:
The sole private shared-state Module for local structural history. It maps one
Figma file identity to one collision-resistant namespace, publishes canonical
timestamp snapshots with private permissions, and returns opaque refs for
bounded listing, resolution and reads. Host paths, symlinks and arbitrary
objects never become snapshot authority.
_Avoid_: history folder, gzip helper, snapshot path

**Design Contract**:
A reviewed, repository-owned projection of one Design Entity's complete Design Capture. Its canonical layer removes volatile Figma handles for exact drift detection; its semantic rules enforce component existence, variant axes and exhaustiveness, token-binding floors, geometry tolerances and prototype transitions. Incomplete captures cannot become contracts.
_Avoid_: screenshot snapshot, prose guideline, node-id fixture

**Bridge Daemon**:
The authenticated localhost process that routes a **Figma Command** to exactly one connected Figma plugin window.
_Avoid_: backend, proxy

**Daemon Client**:
The sole local interface to the **Bridge Daemon**, owning request signing, file targeting, timeouts, health and transport-error semantics.
_Avoid_: fetch helper, daemon wrapper

**Bridge Daemon Error**:
The bounded, versioned failure facts produced where a **Figma Command** fails across the Bridge Daemon seam. Its kind, phase and execution outcome distinguish work that was not dispatched from work whose result is unknown after dispatch; user-facing prose never authorizes retry or recovery.
_Avoid_: error string, HTTP failure, retry hint

**Dispatch Receipt**:
The bounded, versioned proof that one authenticated Plugin execution belongs to one request, connection epoch, file or draft session, expected editor and advertised operation capability. The Bridge Daemon prepares it from the selected connection; the Figma Plugin validates it immediately before execution and echoes the same identity with one terminal state. Receipt identity remains internal; Audit and user projections expose only the closed terminal state.
_Avoid_: message id, current-file check, socket metadata

**Plugin Write Lane**:
The bounded, deadline-aware serialization boundary for mutations against one resolved Plugin document session. Queue expiry and cancellation before start are not dispatched; an unknown dispatched outcome quarantines only that target until the exact Dispatch Receipt proves the Plugin operation has stopped or an explicit recovery proves the old runtime stopped. Other document sessions remain independent.
_Avoid_: global mutex, eval chain, request timeout

**Structured Mutation Journal**:
The request-scoped ownership record for resources and scene nodes created by one native Semantic Render execution. It cleans removable Command-owned entries in reverse creation order, never includes reused user/library resources, and reports bounded stable residue when Figma exposes no reversal API or cleanup fails.
_Avoid_: Figma undo, atomic transaction, version restore

**Runtime Soak Report**:
The closed maintainer evidence from a sustained two-file Bridge session. It records bounded latency, recovery outcomes, cross-target mismatches, uncertain-write residue and cleanup state using target aliases only; Figma file keys, document names, node names, argv and error prose never enter the report.
_Avoid_: debug log, connection dump, live file transcript

**MCP Server Identity**:
The stable `figma-bridge-mcp` attribution attached to every tool result, with the `figma-bridge` namespace and a server-local failure scope. It lets agents distinguish this Bridge transport from other installed Figma MCPs; one server failure never proves Figma or another server unavailable and never authorizes switching write semantics.
_Avoid_: tool prefix, Figma availability

**Figma Target Context**:
The immutable resolution of exactly one plugin file for a **Figma Command**, including whether the file came from an explicit key, a Figma URL in a Command Capability's closed semantic target field, a Design Link Registry, or the single connected window. Payload argv is never searched for targets.
_Avoid_: fileKey parameter, current window

**Node Reference**:
The bounded semantic identity accepted by closed node-bearing Figma Command Interfaces. It canonicalizes bare, dashed, instance-path and Figma-URL forms for Plugin dispatch while retaining URL warning and file-target facts only for Command planning. Required or optional arity remains owned by each Figma Command.
_Avoid_: raw node string, URL argument

**Asset Policy**:
The canonical classification of image fills, vector artwork and vector clusters shared by **Design Capture** projections and asset export. Node-side and plugin-side adapters apply the same policy implementation.
_Avoid_: vector heuristic, exporter rule

**Asset Export**:
The manifest-last **Command Application** that pins one Figma connection and document revision, collects image/vector identities from one Figma root, fetches each byte payload, plans stable cross-run filenames and publishes workspace files without overwriting unrelated content. Commander and MCP share the same implementation; tracked-job polling remains an MCP Adapter concern, while an output lock serializes manifest merges across processes.
_Avoid_: export loop, background CLI command

**Node Text Mutation**:
The closed **Command Application** that replaces one TEXT node's characters only after every unique authored font has completed preflight. Its request preserves literal and empty text, its result is bounded at the Plugin Seam, and a dispatched failure is never retried or reported as a successful process outcome.
_Avoid_: set-text handler, generated eval action

**Design Entity**:
One durable UI concept that exists in code and Figma under a repository-owned id, such as `ui.button` or `screen.settings`. Code paths, Storybook stories, publish keys and node ids are links to the Design Entity; none of them alone defines its identity.
_Avoid_: mapped node, remembered component

**Design Link Registry**:
The versioned repository record that resolves a **Design Entity** to its code, Storybook and Figma links. `figma-bridge.json` is the durable adapter; Figma plugin data is the document-side adapter. Ambiguous or conflicting links are reported rather than guessed.
_Avoid_: memory file, component map

**Accepted Design Baseline**:
The reviewed pair of code and Figma fingerprints for one **Design Entity**. It records the last state a human accepted as corresponding without storing source content or claiming that code and Figma are structurally comparable.
_Avoid_: last sync, golden version

**Round-trip Plan**:
The report-only classification of current code and Figma against an **Accepted Design Baseline**: unchanged, code-only, figma-only, conflict or untracked. When Code-to-Figma semantic paths are present, it also names changed semantic subtrees and their current node ids without treating plugin data as visual content. A Round-trip Plan recommends reads but never authorizes a write.
_Avoid_: sync direction, auto-merge

**Project Design Context**:
A small progressive projection for one **Design Entity**: its Registry links, Round-trip Plan, relevant project design files and exact next reads. It is derived on demand rather than maintained as another source of truth.
_Avoid_: agent prompt, context dump

**Static Tailwind Configuration Adapter**:
The data-only projection of a `tailwind.config.*` file into the bounded theme facts used by token import. It recognizes static JS/CJS/MJS/TS object forms without resolving imports or executing plugins, functions or expressions. Irrelevant configuration fields are discarded; executable token-bearing theme values stop with a CSS/W3C migration path.
_Avoid_: config loader, JavaScript sandbox

**Remote Storybook Policy**:
The exact-origin capability that authorizes one Storybook index read before any host network access. It revalidates redirects and every resolved address, pins the connection to an accepted address, preserves the approved HTTP/TLS identity, and owns deadlines plus response limits. Conventional localhost origins work without configuration; other public or private origins require separate explicit policy.
_Avoid_: URL allowlist, fetch helper, SSRF filter

**Semantic Render Plan**:
The versioned, validated and adapter-independent contract for one Figma creation request. JSX, browser capture and future structured inputs adapt into this plan; the Structural Gate and Figma executor consume it. It preserves ordered nodes, native layout intent, sizing, paint, typography, variable and asset intent, Design Entity identity, classified fallbacks and source provenance.
_Avoid_: JSX tree, generated code, render payload

**Compound Semantic Render Request**:
The closed request for a bounded ordered set of **Semantic Render Plans** plus their shared placement and explicit follow-up stages. Wrapper auto-split, explicit batch, CLI and MCP adapt into the same request before readiness. Rendering, placement, component conversion, resize probing and verification retain one target, deadline, confirmation, Audit lifecycle and truthful partial Outcome; a post-dispatch failure never selects another executor.
_Avoid_: recursive render, batch helper, render loop

**Semantic Render Outcome**:
The closed, versioned and deeply bounded result of one simple or compound Semantic Render Command. It retains only created-root identity, executor and structural facts, explicit compound-stage progress, resource decisions, overflow, local notices and truthful mutation residue. CLI text, MCP structured content, JSON/YAML, Audit completion and process code are projections of this value; raw Plugin results and error prose are not Outcomes.
_Avoid_: render response, console result, Plugin result

**Figma Render Executor**:
The static plugin runtime that applies one or a bounded batch of structurally preflighted **Semantic Render Plans** through native Figma operations. It advertises explicit single/batch plan capabilities during the authenticated handshake and must reject unsupported structure before creating canvas nodes. External component, image, font and variable resources are prepared explicitly before the visible tree; batch failures remove already-created root frames. Generated JavaScript remains a temporary compatibility adapter, never an automatic retry after an uncertain write.
_Avoid_: eval renderer, plugin action, plan interpreter

**Boundary Fallback Annotation**:
A native Figma annotation emitted by an explicitly opted-in lossy CSS ↔ Figma policy on the exact affected semantic node. It explains the boundary, scopes the relevant Figma properties and mirrors the stable policy id plus source fact into versioned plugin data. Equivalent mappings do not emit one.
_Avoid_: warning label, generated comment, fallback badge

**Round-trip Fidelity Contract**:
The versioned executable classification of core Figma fact families across Design Capture, agent-facing projections, Semantic Render Plans, Figma Commands and verification. Every direction is explicitly exact, conditional, structural, visual, code-only, Figma-only or stopped. Verification claims resolve through stable Evidence IDs to real checks, gates, probes or tests; an unknown Evidence ID or unclassified core fact is a failing contract rather than an implicit omission.
_Avoid_: feature checklist, workflow matrix, capability claim

## Example dialogue

> **Developer:** Does `figma_spec` behave differently through MCP and the CLI?
>
> **Domain expert:** No. Both adapters invoke the same Command Application. It evaluates through the Daemon Client, and the Figma Command keeps one audit lifecycle.

> **Developer:** Does inferred Auto Layout mean the frame really uses Auto Layout?
>
> **Domain expert:** No. Design Capture records native Auto Layout or Grid as authored Figma fact, `inferredAutoLayout` as a Figma heuristic requiring verification, and free geometry as the final fallback. Projections never erase that distinction.

> **Developer:** Where do I add a new command's write gate and timeout?
>
> **Domain expert:** Add one Command Capability. Adapters consume its resolved plan; they do not duplicate those decisions.

> **Developer:** Can structure and style share work without returning stale design data?
>
> **Domain expert:** Yes. They project the same Design Capture only while the Bridge Daemon connection and Figma document revision remain unchanged. Without revision evidence, capture runs again.

> **Developer:** How do we deterministically catch design-system drift without asking a model to interpret DESIGN.md?
>
> **Domain expert:** Capture a Design Contract for the linked Design Entity and commit it. Contract checks compare the canonical Design Capture and independently enforce its semantic component rules; any drift is a reviewable CI result.

> **Developer:** Where should I change what counts as one exported SVG?
>
> **Domain expert:** Change the Asset Policy. The spec and exporter use the same implementation through different node adapters.

> **Developer:** Does polling `export assets` run the export again?
>
> **Domain expert:** No. Equivalent node/flag spellings canonicalize to one tracked-job identity. Polling attaches to the same Asset Export, while revision drift aborts before publication, files are published before `assets.json`, and a total failure leaves the prior manifest unchanged.

> **Developer:** Can I set a text layer to the literal value `--help`?
>
> **Domain expert:** Yes. Put it after the `--` option terminator. The Figma Command remains a confirmed, non-retrying Node Text Mutation; payload can never impersonate Help policy.

> **Developer:** How does an agent know that a selected Figma frame is the same screen as `src/routes/settings.tsx`?
>
> **Domain expert:** Resolve its Design Entity through the Design Link Registry. The repository record supplies the code link; Figma plugin data keeps the same entity id attached to the document node.

> **Developer:** Code and Figma are both different. Which one should the agent overwrite?
>
> **Domain expert:** Neither by default. The Round-trip Plan compares both with the Accepted Design Baseline and reports a conflict when both moved.

> **Developer:** What should the agent read before changing that screen?
>
> **Domain expert:** Ask for its Project Design Context. It projects the source, Figma node, Storybook link, current Round-trip Plan and exact next reads.

> **Developer:** Is Node Tree the Figma-to-code source of truth?
>
> **Domain expert:** No. Node Tree is a bounded outline for fast discovery and follow-up node ids. Its depth and output are explicitly limited. Exact implementation facts come from Design Capture through Code Spec, while visual ground truth comes from the verification screenshot.

> **Developer:** Is `node css` the same thing as exported design tokens?
>
> **Domain expert:** No. Native Inspect CSS is the bounded property map returned by Figma's `getCSSAsync()` for one target node. It is useful implementation evidence, but it neither replaces Design Capture nor claims token provenance. `export css` separately projects variable collections as CSS custom properties.

> **Developer:** Does `node bindings` prove every variable that affects a node?
>
> **Domain expert:** No. Node Binding Facts preserve the exact topology and identity of direct `node.boundVariables` for quick discovery. Use Design Capture when implementation needs nested style, paint, effect or text-range bindings, mode values, resolved values or provenance.

> **Developer:** Can a command silently switch to another open file?
>
> **Domain expert:** No. Its Figma Target Context resolves once, then accompanies the Command Capability, audit entry, job identity and Daemon Client call. At the Plugin boundary a Dispatch Receipt binds that target and expected editor to the exact authenticated connection before mutation.

> **Developer:** Does the renderer need to parse JSX again after structural validation?
>
> **Domain expert:** No. JSX and browser capture are adapters into a Semantic Render Plan. Validation and execution share that same ordered plan; neither path serializes and reparses another adapter's syntax.

> **Developer:** What happens when a Semantic Render Plan uses a feature the native plugin runtime does not support yet?
>
> **Domain expert:** The Figma Render Executor rejects the complete plan before mutation. The host may choose the compatibility adapter only from that known preflight result or a missing advertised capability; it never retries after a timeout or uncertain write.

> **Developer:** Is native Semantic Render atomic when Figma rejects a later mutation?
>
> **Domain expert:** Only where Figma exposes a truthful inverse. The Structured Mutation Journal removes Command-owned nodes, variables, collections and Text Styles in reverse order. Non-removable image hashes or failed cleanup become bounded `partial-residue`; a lost terminal response remains `unknown-after-dispatch`.

> **Developer:** Can CLI and MCP disagree about whether a render completed with structural findings?
>
> **Domain expert:** No. Both format one Semantic Render Outcome. Its closed status produces the MCP structured result, human text, accepted process code and Audit completion; a malformed Plugin response never becomes success.

> **Developer:** Does wrapper auto-split lose options or start a second command?
>
> **Domain expert:** No. Auto-split and explicit batch adapt into one Compound Semantic Render Request. Every root is prepared before readiness, the native batch owns one mutation journal, and requested follow-up stages extend the same bounded Outcome without recursive command parsing or write retry.

> **Developer:** How does a designer know that a rendered property is an approved approximation rather than an exact mapping?
>
> **Domain expert:** A lossy boundary policy may opt into a Boundary Fallback Annotation on the affected semantic node. The same policy id and source fact are stored as plugin data for agents. Exact and equivalent mappings remain quiet.

> **Developer:** May rendering narrow the scopes of an existing spacing or radius variable?
>
> **Domain expert:** No. Existing user and library variables retain their authored scopes. The Figma Render Executor automatically narrows only newly created FLOAT variables in the exact `space|spacing/*` or `radius|radii/*` namespace; every other new variable returns compatible scope choices for an explicit user decision.

> **Developer:** Can Code-to-Figma turn a similarly named layer into an existing component instance?
>
> **Domain expert:** No. A native instance requires an explicit Design Entity and its Registry key or current-file node id. The Figma Render Executor resolves that identity and any requested variant before creating canvas nodes; display names are never identity.

> **Developer:** How do native instance overrides identify properties, layers and swap targets?
>
> **Domain expert:** `prop:<Property>` resolves one real component-property definition; `text:<Layer>` and `fill:<Layer>` resolve one exact or whitespace/hyphen/underscore-normalized descendant. `swap:<Layer>` and INSTANCE_SWAP properties carry a Design Entity id, which must have a key or local node id in the Render Plan's read-only Registry projection. Visible component names are never swap identity, and every override target is preflighted before canvas creation.

> **Developer:** What happens when a width, height or typography value is a variable?
>
> **Domain expert:** The Figma Render Executor binds native width/height/min/max fields and every variable-bindable typography field. FLOAT and STRING references resolve before creation. A bound family/style is loaded during preflight; if the face is unavailable, execution stops before creating variables or canvas nodes and asks for an installed or explicitly available alternative.

> **Developer:** How can the agent tell whether a render reused tokens or created new ones?
>
> **Domain expert:** Every native render with variable intent returns one Variable Report: references, unique reused variables, created variables, bound properties, ambiguities and unsupported intents. Explicit `var:` ambiguity fails preflight without variables or canvas nodes. Ambiguity created only by optional tokenization of a numeric spacing/radius literal instead preserves the exact value unbound and succeeds with that decision visible in the same report.

> **Developer:** Code-to-Figma can write a native effect. Does that mean Design-to-Code can safely rebuild it?
>
> **Domain expert:** Only when the Round-trip Fidelity Contract classifies the reverse direction and its Capture, projection and verification are implemented. Write support alone never implies reverse fidelity.

> **Developer:** A Figma command was slow. How do we know which Bridge layer caused it?
>
> **Domain expert:** Use the runtime workload evidence. It separates Command planning, Daemon preparation, write-lane wait, Plugin round trip and content-free Figma-main-thread queue/execution timing. Missing MCP, process or resource segments stay named as pending; the Bridge never disguises a partial measurement as complete end-to-end proof.

> **Developer:** Can the pinned Figma typings prove that every live runtime field exists?
>
> **Domain expert:** No. Release checks keep official typings, the Bridge projection contract and a content-free live-runtime exception policy independent. New union values, missing required fields and wrong runtime types fail until reviewed; an unavailable sample stays unsampled rather than becoming assumed compatibility.
