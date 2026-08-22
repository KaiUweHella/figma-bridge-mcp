# Resolve every command through a Command Capability

Every Adapter resolves a Figma Command into one immutable Command Plan before
execution. Unknown commands default to denied, mutating and non-retryable so
adding a command cannot accidentally bypass confirmation, targeting, path
normalization or audit policy.

Effects use one closed four-axis vocabulary: `figma`, `workspace`, `network`
and `shared`, each with `none`, `read` or `write`. `network` records external
outbound access; the authenticated localhost Bridge transport remains an
availability fact. `shared` records persistent local state outside the
workspace, including downloaded reference material. Adapters may translate a
Capability-owned timeout class into deployment milliseconds, but they cannot
replace that class or the accepted outcome codes after planning.

The Capability Catalog resolves a closed recursive Figma Command Grammar before
those decisions. Every exposed nested action and documented alias has an
explicit canonical path; a contract compares that grammar with the real
Commander registration tree. Unknown nested actions are denied before
confirmation, Audit Trail creation, job scheduling or Adapter dispatch.
Accepted plans expose the canonical action path as a payload-free audit id,
never a positional value copied from argv.

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
