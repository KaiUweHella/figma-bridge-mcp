# Own Three-Way Token Sync

`tokens sync` uses one closed Token Sync Command Application from Commander and
`figma_run`. Both Adapters create the same authoritative Command Plan, prepare
the same bounded DTCG JSON or CSS source and prior lock, execute the same Figma
observation and optional mutation, and format the same result. Neither Adapter
re-enters Commander or owns a second generated-eval implementation.

The request accepts one source file, one exact Collection name, optional apply,
prune and whole-run conflict choices, plus one optional lockfile. Canonical argv
retains the option terminator and rejects duplicates, unknown options, extra
positionals and conflicting `--ours`/`--theirs` before Workspace or Plugin
access. Source normalization rejects duplicate flattened DTCG paths, repeated
normalized CSS custom-property names, invalid declared scalars and unsupported
types instead of silently overwriting or coercing them.

Read preflight resolves the Collection by one exact unambiguous name, validates
bounded local Collection and Variable catalogs, requires exact membership and
unique Variable names, and observes the actual Figma file identity. Aliases and
three-way disagreements stay explicit conflicts. The original sync policy used
the first declared mode; this Application deliberately preserves that policy
and reports additional modes. It does not adopt the default-mode policy of
Single-Collection Token Import as an incidental migration change.

Apply re-reads and compares the complete preflight immediately before the first
factory or setter. It stops after the first operation failure, then freshly
checks untouched rows, requested results, deletion/retype absence, newly
created identities and Collection membership. A closed mutation receipt binds
terminal status, operation counts, new ids and failure residue to the exact
planned operation sequence. Invalid, forged, malformed or oversized evidence
becomes non-retryable `verification-unavailable`; it cannot publish a lock.
Retype and delete are not described as atomic or rolled back because the Plugin
API cannot generally restore native Variable identity and bindings.

One process-safe lease derived from the canonical lock path covers prior-lock
read, Figma execution and publication for both Adapters. A successful lock
contains the observed or explicitly resolved file key and only freshly verified
Variable ids. It is fully written and fsynced to a unique sibling before one
rename replaces the prior lock. A failure before that commit point preserves
the prior bytes. If Figma already changed but lock publication fails, the
command reports completed dispatch and bounded committed residue instead of
claiming success or a safe retry.

Rejected alternatives are selecting the first duplicate resource, switching to
`defaultModeId` during migration, retrying a write after transport uncertainty,
publishing the lock from attempted operations alone, truncating the existing
lock in place, and presenting a multi-operation Figma apply as atomic.
