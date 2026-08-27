# Bind Design Entities once per Semantic Render Plan

Semantic Render input adapters author repository-owned Design Entity ids and
variant intent. They do not author component keys, local node ids or visible
component names as executable identity. During Command preparation, the host
reads the Design Link Registry once and projects only the entities used by the
request into an immutable Design Entity Binding Table.

The table records the Registry schema and content fingerprint, the resolved
Figma target constraint, entity kind and purpose, chosen handle, optional
exact-file fallback and every requested variant. Published component or
variant keys are preferred. A local node id is executable only when its
Registry file key exactly matches the Command target. Duplicate, missing,
wrong-kind, conflicting or stale links stop before Plugin readiness or any
resource or canvas mutation.

Native and generated compatibility executors consume the same table. Generated
code may materialize a temporary key/id descriptor after the original Plan has
passed validation, but that descriptor is not another Plan truth. Neither
executor may consult a later Registry revision, source prop handle, visible
name, fuzzy match or current Plugin selection to replace the binding.

An optional screen/frame entity on the rendered root is represented by a
`created-root` binding. The created node receives only the established
versioned `{version,id,kind}` plugin data, and the bounded Outcome returns its
current-file node locator. Rendering never rewrites the Registry implicitly.
A screen/frame root cannot be converted to a component in the same request,
because that would change its declared entity kind after binding.

This keeps local unpublished components useful in their exact file while
making cross-file and published reuse deterministic. Adding another input
adapter therefore requires producing Design Entity intent and consuming this
same binding seam, not adding another handle-resolution path.
