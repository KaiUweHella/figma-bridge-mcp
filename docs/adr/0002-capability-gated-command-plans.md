# Resolve every command through a Command Capability

Every adapter resolves a Figma Command into one immutable CommandPlan before execution. Unknown commands default to denied, mutating and non-retryable so adding a command cannot accidentally bypass confirmation, targeting, path normalization or audit policy.
