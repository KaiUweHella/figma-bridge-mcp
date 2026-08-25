# Derive the offline API reference from pinned official typings

The legacy `api setup` cloned a moving third-party Git branch through a shell
string into `engine/docs/figma-api`. In an npm or npx installation that path is
part of the installed package tree and may be read-only, ephemeral or governed
by package-manager integrity. Network redirects, repository size, entry count,
links and provenance were delegated to Git. `api index` also wrote beside the
installed package. This was a shallow acquisition Interface with security and
portability behavior spread across callers.

`@figma/plugin-typings` is now an exact production dependency at the reviewed
version `1.133.0`. It is the authoritative source for both capability coverage
and human/agent lookup. A single Official API Reference Material Module checks
the expected package name, version and reviewed SHA-256 of
`plugin-api.d.ts`, reads exact regular files without following links, and
projects all public interface, type, class and enum declarations plus bounded
member signatures and official prose.

`api setup` performs no network or shell execution. It writes only under the
private Bridge state directory with 0700 directories and a 0600 material file.
The source, projected file, declaration count, declaration/member sizes,
queries and agent context have explicit limits. Publication uses a unique
exclusive temporary file, fsync and atomic rename. Concurrent setup processes
may race only identical reviewed material; a failed validation or publication
leaves the previous known-good material readable. Unexpected entries, links,
inode changes and provenance drift fail closed.

The installed package tree remains read-only. Existing package-tree Markdown
is not trusted as active material; when found, commands give a clear one-way
`api setup` migration path. The official typings retain declaration comments
and documentation links, so compact lookup, full declaration/prose, method
search, index and bounded topic context remain available offline.

Command Plans record `network:none` and the exact Shared-State read/write
effect. Audit schema v4 admits one safe token, `materialVersion`, for API
reference commands; it never admits a URL, host path, credential or document
content. Audit History continues to read schemas 2 and 3.
