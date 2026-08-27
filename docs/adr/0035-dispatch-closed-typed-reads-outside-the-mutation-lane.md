# Dispatch closed typed reads outside the mutation lane

An immutable Command Plan must classify an operation as `typed-read` before it
can bypass serialized Plugin mutation dispatch. The allowlisted operations are
the versioned Style Consumer Application and an identity-free Bridge health
probe. Their Daemon payloads are closed request objects; JavaScript source is
invalid on this path. Every other read, including opaque compatibility eval,
remains conservative serialized work.

The Daemon read scheduler permits at most two active operations globally, one
per resolved file or connection-scoped draft session, 64 queued requests
globally and 16 queued requests per session.
It consumes the Command Plan deadline and HTTP cancellation before dispatch.
The Daemon snapshots and revalidates the same authenticated connection, file,
editor and capability facts used by mutation dispatch, then prepares the same
versioned Dispatch Receipt immediately before sending the operation.

Typed reads execute outside the Plugin's `evalChain`; mutations keep their
existing per-target order. A read with an unknown post-dispatch outcome retains
its read slot until the exact late receipt settles. The Plugin retains and
replays a bounded set of eight terminal settlements keyed by receipt identity,
so concurrent reads cannot overwrite a late mutation proof during reconnect.
After a newly authenticated connection epoch completes the closed main-thread
health probe, the scheduler may release stale read slots for the same target
whose receipts belong to older epochs. This is safe only because typed reads
cannot mutate the document. The proof never releases a write quarantine.

The closed runtime validates Style Consumer request fields, candidate counts,
page size, cursor identity and serialized result size on both sides of the
transport. Commander and MCP prefer it. They may fall back once to the prior
bounded Style Consumer eval only after a structured capability or validation
failure proves non-dispatch; timeouts, malformed results and every
post-dispatch failure are never retried.

The status surface invokes the health operation directly with one bounded
request per selected authenticated connection. This distinguishes socket-only,
responsive and unresponsive states without placing diagnosis in the write
lane. Typed-read timing uses Bridge timing version 2 with an explicit read lane
and generic dispatch-queue duration. Existing write timing remains version 1
and keeps its stable field names.
