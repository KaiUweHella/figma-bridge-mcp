# Measure runtime workloads with segmented evidence

Runtime performance evidence is owned at explicit Bridge boundaries rather
than inferred from one end-to-end stopwatch. A versioned, content-free Plugin
timing receipt records queue and Figma-main-thread execution duration. The
Daemon validates that optional receipt and adds its own request preparation,
dispatch-lane wait, Plugin round-trip and residual work durations. Version 1
retains `writeLaneQueueMs`; version 2 identifies typed reads with
`dispatchLane: read` and `dispatchQueueMs` rather than mislabeling their wait.

The Plugin timing contract is a canonical Engine module deterministically
generated into the shipped Plugin artifact. It contains durations only: no
file, node, style, content or user identity. Older Plugin runtimes remain
compatible and produce `null` timing instead of failing an otherwise valid
command. Timing evidence never changes dispatch certainty or authorizes retry.

The maintainer runtime corpus invokes authentic Command Plans and their owning
Applications against an explicitly targeted connected file. It reports the
first in-process sample apart from warm repetitions, Application outcome bytes
and heap delta. It does not call the first sample process-cold, does not call an
Application outcome a complete MCP response, and lists MCP ingress, Audit,
confirmation, envelope bytes, process startup, peak RSS and unimplemented
workload families as pending coverage.

CI may gate deterministic local segments or deliberately generous absolute
ceilings only after repeated evidence establishes variance. Live Figma timings
remain acceptance and regression evidence rather than compatibility limits for
all user machines. Non-interruptible native APIs such as
`getStyleConsumersAsync()` retain their truthful API limitation; measurement
does not invent a traversal budget.
