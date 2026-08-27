# Resolve local Node bindings before remote lookup

Node Binding Facts resolve direct Alias identities from one bounded local
Variable catalog and one bounded local Collection catalog per Command. The
catalogs are loaded lazily only when the selected nodes actually contain a
binding, indexed once by exact id and capped independently of the bounded
result size.

An exact id found locally never calls Figma's per-resource lookup API. This
avoids multiplying remote-backed document API deadlines across a node's Alias
array while preserving exact local identity. An id absent from the local
catalog may use the exact per-resource API because it can represent an imported
remote Variable. If that lookup is unavailable, the result retains the exact
Alias id with `resolved: false`; it never guesses a local name or Collection.

The catalogs do not expand the output contract. Node count, binding count,
labels, ids and serialized results retain their existing independent bounds.
Moving this generated safe read from the conservative eval lane to the native
Typed Read lane is a separate transport change and is not implied here.
