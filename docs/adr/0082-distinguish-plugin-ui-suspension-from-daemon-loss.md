# Distinguish Plugin UI suspension from Daemon loss

The Plugin Keepalive measures Daemon liveness only while the Plugin UI event
loop is demonstrably running. Figma may suspend Plugin iframes during document
work, and the operating system may suspend both sides during sleep. An overdue
interval therefore cannot use wall-clock Pong age alone to declare the socket
dead: its own timer drift proves that the observer could not process a queued
Pong.

Each Keepalive tick records both the latest Pong and the latest interval tick.
When the interval runs within its normal bounded cadence, an unanswered Daemon
still closes after the established timeout. When the interval itself resumes
late, the Plugin grants exactly one fresh Pong window, sends a new Ping and
then returns to the normal deadline. Repeated live ticks without a Pong still
close the socket; suspension does not create an unbounded grace period.

This transport recovery is independent of Figma Command semantics. It does not
mark a request completed, retry an operation, change its Dispatch Receipt or
release a quarantined read/write lane. A real WebSocket close retains the
existing `unknown-after-dispatch` outcome for in-flight work.
