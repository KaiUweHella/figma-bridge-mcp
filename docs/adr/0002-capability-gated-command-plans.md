# Resolve every command through a Command Capability

Every Adapter resolves a Figma Command into one immutable Command Plan before
execution. Unknown commands default to denied, mutating and non-retryable so
adding a command cannot accidentally bypass confirmation, targeting, path
normalization or audit policy.

Path normalization happens before a lazy Design Link Registry lookup. The
Figma Target Context precedence is explicit caller target, Figma URL argument,
Registry target, then implicit single-window targeting. Repository-only
commands carry a non-applicable target and do not read the Registry.

The Command Application accepts only a Command Plan created by the Capability
Catalog. Process and in-process Adapters consume that exact plan; they do not
resolve the original arguments again. Confirmation, Audit Trail target,
tracked-job identity and Daemon Client targeting therefore describe the same
invocation. An implicit target remains implicit so the Bridge Daemon can reject
ambiguous multi-window execution rather than selecting an active file.
