# Release and evidence — design decisions

Shipping a release means proving three separate things: that the Bridge is
fast enough, that it round-trips design fidelity as claimed, and that it
still matches the official Figma Plugin API it was built against. The
decisions below keep each of those proofs measured rather than assumed, and
keep a passing signal from ever meaning more than what was actually checked.

## Measuring runtime performance

### Measure runtime workloads at explicit boundaries, not one stopwatch

**Decision.** Performance evidence is captured at named boundaries: a
versioned Plugin timing receipt for queue and Figma-main-thread duration, plus
Daemon-side request preparation, dispatch-lane wait, and round-trip time,
rather than inferred from one end-to-end measurement. Older Plugin runtimes
that predate the receipt simply return `null` timing instead of failing an
otherwise valid command.
**Why.** A single stopwatch hides which layer actually caused a regression;
a slow segment must be named, not guessed at.
**What it means for you.**

- Timing evidence never changes dispatch certainty or authorizes a retry by
  itself.
- CI gates only deterministic local segments or generous absolute ceilings;
  live Figma timings remain acceptance evidence, not a portability promise
  for every machine.

<!-- source: 0027 -->

### Measure the complete MCP runtime with content-free traces

**Decision.** A maintainer-only, environment-enabled trace records
action/tool names, process id, durations and byte counts at the Daemon Client
and MCP tool-result boundaries, never inputs, file identities, node
identities, labels or results. This closes the gap left by per-Application
measurement, which did not cover the released STDIO server, write
confirmation, Audit, or MCP result serialization.
**Why.** The layer that actually dominates a regression is often outside any
single Command Application, and it needs to be named without ever writing
document content to a trace file.
**What it means for you.**

- CI gates only on offline server starts and Tool Discovery, using a relative
  warm/startup constraint plus generous absolute ceilings.
- Peak RSS sampling is a conditional CI gate where a process sampler is
  available and mandatory evidence in the maintainer's own acceptance run.

<!-- source: 0065 -->

## Scoring fidelity for release

### Score releases against one versioned bidirectional fidelity corpus

**Decision.** Figma Bridge uses one redistributable corpus and one
fail-closed scorer for both its own release proof and any comparison work.
Every result is classified as `exact`, `normalized`, `approximated`,
`unsupported` or `silently-lost`; unexpected unsupported output and any
silent loss both fail the run. The first release profile requires 100%
target conformance in every declared dimension and at most 1% visual pixel
difference.
**Why.** A workflow test that only checks one direction, or that lets an
unexpected loss pass quietly, cannot stand in as the source of truth for what
the Bridge actually preserves.
**What it means for you.**

- Missing access to a comparison target is reported as benchmark
  unavailability, never folded into a fidelity score.

<!-- source: 0060 -->

### Keep comparison evidence below executable release proof

**Decision.** Benchmarking the Bridge's own corpus against another
implementation is a test-case source, not the target architecture. Every
comparison direction records one capability, evidence level and limitation
class, and only cells backed by a local executable test and a registered
Evidence ID are required to resolve. Comparisons must not enable private
APIs, host binary patches, or browser-debugging transports to manufacture
parity.
**Why.** Confusing "we don't have access to check this" with "this feature
doesn't exist" in either direction would misrepresent what was actually
verified.
**What it means for you.**

- A missing supported client is reported as an access limitation, never as an
  unsupported product feature, and the reverse never happens either.

<!-- source: 0061 -->

### Accept individual workflows with scoped, reproducible fidelity evidence

**Decision.** A workflow can be accepted on its own, ahead of a full release,
through a Workflow Fidelity Run that scores only the cells assigned to that
workflow and reports `WORKFLOW PASS` rather than implying broader coverage
passed. Every evidence row names a repository artifact and its SHA-256
digest, and fixture inputs plus the resulting Semantic Render Plan are
digest-pinned so a changed input cannot inherit an older acceptance.
**Why.** Reusing an old accepted result after the input changed would let a
regression hide behind a stale pass.
**What it means for you.**

- Figma Desktop observation remains required for native write, readback,
  responsive and visual evidence; CI proves corpus completeness and scoring,
  never the desktop observations themselves.

<!-- source: 0063 -->

## Staying compatible with the official Plugin API

### Derive the offline API reference from pinned official typings

**Decision.** `@figma/plugin-typings` is an exact production dependency at a
reviewed version, and is the single authoritative source for both capability
coverage and the offline API reference. `api setup` validates the expected
package name, version and reviewed SHA-256 of `plugin-api.d.ts`, then
publishes the projected reference atomically under the private Bridge state
directory. It performs no network or shell execution.
**Why.** The previous approach cloned a moving third-party Git branch through
a shell string, which meant provenance, size and network behavior were
delegated entirely to Git rather than owned by the Bridge.
**What it means for you.**

- A failed validation or publication leaves the previous known-good reference
  material readable; nothing gets silently replaced.
- Existing package-tree Markdown is never trusted as active material; a
  one-way migration path to `api setup` is offered instead.

<!-- source: 0067 -->

### Gate style unions and runtime metadata drift independently

**Decision.** Three compatibility sources are kept independent: the pinned
official typings, the Bridge's own projection/validator contract, and an
explicit live-runtime exception policy. Agreement between any two never
silently rewrites the third. The release gate compares the TypeChecker's
actual union members from installed typings against what Bridge serializers
expect, and fails until a real drift is reviewed.
**Why.** A newly missing field or an unreviewed runtime exception must be
caught explicitly, not absorbed as if it were always expected.
**What it means for you.**

- A maintainer-only live probe observes only whether specific metadata
  fields are present and what shape they have, never their content, names
  or ids.
- Only one runtime exception is currently accepted (a missing
  `descriptionMarkdown` on a local Text Style); it is not generalized to any
  other field or Style family.

<!-- source: 0028 -->

### Separate host and Plugin static contracts

**Decision.** Two explicit TypeScript programs check the codebase: one with
only Node types for the host, one with only official Figma Plugin types for
the Plugin. Files may not cross between the two programs, and a source-level
test snapshots every accepted seam so host contract coverage cannot shrink
silently.
**Why.** Loading both type packages into one program had let accidental
`figma` globals into host code and accidental Node globals into the Plugin
type-check cleanly, which is exactly the kind of drift a static contract
exists to catch.
**What it means for you.**

- The static contract also owns the accepted message-discriminant inventory
  for the authenticated Plugin protocol, so adding, removing, or
  half-implementing a protocol message fails at its owning seam.

<!-- source: 0117 -->
