# Serialize Plugin writes with deadline-aware target lanes

Every Bridge Daemon mutation and opaque compatibility eval enters one bounded
in-memory lane keyed by its resolved Figma file or connection-scoped draft
session. The Daemon resolves and snapshots the exact Plugin connection before
queueing, then revalidates that snapshot immediately before dispatch. Writes
for one target run in deterministic order; distinct targets retain independent
progress.

Opaque compatibility `eval` is a write even when source heuristics call it a
read. Only a closed typed-read operation selected by its Command Plan may bypass
the lane under ADR 0035. A read that
explicitly requests read-after-write consistency joins the same target lane as
a non-dispatching barrier; ordinary selection inspection remains immediately
available, including after an uncertain write.

Queue wait consumes the immutable Command Plan deadline. Deadline expiry,
bounded queue refusal and HTTP cancellation before start remove only that
entry and are `not-dispatched`. Cancellation after the Daemon has marked the
request dispatched is ignored: the authenticated Dispatch Receipt, not the
lifetime of an HTTP caller, owns settlement from that point.

A completed, not-dispatched or known failed terminal receipt releases the lane.
A timeout, disconnect, malformed response or other unknown outcome quarantines
it. The Figma Plugin main thread emits a separate `lane-settled` message after
the actual uncancellable operation stops. That message carries the exact
terminal Dispatch Receipt identity. The main thread retains a bounded set of
recent settlements keyed by receipt identity and replays it after an
authenticated UI-iframe reconnect, so socket loss does not force unsafe release
or permanent loss of a late proof across concurrent write and typed-read work.

Reconnect alone never clears quarantine. A different or newly started Plugin
runtime cannot know the random request identity and therefore cannot settle an
older runtime's work. The explicit recovery seam requires independent proof
that the old runtime stopped; socket closure is not such proof. Queue summaries
expose only aggregate active, queued and quarantined counts—never file keys,
connection ids or receipt identities.
