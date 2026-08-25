# Own Text Style Variable binding with preflight and rollback

`style bind-font` and `style unbind-font` own one closed non-retrying Command
Application shared by Commander and MCP. Their requests accept one bounded
Text Style id or local name, one supported bindable field and, for binding,
one bounded local Variable id or name. Unknown fields, options, duplicate
options and excess input fail before confirmation or Plugin readiness.

The Plugin resolves one mutable local Text Style and, for binding, one local
Variable of the field's required STRING or FLOAT type. It also resolves the
Style's prior binding before the first write so a later setter failure has a
known restoration target. Ambiguous, missing, remote, incompatible or
malformed resources fail during preflight.

The synchronous `setBoundVariable` call is made exactly once on the success
path. If it throws, the Application attempts to restore the prior Variable or
the prior unbound state. Successful restoration reports `rolled-back`; failed
restoration reports bounded possible Style residue and never claims atomicity.
Neither outcome is retried automatically.

Results expose only compact Text Style and Variable identities, the field and
empty residue. Authored typography and `boundVariables` never cross this
mutation seam, retiring the last legacy Style mutation result that depended on
raw `__styleFacts` serialization.
