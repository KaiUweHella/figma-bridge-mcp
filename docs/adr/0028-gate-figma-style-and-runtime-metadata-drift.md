# Gate Figma Style unions and runtime metadata drift independently

Figma Bridge keeps three compatibility sources independent: the pinned
official Plugin typings, the Bridge projection/validator contract, and an
explicit live-runtime exception policy. Agreement between two sources never
silently rewrites the third.

Style Facts owns one data-only discriminant contract for `BaseStyle`, `Paint`,
`Effect`, `LayoutGrid`, `BlurEffect` and `NoiseEffect`. A TypeScript TypeChecker
resolves the actual official union members from the installed pinned typings.
The release gate reports new official values separately from stale Bridge
values and fails until serializers, validators, fixtures and the audited
typings version are reviewed together.

Publishable metadata has a separate maintainer-only live probe. It observes
only whether `description`, `descriptionMarkdown`, `documentationLinks`,
`remote` and `key` are present and whether their runtime shape is string,
boolean or array. It never returns metadata content, identities, links, names,
keys, file references or node ids. Missing subject kinds remain explicitly
unsampled.

Plugin typings 1.133.0 declare every observed Publishable field required. The
only accepted runtime exception is a missing `descriptionMarkdown` on a local
Text Style, which was observed live. It is not generalized to another field,
Style family, Component or Component Set. A newly missing field or wrong type
fails the compatibility audit until deliberately reviewed. Style Facts keeps
both description representations nullable so an otherwise valid runtime Style
does not become unusable while the upstream gap exists.
