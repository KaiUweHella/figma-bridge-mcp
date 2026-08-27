# Publish Asset Bytes Through a Cooperative Commit Worker

## Status

Accepted.

## Context

Asset Export already pins one Figma revision and serializes read-prior, merge
and manifest-last publication with a process-safe output lock. Its host-side
content hashes, synchronous PNG work and large Workspace writes nevertheless
ran on the long-lived MCP event loop. One operation close to the aggregate
buffer guard could therefore stall every other request and cross the Command
Plan deadline inside an uninterruptible call. The lock also covered those large
writes even though only the merge and commit require serialization.

The existing manifest was written in place. A process or filesystem failure
after truncation but before the complete write could invalidate the prior
advertised state.

## Decision

One resource-bounded Asset Publication Worker owns decoded candidate buffers,
PNG optimization, visual/raw content hashing, prior-file integrity reads and
publication byte writes. Buffers transfer to the Worker rather than being
copied through its message boundary. The existing aggregate byte guard remains
authoritative, and the Worker reports buffered bytes, staged bytes and peak
memory facts.

Before acquiring the shared output lock, the Worker writes every candidate to
one UUID-named private directory inside the authorized output directory and
releases its in-memory copy. The lock then covers only:

1. the final authenticated Figma revision fence;
2. prior-manifest and prior-file integrity reads;
3. the deterministic Manifest v2 merge;
4. constant-time hard links from the prepared stage to new asset names; and
5. atomic replacement of `assets.json` from the same directory.

Worker phases cross a checkpoint Interface bound to the immutable Command Plan
deadline. Hash, stage-write and staged-manifest cancellation terminate the
Worker and clean the exact private stage. The prepared publication requires a
final host commit acknowledgement. Once acknowledged, deadline cancellation is
disabled for the small link-and-rename commit: a visible new manifest is always
reported as committed even if private-stage cleanup finishes after the nominal
deadline. Cleanup has its own bounded recovery Worker and never removes an
unrecognized entry.

The existing synchronous Asset Manifest helpers remain for compatibility and
isolated callers. The shared CLI/MCP Asset Export Application uses the Worker
path. Base64 Plugin transport and aggregate buffering remain explicit STAB-08
scope; the Worker Interface is the host-side destination for that future
stream.

## Consequences

Large CPU and filesystem work no longer blocks the MCP event loop. Concurrent
different-root exports retain the same lock-protected merge semantics while
large stage writes happen in parallel before the lock. A timeout or Worker
failure before manifest replacement leaves the prior manifest byte-identical;
unadvertised stage bytes are removed. Atomic manifest replacement removes the
former partial-truncation outcome.

The implementation adds one Worker runtime to the published engine and a
short-lived private stage directory during export. Peak process memory still
includes Figma's current Base64 response and the bounded Worker buffers until
STAB-08 replaces that transport, but its amount is now reported and the Worker
releases each in-memory candidate after staging.
