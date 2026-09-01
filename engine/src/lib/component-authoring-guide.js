// Agent-facing Component authoring contract. Keep command examples executable
// against the closed Figma Command Grammar; tests pin the referenced actions.

export const COMPONENT_AUTHORING_GUIDE = `Figma Component authoring — agent decision and execution guide

Mental model
- A main Component owns reusable structure. Instances keep that identity and expose only deliberate override points.
- A Component Set groups related main Components. Variant properties are axes derived from each Variant name (for example State=Default, Size=Medium); they are not created with component prop add.
- A component property definition alone does nothing. TEXT, BOOLEAN and INSTANCE_SWAP become functional only after they are bound to a compatible sublayer field. component prop list reports wired versus unbound definitions.
- Nested Instances keep their own identity. Expose a primary nested Instance when consumers of the wrapper should see its nested properties at the wrapper level.
- A Slot is a native flexible region inside a Component. Instance users can add, remove, reorder and resize slot children without detaching the Instance. slot create returns a 100×100 freeform Slot node; configure that node's Auto Layout and sizing before adding content.

Choose the correct property
1. TEXT — editable plain string on a named TEXT sublayer. Use for labels, titles, values and descriptions. The instance property panel does not author rich-text runs or list formatting.
2. BOOLEAN — controls one or more sublayers' visible field. Use for optional icons, badges, metadata or sections when visibility is the only difference. Do not use it for layers whose prototype connections must change; use Variants for interactive states.
3. INSTANCE_SWAP — controls mainComponent on a nested INSTANCE. Use for icons, avatars, illustrations or replaceable subcomponents. Preferred values curate the picker; they do not change the default.
4. VARIANT — a Component Set axis for mutually exclusive structural, visual or behavioral states such as State, Size, Tone, Orientation or Density. Create named main Components, then combine them. Do not make an icon-name axis, and do not build a full Cartesian product when combinations are not useful. Keep one Set below 30 Variants unless the user explicitly approves a larger matrix.
5. SLOT — flexible arbitrary or repeating nested content. Configure minChildren, maxChildren, preferred values, allowPreferredValuesOnly, displayEmptyByDefault and stretchChildOnInsert. A Slot cannot be the top-level Component itself. Component properties cannot directly bind to arbitrary layers placed inside a Slot; inserted component Instances retain their own properties.

Build sequence (writes stay sequential)
1. Inspect before writing:
   figma_run {args:["component","list","--json"]}
   figma_run {args:["component","prop","list","<component-or-set-id>","--json"]}
2. Render or create one main Component per meaningful Variant. Name every editable Text layer explicitly.
3. Combine Variants:
   figma_run {args:["component","combine","<id-a>","<id-b>","--name","Card"],confirm:true}
   Extend an existing Set with component add-variant --from. The command restores and verifies scalar/Slot references and nested exposure that Figma's native clone may drop.
4. Add scalar definitions (VARIANT and SLOT use their native workflows):
   figma_run {args:["component","prop","add","<component-id>","Title","text","Card title"],confirm:true}
   figma_run {args:["component","prop","add","<component-id>","Show badge","boolean","true"],confirm:true}
   figma_run {args:["component","prop","add","<component-id>","Leading icon","instance-swap","<default-component-id>","--preferred","<icon-id-a>,<icon-set-id-b>"],confirm:true}
5. Bind every scalar definition to a compatible descendant. Base names are accepted only when unambiguous; the exact #suffix returned by add is safest:
   figma_run {args:["component","prop","bind","<component-id>","Title#…","<text-layer-id>"],confirm:true}
   figma_run {args:["component","prop","bind","<component-id>","Show badge#…","<badge-layer-id>"],confirm:true}
   figma_run {args:["component","prop","bind","<component-id>","Leading icon#…","<nested-instance-id>"],confirm:true}
   Binding infers characters for TEXT, visible for BOOLEAN and mainComponent for INSTANCE_SWAP. It refuses accidental replacement unless --replace is explicit; --remove unbinds the same property.
6. Expose a primary nested Instance when a wrapper should surface its nested properties:
   figma_run {args:["component","nested","expose","<nested-instance-id>","true"],confirm:true}
   Hidden nested Instances also hide their exposed nested properties from wrapper consumers.
7. Create/configure native Slots:
   figma_run {args:["slot","create","<component-id>","Content","--settings","{\"minChildren\":1,\"maxChildren\":3,\"stretchChildOnInsert\":true,\"displayEmptyByDefault\":true}"],confirm:true}
   Capture the returned Slot node id. The native default is a 100×100 freeform container, so normalize its visual layout before inserting children:
   figma_run {args:["node","set","<returned-slot-id>","--layout-mode","vertical","--layout-sizing-horizontal","fill","--layout-sizing-vertical","hug","--item-spacing","12","--padding","0"],confirm:true}
   When a matching Variable exists, bind the gap instead of leaving the literal:
   figma_run {args:["node","bind","<returned-slot-id>","gap","space/12","--collection","<collection-name>"],confirm:true}
   figma_run {args:["slot","edit","<component-id>","Content#…","--preferred","[{\"type\":\"COMPONENT\",\"key\":\"<component-key>\"}]","--settings","{\"allowPreferredValuesOnly\":false}"],confirm:true}
8. Instantiate and exercise every contract:
   figma_run {args:["component","instantiate","<component-id>","--json"],confirm:true}
   figma_run {args:["component","prop","set","<instance-id>","Title","Changed title"],confirm:true}
   figma_run {args:["component","prop","set","<instance-id>","Show badge","false"],confirm:true}
   figma_run {args:["component","prop","set","<instance-id>","State","Active"],confirm:true}
   SLOT content is structural and cannot be changed through InstanceNode.setProperties. Resolve the Slot node inside the Instance, then insert a component Instance into that exact parent:
   figma_run {args:["component","instantiate","<preferred-main-component-id>","--parent","<instance-slot-id>","--json"],confirm:true}

Validation contract
- component prop list must show every TEXT/BOOLEAN/INSTANCE_SWAP definition as wired, every Variant as native-axis and every Slot as native-slot. An unbound scalar definition is a defect, not a completed property.
- Inspect the main Component, the instance and the property list. For nested wrappers, verify exposed=true on the intended primary nested Instance.
- Run slot validate on the component and on exercised Instances; BELOW_MIN, ABOVE_MAX and HAS_NON_PREFERRED are explicit failures.
- slot validate does not verify visual layout. A valid 100×100 freeform Slot can still overlap every child; inspect its tree and screenshot the exercised Instance.
- Treat the exercised Instance as authoritative for minChildren. An empty Slot on the main Component can report no violation until it is instantiated.
- Screenshot the main Component and at least one overridden Instance. Verify text replacement, Boolean visibility, Variant selection, Instance Swap, nested exposure and Slot content separately.

Figma sources
- Components guide: https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma
- Component properties: https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties
- Variants: https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants
- Slots: https://help.figma.com/hc/en-us/articles/38231200344599-Use-slots-to-build-flexible-components-in-Figma
`;
