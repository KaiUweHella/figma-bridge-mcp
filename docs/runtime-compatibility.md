# Figma runtime compatibility probes

The installed Figma Plugin typings are compile-time evidence, not proof that a
live Figma runtime always returns every declared field. Release review uses two
independent checks:

- Style union drift resolves official discriminants through TypeScript's
  TypeChecker and compares them with the exact Bridge Style Facts contract.
- Publishable metadata drift performs an authenticated, read-only live probe
  that returns presence/type states only.

Run the live probe against an explicitly connected file:

```sh
npm run probe:figma-runtime-metadata -- --file-key FILE_KEY
```

An absent Style or Component kind is reported as `unsampled`, not compatible.
The sole reviewed runtime exception is missing `descriptionMarkdown` on a
local Text Style under typings 1.133.0. New omissions and wrong runtime types
fail until the exception policy and public projection are reviewed.
