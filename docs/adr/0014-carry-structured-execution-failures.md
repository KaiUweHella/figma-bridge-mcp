# Carry structured execution failures across the Daemon seam

Every failed Bridge Daemon execution returns one bounded, versioned Bridge
Daemon Error with a stable kind, phase and execution outcome. Authentication,
request validation, target resolution, Plugin dispatch, Plugin execution and
Plugin response facts are assigned where they originate.

`not-dispatched` means the Bridge knows the Figma Command did not reach the
Plugin. `unknown-after-dispatch` is deliberately conservative: a timeout,
disconnect, invalid response or Plugin-reported error cannot prove that a
mutation made no document change. Command Capability retry policy consumes
these facts and never retries a write with an unknown outcome.

The HTTP response temporarily retains the original `error` string beside the
new `bridgeError` envelope so older clients remain usable with a newer Daemon.
The Daemon Client accepts string-only responses from an older running Daemon
through one byte-bounded compatibility Adapter. Only that Adapter recognizes a
closed set of legacy messages. Current retry and recovery decisions never
parse user-facing prose, and a domain failure containing the word `token` is
not an authentication failure.
