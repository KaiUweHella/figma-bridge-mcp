# Retire the unreachable generic eval batch protocol

The Plugin UI, Plugin main thread and Bridge Daemon retained an `eval-batch` /
`batch-result` message pair without a Daemon request action, Command Capability,
Dispatch Receipt capability or Command Plan route. No supported CLI or MCP
request could reach it. Keeping one-sided protocol code made the authenticated
surface look broader than the product and preserved an unbounded generated-code
execution shape without an owner.

Remove the generic message pair from all three runtime layers and from the
authenticated Plugin message contract. An incoming `batch-result` is now an
unknown message rather than a dormant accepted result. Source and protocol
contracts prove that no shipped Plugin remnant returns.

Compound Semantic Render remains separate. Its supported native operation is
`render-plan-batch`, carries the advertised `render-plan-batch-v1` capability
and returns through the ordinary Dispatch Receipt-bound `result` channel.
Generated Semantic Render compatibility also remains a pre-dispatch executor
choice for locally unsupported plan facts; it is one bounded `eval` request,
not the removed generic batch protocol.
