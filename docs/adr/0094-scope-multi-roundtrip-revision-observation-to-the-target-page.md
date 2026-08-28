# Scope multi-roundtrip revision observation to the target Page

One-root Design Capture and Asset Export use an explicit Page Revision
Observation instead of initializing Figma's document-wide `documentchange`
stream. The authenticated eval request carries the canonical target node id.
The Plugin resolves its containing Page, installs one bounded `nodechange`
listener per observed Page and returns Page identity plus before/after revision
facts. The host pins those facts together with Daemon connection and file
identity across every roundtrip and the final publication fence.

The Page observer map is bounded to 512 entries for one Plugin lifetime. A
missing or detached root, observer exhaustion, revision overflow, within-call
change, Page identity drift, connection drift or file drift fails explicitly.
An unrelated Page has a separate counter and therefore cannot invalidate the
target Page's capture. Asset bytes are still published only after a final
matching fence; the narrower scope does not weaken publication safety.

The protocol also carries an explicit Document observation for genuinely
multi-page work. That path retains `loadAllPagesAsync()` and the existing
document revision fields so its cost is intentional rather than an accidental
side effect of asking for metadata. Ordinary evals request no observation and
retain Figma's dynamic-page loading.

Compatibility stays version-bounded. The request preserves the former
document-revision flag so a known Plugin older than Page Observation can return
its existing Document proof. Plugin 3.3.26 and later must return the requested
Page proof; missing Page facts fail closed instead of silently falling back to
a full-document or connection-only claim. The signed `page-revision-v1`
capability makes the new transport behavior visible at connection health.

Live acceptance in a previously qualified large multi-page test document
proved that an unrelated-Page mutation kept the target proof stable, a
target-Page mutation advanced it, a stale publication fence was rejected, a
repeated Design Capture hit its cache and an Asset Export reached manifest-last
publication with a Page proof. A true unloaded-process latency comparison
is human-assisted because Figma must restart between scopes; warm timings are
never relabeled as cold evidence. The accepted large-document pair on Plugin
3.3.30 measured Page scope at 29.882 ms and Document scope at 328.544 ms for a
33-Page, 30,534-node first-party fixture. EFF-02 now keeps a generous 250 ms
absolute Page ceiling plus a 0.5 Page-to-Document ratio ceiling so a future
full-document regression fails without treating one workstation as universal.
