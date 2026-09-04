# Design-to-code — design decisions

Design-to-code turns a live Figma document into a Code Spec, exported
assets, and evidence that an implementation actually matches its source. The
decisions below protect that evidence: what counts as proof of an unchanged
document, what a comparison run is allowed to claim, and how bytes leave
Figma without ever being trusted before they are verified.

## Design Capture

### Reuse a capture only with proven revision evidence

**Decision.** A Design Capture may be reused only when the daemon proves the
same authenticated plugin connection and a stable, unchanged document
revision. Missing or unstable revision evidence disables reuse; selection
and named-section requests stay uncached until they can offer the same
proof.
**Why.** Trusting a cache without a live revision proof risks serving a Code
Spec that no longer matches the document a designer is actively editing.
**What it means for you.**

- Reopening the same unchanged node is fast; any edit invalidates the cache
  automatically rather than requiring a manual clear.
- Selection-based and named-section captures are recomputed every time until
  they gain their own revision proof.

<!-- source: 0006 -->

### Scope revision proof to the target page

**Decision.** One-root Design Capture and Asset Export observe an explicit
Page Revision instead of the whole document's change stream. The plugin
resolves the containing page, installs one bounded listener per observed
page, and returns before/after revision facts pinned to the daemon
connection and file identity across every roundtrip.
**Why.** Watching the entire document for any change would let an edit on
an unrelated page invalidate a capture on the page actually being read.
**What it means for you.**

- An edit to a different page does not affect capture or publication proof
  for your target page.
- A separate explicit Document observation remains available for genuinely
  multi-page work, at its own measured cost.

<!-- source: 0094 -->

### Split a huge capture into stitched, budgeted evals

**Decision.** The plugin walker accepts a wall-clock and serialized-size
budget per eval; once either is exceeded it still captures the current
layer but reports the remaining subtree as a frontier. Design Capture walks
each frontier in its own bounded eval at the same document revision and
splices the frames back together, so a delivered complete capture has no
visible seam.
**Why.** A single unbounded walk of a large screen could exceed the plugin
message limit, forcing the Bridge to fall back to a screenshot and a
depth-limited structure map, exactly the interpretation design-to-code
forbids.
**What it means for you.**

- `complete: false` returns the first bounded eval with its seam visible;
  the default is a complete capture.
- `export code-spec -o/--output` and `figma_spec outFile` persist the full
  projection to the workspace and return summary facts including plugin
  eval count and bytes.

<!-- source: 0128 -->

## Asset and media export

### Move asset publication off the MCP event loop

**Decision.** One resource-bounded Asset Publication Worker owns decoded
buffers, PNG optimization, content hashing, and publication writes. It
stages every candidate to a private directory and releases its in-memory
copy before acquiring the shared output lock, which then covers only the
final revision fence, manifest merge, and atomic rename.
**Why.** Synchronous PNG work and large workspace writes on the long-lived
MCP event loop could stall every other request and cross a command's
deadline inside one uninterruptible call.
**What it means for you.**

- A timeout or worker failure before the manifest is replaced leaves the
  prior manifest byte-identical; no partial-truncation outcome is possible.
- Concurrent exports to different roots stage in parallel and only
  serialize briefly at the final commit.

<!-- source: 0096 -->

### Stream large assets through a verified one-shot transfer

**Decision.** `asset-stream-v1` is a closed authenticated plugin read for
one image hash or SVG node. The plugin sends 256 KiB chunks in sequence,
waiting for acknowledgement between each; the daemon writes them to a
private partial file, verifies sequence, byte count, and SHA-256, then
renames the file atomically.
**Why.** The generic plugin result is bounded well below what a single
large asset needs once Base64 overhead is counted, and raising that limit
for every operation would expose all commands to larger payloads without
actually bounding memory.
**What it means for you.**

- Plugin and host memory are bounded by the largest single asset, not the
  total export.
- A known older plugin can fall back to the previous Base64 read only when
  it refuses the new operation before dispatch; any failure after that
  aborts the command.

<!-- source: 0097 -->

### Route PNG through Screenshot, other formats through Image Export

**Decision.** `export node` and `export screenshot` now adapt to the
existing Screenshot Command Application, with signature and IHDR validation
before any bytes are written. JPG, SVG, and PDF route through a separate
Image Export Command Application with their own signature, structure, and
marker checks appropriate to each format.
**Why.** The previous duplicate PNG path trusted logical geometry as pixel
dimensions and bypassed the bounded validation that Screenshot already
owns, while JPG, SVG, and PDF are not themselves PNG verification evidence
and should not be forced through that stricter contract.
**What it means for you.**

- Both command names keep their established workspace filename and
  human-readable output.
- Workspace I/O receives bytes only after format-specific evidence checks
  pass, never before.

<!-- source: 0116 -->

### Verify image container bytes before writing any export

**Decision.** The Image Export Application validates JPEG signature and
intrinsic dimensions, SVG UTF-8 and a single root element, and PDF header
and end marker, all before Workspace I/O ever receives bytes.
**Why.** A canonical Base64 response from the plugin is still untrusted
post-dispatch input; publishing before checking format-specific structure
could write a corrupt or truncated file that looks like a success.
**What it means for you.**

- Oversized exports fail with one small result instead of breaking the
  transport.
- A live Figma test is not required for this ownership change because the
  stable export formats are already covered by official typings and
  deterministic fixtures.

<!-- source: 0122 -->

### Verify the exported node-JSON envelope before publishing

**Decision.** `export node-json` validates Figma's exported REST-shaped
envelope, rejecting accessors, exotic prototypes, cycles, sparse arrays,
non-finite values, oversized keys, and excessive depth or entry counts
before formatting or writing it anywhere.
**Why.** The response is untrusted post-dispatch input, so the JSON that
reaches a file or stdout must be proven safe and well-formed rather than
assumed correct because it came from the plugin.
**What it means for you.**

- The requested node's identity and type are verified against the returned
  document before output.
- Pretty JSON is produced only after validation; directional and
  JavaScript-separator control characters are escaped textually without
  changing the parsed value.

<!-- source: 0123 -->

### Validate exported video against its own container markers

**Decision.** Video Export requires exact node and format-matching
evidence, validating MP4 box topology, GIF signature and terminator, or
WebM EBML/DocType/Segment markers before Workspace I/O. Invalid, mismatched,
or oversized evidence publishes no bytes.
**Why.** A bounded Base64 response alone does not prove the exported bytes
are actually the requested format for the requested frame; format-specific
container checks catch a mismatch before it reaches disk.
**What it means for you.**

- MP4, GIF, and WebM stay the supported formats; format-inapplicable
  `--quality` or `--loop` values are still ignored as before.
- Large videos above the generic result budget need a future dedicated
  streaming capability; this export does not reuse the asset-stream
  transport built for images.

<!-- source: 0126 -->

## Fidelity evidence and corpus

### Classify every fact family once, in one contract

**Decision.** Core Figma fact families are classified once in a versioned
Round-trip Fidelity Contract covering both directions plus verification.
Design Capture, agent-facing projections, Semantic Render Plans, and
command-specific writers keep their own implementations, but CI rejects an
unclassified core fact.
**Why.** Without one shared classification, workflow prose or a one-sided
feature test could quietly become the source of truth for what counts as
faithful, and write support could be assumed to imply reverse fidelity when
it does not.
**What it means for you.**

- A new core fact needs a contract entry before it can ship in either
  direction.
- The contract does not itself implement capture or rendering; it only
  forces every implementation to agree on what a fact is.

<!-- source: 0010 -->

### Never redispatch a typed mutation as generated eval

**Decision.** When local structural inspection accepts every fact in a
Semantic Render Plan, the command sends only the versioned plan to the
static plugin dispatcher. A missing or stale plugin capability is reported
as a typed-operation failure with upgrade guidance; it never causes the same
write to be silently recompiled and redispatched as generated JavaScript.
**Why.** Falling back to eval on a known capability gap would let a
migrated operation's schema, validation, and rollback evidence quietly
weaken on an older plugin exactly when that evidence matters most.
**What it means for you.**

- Generated eval stays available only as an explicit compatibility adapter
  for facts the typed executor has not migrated yet, decided before plugin
  readiness.
- A supported plan never needs an eval adapter at all.

<!-- source: 0062 -->

## Browser fidelity ledger

### Require provenance and a fact ledger, not just a diff

**Decision.** Every Semantic Render Plan names its bounded adapter and
provenance; a Browser DOM Capture carries its schema version, digest, and
viewport as evidence the Figma Render Executor persists on the root node. A
reviewed Browser Fidelity Ledger maps bounded source-node facts to one
capture path, classifying each as `matched`, `approved-deviation`, or
`missing`.
**Why.** A whole-image diff can show a build differs from Figma without
proving that a rare source fact, such as a blend mode or an effect stack,
actually survived implementation; a real publication lost exactly those
kinds of facts even though the source capture had them.
**What it means for you.**

- Design Link acceptance for an existing rendered UI can require the
  `dom-capture` adapter rather than accepting a rewritten JSX source
  unreviewed.
- Absent, ambiguous, unavailable, or unequal facts fail closed; the ledger
  is capped at 500 facts and rejects unknown properties.

<!-- source: 0068 -->
