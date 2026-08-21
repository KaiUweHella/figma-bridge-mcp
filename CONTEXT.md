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
The resolved policy for one concrete **Figma Command** before execution: Adapter exposure, Figma/workspace/shared-state effects, target requirement, normalized paths, confirmation, retry, timeout, accepted exit codes and background-job identity.
_Avoid_: allowlist entry, command metadata

**Design Capture**:
The canonical, lossless Figma facts collected for one node and one set of capture options, bound to a Bridge Daemon connection and document revision. It keeps authored Figma facts, Figma heuristics and Code-to-Figma source intent under explicit provenance rather than flattening them into one claim. Structure, style, deduplication, enrichment and serialization are projections of a Design Capture, never inputs that reduce it.
_Avoid_: walker output, cache entry

**Design Contract**:
A reviewed, repository-owned projection of one Design Entity's complete Design Capture. Its canonical layer removes volatile Figma handles for exact drift detection; its semantic rules enforce component existence, variant axes and exhaustiveness, token-binding floors, geometry tolerances and prototype transitions. Incomplete captures cannot become contracts.
_Avoid_: screenshot snapshot, prose guideline, node-id fixture

**Bridge Daemon**:
The authenticated localhost process that routes a **Figma Command** to exactly one connected Figma plugin window.
_Avoid_: backend, proxy

**Daemon Client**:
The sole local interface to the **Bridge Daemon**, owning request signing, file targeting, timeouts, health and transport-error semantics.
_Avoid_: fetch helper, daemon wrapper

**Figma Target Context**:
The immutable resolution of exactly one plugin file for a **Figma Command**, including whether the file came from an explicit key, a Figma URL, or the single connected window.
_Avoid_: fileKey parameter, current window

**Asset Policy**:
The canonical classification of image fills, vector artwork and vector clusters shared by **Design Capture** projections and asset export. Node-side and plugin-side adapters apply the same policy implementation.
_Avoid_: vector heuristic, exporter rule

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

**Semantic Render Plan**:
The versioned, validated and adapter-independent contract for one Figma creation request. JSX, browser capture and future structured inputs adapt into this plan; the Structural Gate and Figma executor consume it. It preserves ordered nodes, native layout intent, sizing, paint, typography, variable and asset intent, Design Entity identity, classified fallbacks and source provenance.
_Avoid_: JSX tree, generated code, render payload

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

> **Developer:** How does an agent know that a selected Figma frame is the same screen as `src/routes/settings.tsx`?
>
> **Domain expert:** Resolve its Design Entity through the Design Link Registry. The repository record supplies the code link; Figma plugin data keeps the same entity id attached to the document node.

> **Developer:** Code and Figma are both different. Which one should the agent overwrite?
>
> **Domain expert:** Neither by default. The Round-trip Plan compares both with the Accepted Design Baseline and reports a conflict when both moved.

> **Developer:** What should the agent read before changing that screen?
>
> **Domain expert:** Ask for its Project Design Context. It projects the source, Figma node, Storybook link, current Round-trip Plan and exact next reads.

> **Developer:** Can a command silently switch to another open file?
>
> **Domain expert:** No. Its Figma Target Context resolves once, then accompanies the Command Capability, audit entry, job identity and Daemon Client call.

> **Developer:** Does the renderer need to parse JSX again after structural validation?
>
> **Domain expert:** No. JSX and browser capture are adapters into a Semantic Render Plan. Validation and execution share that same ordered plan; neither path serializes and reparses another adapter's syntax.

> **Developer:** What happens when a Semantic Render Plan uses a feature the native plugin runtime does not support yet?
>
> **Domain expert:** The Figma Render Executor rejects the complete plan before mutation. The host may choose the compatibility adapter only from that known preflight result or a missing advertised capability; it never retries after a timeout or uncertain write.

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
> **Domain expert:** Every native render with variable intent returns one Variable Report: references, unique reused variables, created variables, bound properties, ambiguities and unsupported intents. Failed preflight uses the same vocabulary in its error and leaves both variables and canvas nodes untouched.

> **Developer:** Code-to-Figma can write a native effect. Does that mean Design-to-Code can safely rebuild it?
>
> **Domain expert:** Only when the Round-trip Fidelity Contract classifies the reverse direction and its Capture, projection and verification are implemented. Write support alone never implies reverse fidelity.
