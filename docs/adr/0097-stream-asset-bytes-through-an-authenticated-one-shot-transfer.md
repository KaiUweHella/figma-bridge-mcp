# Stream Asset Bytes Through an Authenticated One-Shot Transfer

## Status

Accepted.

## Context

Asset Export previously returned every image and SVG as Base64 inside the
generic Plugin result. The result is deliberately bounded to 5 MiB, so Base64
overhead rejected an individual asset well below the Workspace byte limit.
The host also retained every decoded candidate until identity planning, making
peak memory grow with the total export even after publication work moved to a
Worker.

Raising the generic protocol limit would expose every operation to larger JSON
payloads and would not remove Base64 copies. Granting the Plugin outbound
network access would widen its authority. Figma's asset APIs return one complete
`Uint8Array`, so the Bridge cannot truthfully claim constant memory for one
individual asset; it can avoid memory growth across the export and avoid
additional asset-sized Plugin copies.

## Decision

`asset-stream-v1` is a closed authenticated Plugin read operation for either
one image hash or one canonical SVG node id. The Plugin reads one source,
computes SHA-256 with virtual padding and periodic deadline/yield checkpoints,
then sends 256 KiB Base64 chunks in strict sequence. It waits for an
authenticated Daemon acknowledgement before sending the next chunk. The
existing Page Revision Observation and one Command Plan deadline govern the
complete operation.

The Daemon writes chunks directly to one UUID-named private partial file. It
accepts at most 512 MiB per asset and eight completed transfers, verifies
canonical Base64, sequence, declared byte count and SHA-256, and atomically
renames a verified partial file. Recognized transfer residue is removed on
failure, disconnect, timeout, shutdown and startup. Completed transfers expire
after two minutes.

The `/exec` result contains only a bounded transfer descriptor. The Daemon
serves its bytes exactly once through a separately signed loopback GET with
`no-store`, length and digest headers. The Daemon Client streams and verifies
those bytes again. Asset Export transfers the resulting Buffer to its
publication Worker, which processes and writes it immediately into the private
transaction stage before the next asset is requested. The final identity merge,
revision fence and manifest-last commit remain unchanged.

The new operation uses the bounded read lane and never places byte chunks in
the Audit Trail. Plugin network permissions and the generic JSON limit do not
change. CLI and MCP adapt to the same Asset Export Command Application and
Daemon Client Interface. A known older Plugin may fall back to the existing
Base64 read only when it rejects `asset-stream-v1` before dispatch; any
post-dispatch or transport failure aborts the command.

## Consequences

A single asset above the former Base64 ceiling can export without weakening
the rest of the protocol. Plugin and host memory are bounded by the largest
current asset rather than total exported bytes; host publication no longer
retains successful assets as an aggregate. Integrity is checked on both sides
of the one-shot Daemon transfer, and private residue has deterministic recovery.

The Plugin-to-Daemon wire still encodes each bounded chunk as Base64 because the
Figma UI WebSocket bridge is JSON-only. This adds bounded per-chunk overhead but
never one asset-sized Base64 string. Figma's source `Uint8Array` and the host's
current single-asset Buffer still exist, so future native streaming APIs could
reduce the largest-asset bound without changing Asset Export semantics.
