# Discriminate union references before target resolution

Commands that historically accepted a node id, native name or durable Bridge
label in one string now parse that field as a closed **Union Reference** before
Capability planning. The explicit variants are `node:`, `name:`, `label:` and
`query:`. Only `node:` delegates to **Node Reference** and may contribute a
Figma URL file key to **Figma Target Context**.

An unprefixed value canonicalizes to `query:`. This compatibility variant keeps
the prior exact and unique-fuzzy lookup behavior inside the already resolved
file, including bare node ids, while never interpreting a URL-shaped authored
name or label as file identity. Users can select a colliding literal prefix by
marking its actual kind, such as `name:node:primary`.

Page Navigation accepts node, name and query variants. Slides accepts node,
name, label and query variants. Component Set variant creation accepts node,
name and query variants. Explicit variants never fall through to another
identity surface during Plugin execution; `node:` cannot become a name lookup
and `label:` cannot become a node lookup.

The closed request retains a URL only long enough to plan the target, then
canonical argv carries the normalized node id. Commander and MCP consume the
same canonical argv, confirmation, Audit and target decisions. Explicit
`fileKey` remains stronger than URL-derived targeting. This extends the
semantic-field rule from ADR 0020 without restoring whole-argv URL scanning or
removing useful legacy searches.
