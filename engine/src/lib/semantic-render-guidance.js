// Public Semantic Render authoring guidance derived from the same closed JSX
// property grammar and native-executor facts used by request preflight.
import {
  semanticJsxPropReference,
} from './semantic-jsx-props.js';
import {
  structuredRenderGuidanceFacts,
} from './structured-render-executor.js';

function requireProp(element, prop) {
  const reference = semanticJsxPropReference(element);
  if (!reference.props.includes(prop)) {
    throw new Error(`Semantic Render guidance requires unsupported <${element}> prop ${prop}.`);
  }
  return prop;
}

const facts = structuredRenderGuidanceFacts();
const instanceIdentityProp = requireProp('Instance', facts.instance.identityProp);
const imageSourceProp = requireProp('Image', facts.image.sourceProp);

const commands = Object.freeze([
  Object.freeze({
    id: 'link-component-entity',
    argv: Object.freeze(['link', 'set', '1:2', 'ui.card', '--kind', 'component']),
    confirm: true,
  }),
  Object.freeze({
    id: 'instance-prop-reference',
    argv: Object.freeze(['render', '--prop-reference', 'Instance']),
    confirm: false,
  }),
]);

const jsxExamples = Object.freeze([
  Object.freeze({
    id: 'linked-instance',
    jsx: `<Frame name="Example screen" flex="col"><Instance ${instanceIdentityProp}="ui.card" variant="State=Default" text:Title="Example" /></Frame>`,
  }),
  Object.freeze({
    id: 'materialized-image',
    jsx: `<Frame name="Image example"><Image name="Artwork" ${imageSourceProp}="assets/artwork.png" imageScale="FILL" /></Frame>`,
  }),
  Object.freeze({
    id: 'intentional-image-placeholder',
    jsx: '<Frame name="Placeholder example"><Image name="Artwork placeholder" /></Frame>',
  }),
]);

export const SEMANTIC_RENDER_GUIDANCE_CONTRACT = Object.freeze({
  version: 1,
  facts,
  commands,
  jsxExamples,
  propReferences: Object.freeze({
    Instance: semanticJsxPropReference('Instance'),
    Image: semanticJsxPropReference('Image'),
  }),
});

function commandExample(command) {
  return `figma_run {args:${JSON.stringify(command.argv)}${command.confirm ? ',confirm:true' : ''}}`;
}

/** Format only facts represented in SEMANTIC_RENDER_GUIDANCE_CONTRACT. */
export function formatSemanticRenderGuidance() {
  const [linkCommand, propReferenceCommand] = commands;
  const [instanceExample, imageExample, placeholderExample] = jsxExamples;
  return `4. Components in screens: executable Instance identity is a Registry
   Design Entity, never a visible component name, key or node id in JSX. Link
   the existing Component/Component Set once from the client workspace so the
   default figma-bridge.json manifest owns the durable identity:
   ${commandExample(linkCommand)}
   Then compose the exact linked entity and real overrides:
   ${instanceExample.jsx}
   The link must resolve to the target file before render preflight. Use
   ${commandExample(propReferenceCommand)} for the current bounded Instance
   props, reviewed aliases and dynamic override prefixes. Component-first
   multi-screen preflight blocks repeated flat structures until they become
   linked Instances or receive one exact reviewed flat-repetition approval.
5. Images: ${imageExample.jsx}
   A real ${imageSourceProp}= path is read and bounded by the host, embedded as
   ${facts.image.nativeAssetKind} bytes in the immutable Plan, and executed
   natively without Plugin network access. ${placeholderExample.jsx} is still
   a useful deliberate placeholder, but it selects
   ${facts.image.missingSourceExecutor}, reports
   ${facts.image.missingSourceStatus}, and carries the exact finding
   "${facts.image.missingSourceFact}". Inspect that finding and never claim
   native or pixel-exact image fidelity for the placeholder.`;
}
