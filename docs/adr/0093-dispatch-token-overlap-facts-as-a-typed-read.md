# Dispatch Token Overlap Facts as a Typed Read

Token Overlap has one closed versioned Plugin operation,
`token-overlap-v1`. Its request contains only 2–32 bounded unique local
Collection queries and one bounded list limit. It cannot carry JavaScript,
output formatting or executable data. The Daemon and Plugin share the request
validator, and the host retains the existing exact bounded result validator.

The native operation preserves Collection resolution, exact Variable
membership, owner validation, duplicate-name counts, common-core semantics,
stable sorting, independent list truncation and serialized-result limits. A
parity contract compares its complete facts to the earlier generated-eval
projection so transport migration cannot quietly alter reuse guidance.

The immutable Command Plan classifies `tokens.overlap` as `typed-read`. This is
material because a comparison may load up to 100,000 selected Variables; it
must not delay unrelated same-target Code-to-Figma writes merely because the
legacy transport was opaque. The bounded read scheduler, target/editor binding,
authenticated connection epoch, deadline, Dispatch Receipt, result validation,
audit and error contracts remain unchanged.

Commander and MCP may execute the bounded generated-eval implementation once
only when an older Plugin returns a structured capability or validation error
with a proven `not-dispatched` outcome. No timeout, malformed result,
disconnect, post-dispatch error or unknown outcome may cross that fallback.
