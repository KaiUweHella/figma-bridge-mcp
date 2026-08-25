# Never redispatch typed Semantic Render as eval

Semantic Render Plan v1 is the representative typed mutation family for the
accepted Fidelity Corpus. When local structural inspection accepts every plan
fact, the Command sends only the versioned plan to the static Plugin dispatcher.
A missing or stale Plugin capability is a typed-operation failure with upgrade
or reconnect guidance; it never causes the same intended design write to be
compiled and redispatched as generated JavaScript.

Generated eval remains an explicit compatibility Adapter only when local
preflight identifies a fact that the typed executor has not migrated. That
choice happens before Plugin readiness and before any document mutation. A
supported single or batch plan does not require an eval Adapter, and every
typed failure retains its structured executor identity.

This is stricter than merely refusing retries after uncertain writes. It keeps
the migrated operation's schema, validation, Dispatch Receipt, bounded result,
rollback report and audit identity stable even for a known pre-dispatch
capability rejection. Compatibility therefore cannot silently weaken typed
mutation evidence on an older Plugin.
