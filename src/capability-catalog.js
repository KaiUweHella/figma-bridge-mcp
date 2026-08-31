// Capability Catalog for every Figma Command exposed through figma_run.
//
// Callers ask behavioural questions through the exported Interface; the
// descriptor Implementation stays private. This concentrates allowlisting,
// mutation safety, targeting, retry, timeout, path and background-job policy
// without making every Adapter understand the catalog schema.
import path from 'node:path';
import { homedir } from 'node:os';
import { FIGMA_TYPINGS_MATERIAL_VERSION } from '../engine/src/lib/api-reference-policy.js';
import {
  acceptsAssetExportArgv,
  assetExportArgvFromRequest,
  parseAssetExportRequest,
} from '../engine/src/application/asset-export-request.js';
import { acceptsDesignContractArgv } from '../engine/src/application/design-contract-request.js';
import {
  acceptsDesignLinkArgv,
  parseDesignLinkRequest,
} from '../engine/src/application/design-link-request.js';
import {
  acceptsCodeSpecArgv,
  codeSpecArgvFromRequest,
  codeSpecFigmaUrlFileKeyFromArgv,
  parseCodeSpecRequest,
} from '../engine/src/application/code-spec-request.js';
import {
  acceptsTokenExportArgv,
  parseTokenExportRequest,
  tokenExportArgvFromRequest,
  tokenExportFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/token-export-request.js';
import {
  acceptsInspectArgv,
  inspectArgvFromRequest,
  inspectFigmaUrlFileKeyFromArgv,
  parseInspectRequest,
} from '../engine/src/application/inspect-request.js';
import {
  acceptsHistoryArgv,
  historyArgvFromRequest,
  historyFigmaUrlFileKeyFromArgv,
  parseHistoryRequest,
} from '../engine/src/application/history-request.js';
import {
  acceptsNodeTextArgv,
  nodeTextFigmaUrlFileKeyFromArgv,
  nodeTextArgvFromRequest,
  parseNodeTextRequest,
} from '../engine/src/application/node-text-request.js';
import {
  acceptsNodeMoveArgv,
  nodeMoveArgvFromRequest,
  nodeMoveFigmaUrlFileKeyFromArgv,
  parseNodeMoveRequest,
} from '../engine/src/application/node-move-request.js';
import {
  acceptsNodeDuplicateArgv,
  nodeDuplicateArgvFromRequest,
  nodeDuplicateFigmaUrlFileKeyFromArgv,
  parseNodeDuplicateRequest,
} from '../engine/src/application/node-duplicate-request.js';
import {
  acceptsCreateFrameArgv,
  createFrameArgvFromRequest,
  createFrameFigmaUrlFileKeyFromArgv,
  parseCreateFrameRequest,
} from '../engine/src/application/create-frame-request.js';
import {
  acceptsCreateShapeArgv,
  createShapeArgvFromRequest,
  createShapeFigmaUrlFileKeyFromArgv,
  parseCreateShapeRequest,
} from '../engine/src/application/create-shape-request.js';
import {
  acceptsCreateCanvasNodeArgv,
  createCanvasNodeArgvFromRequest,
  createCanvasNodeFigmaUrlFileKeyFromArgv,
  parseCreateCanvasNodeRequest,
} from '../engine/src/application/create-canvas-node-request.js';
import {
  acceptsCreateLineArgv,
  createLineArgvFromRequest,
  createLineFigmaUrlFileKeyFromArgv,
  parseCreateLineRequest,
} from '../engine/src/application/create-line-request.js';
import {
  acceptsCreateAutoLayoutArgv,
  createAutoLayoutArgvFromRequest,
  createAutoLayoutFigmaUrlFileKeyFromArgv,
  parseCreateAutoLayoutRequest,
} from '../engine/src/application/create-auto-layout-request.js';
import {
  acceptsCreateTextArgv,
  createTextArgvFromRequest,
  createTextFigmaUrlFileKeyFromArgv,
  parseCreateTextRequest,
} from '../engine/src/application/create-text-request.js';
import {
  acceptsMeasurementMutationArgv,
  measurementMutationArgvFromRequest,
  measurementMutationFigmaUrlFileKeyFromArgv,
  parseMeasurementMutationRequest,
} from '../engine/src/application/measurement-mutation-request.js';
import {
  acceptsNodeRenameArgv,
  nodeRenameArgvFromRequest,
  nodeRenameFigmaUrlFileKeyFromArgv,
  parseNodeRenameRequest,
} from '../engine/src/application/node-rename-request.js';
import {
  acceptsNodeResizeArgv,
  nodeResizeArgvFromRequest,
  nodeResizeFigmaUrlFileKeyFromArgv,
  parseNodeResizeRequest,
} from '../engine/src/application/node-resize-request.js';
import {
  acceptsNodeReparentArgv,
  nodeReparentArgvFromRequest,
  nodeReparentFigmaUrlFileKeyFromArgv,
  parseNodeReparentRequest,
} from '../engine/src/application/node-reparent-request.js';
import {
  acceptsNodeGroupArgv,
  nodeGroupArgvFromRequest,
  nodeGroupFigmaUrlFileKeyFromArgv,
  parseNodeGroupRequest,
} from '../engine/src/application/node-group-request.js';
import { acceptsNodeUngroupArgv, nodeUngroupArgvFromRequest, nodeUngroupFigmaUrlFileKeyFromArgv, parseNodeUngroupRequest } from '../engine/src/application/node-ungroup-request.js';
import { acceptsNodeBooleanArgv, nodeBooleanArgvFromRequest, nodeBooleanFigmaUrlFileKeyFromArgv, parseNodeBooleanRequest } from '../engine/src/application/node-boolean-request.js';
import { acceptsNodeBindArgv, nodeBindArgvFromRequest, nodeBindFigmaUrlFileKeyFromArgv, parseNodeBindRequest } from '../engine/src/application/node-bind-request.js';
import { acceptsNodeSetFillArgv, nodeSetFillArgvFromRequest, nodeSetFillFigmaUrlFileKeyFromArgv, parseNodeSetFillRequest } from '../engine/src/application/node-set-fill-request.js';
import { acceptsNodeSetImageArgv, nodeSetImageArgvFromRequest, nodeSetImageFigmaUrlFileKeyFromArgv, parseNodeSetImageRequest } from '../engine/src/application/node-set-image-request.js';
import { acceptsNodeSetArgv, nodeSetArgvFromRequest, nodeSetFigmaUrlFileKeyFromArgv, parseNodeSetRequest } from '../engine/src/application/node-set-request.js';
import { acceptsNodeFlattenArgv, nodeFlattenArgvFromRequest, nodeFlattenFigmaUrlFileKeyFromArgv, parseNodeFlattenRequest } from '../engine/src/application/node-flatten-request.js';
import {
  acceptsNodeDeleteArgv,
  nodeDeleteArgvFromRequest,
  nodeDeleteFigmaUrlFileKeyFromArgv,
  parseNodeDeleteRequest,
} from '../engine/src/application/node-delete-request.js';
import {
  acceptsNodeToComponentArgv,
  nodeToComponentArgvFromRequest,
  nodeToComponentFigmaUrlFileKeyFromArgv,
  parseNodeToComponentRequest,
} from '../engine/src/application/node-to-component-request.js';
import {
  acceptsNodeCssArgv,
  nodeCssArgvFromRequest,
  nodeCssFigmaUrlFileKeyFromArgv,
  parseNodeCssRequest,
} from '../engine/src/application/node-css-request.js';
import {
  acceptsNodeBindingsArgv,
  nodeBindingsArgvFromRequest,
  nodeBindingsFigmaUrlFileKeyFromArgv,
  parseNodeBindingsRequest,
} from '../engine/src/application/node-bindings-request.js';
import {
  acceptsNodeTreeArgv,
  nodeTreeArgvFromRequest,
  nodeTreeFigmaUrlFileKeyFromArgv,
  parseNodeTreeRequest,
} from '../engine/src/application/node-tree-request.js';
import {
  acceptsNodeDiscoveryArgv,
  nodeDiscoveryArgvFromRequest,
  parseNodeDiscoveryRequest,
} from '../engine/src/application/node-discovery-request.js';
import {
  acceptsCanvasAwarenessArgv,
  canvasAwarenessArgvFromRequest,
  parseCanvasAwarenessRequest,
} from '../engine/src/application/canvas-awareness-request.js';
import {
  acceptsCollectionCatalogArgv,
  collectionCatalogArgvFromRequest,
  parseCollectionCatalogRequest,
} from '../engine/src/application/collection-catalog-request.js';
import {
  acceptsCollectionFactsArgv,
  collectionFactsArgvFromRequest,
  parseCollectionFactsRequest,
} from '../engine/src/application/collection-facts-request.js';
import {
  acceptsCollectionCreateArgv,
  collectionCreateArgvFromRequest,
  parseCollectionCreateRequest,
} from '../engine/src/application/collection-create-request.js';
import {
  acceptsCollectionUpdateArgv,
  collectionUpdateArgvFromRequest,
  parseCollectionUpdateRequest,
} from '../engine/src/application/collection-update-request.js';
import {
  acceptsCollectionModeArgv,
  collectionModeArgvFromRequest,
  parseCollectionModeRequest,
} from '../engine/src/application/collection-mode-request.js';
import {
  acceptsCollectionDeleteArgv,
  collectionDeleteArgvFromRequest,
  parseCollectionDeleteRequest,
} from '../engine/src/application/collection-delete-request.js';
import {
  acceptsCollectionExtendArgv,
  collectionExtendArgvFromRequest,
  parseCollectionExtendRequest,
} from '../engine/src/application/collection-extend-request.js';
import {
  acceptsPageNavigationArgv,
  pageNavigationArgvFromRequest,
  pageNavigationFigmaUrlFileKeyFromArgv,
  parsePageNavigationRequest,
} from '../engine/src/application/page-navigation-request.js';
import {
  acceptsSlidesReferenceArgv,
  parseSlidesReferenceRequest,
  slidesReferenceArgvFromRequest,
  slidesReferenceFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/slides-reference-request.js';
import {
  acceptsComponentSetReferenceArgv,
  componentSetReferenceArgvFromRequest,
  componentSetReferenceFigmaUrlFileKeyFromArgv,
  parseComponentSetReferenceRequest,
} from '../engine/src/application/component-set-reference-request.js';
import {
  acceptsComponentPropertySetArgv,
  componentPropertySetArgvFromRequest,
  componentPropertySetFigmaUrlFileKeyFromArgv,
  parseComponentPropertySetRequest,
} from '../engine/src/application/component-property-set-request.js';
import {
  acceptsComponentPropertyAddArgv,
  componentPropertyAddArgvFromRequest,
  componentPropertyAddFigmaUrlFileKeyFromArgv,
  parseComponentPropertyAddRequest,
} from '../engine/src/application/component-property-add-request.js';
import {
  acceptsComponentPropertyDeleteArgv,
  componentPropertyDeleteArgvFromRequest,
  componentPropertyDeleteFigmaUrlFileKeyFromArgv,
  parseComponentPropertyDeleteRequest,
} from '../engine/src/application/component-property-delete-request.js';
import {
  acceptsComponentPropertyListArgv,
  componentPropertyListArgvFromRequest,
  componentPropertyListFigmaUrlFileKeyFromArgv,
  parseComponentPropertyListRequest,
} from '../engine/src/application/component-property-list-request.js';
import {
  acceptsComponentInstantiateArgv,
  componentInstantiateArgvFromRequest,
  componentInstantiateFigmaUrlFileKeyFromArgv,
  parseComponentInstantiateRequest,
} from '../engine/src/application/component-instantiate-request.js';
import {
  acceptsComponentCreateArgv,
  componentCreateArgvFromRequest,
  componentCreateFigmaUrlFileKeyFromArgv,
  parseComponentCreateRequest,
} from '../engine/src/application/component-create-request.js';
import {
  acceptsComponentSwapArgv,
  componentSwapArgvFromRequest,
  componentSwapFigmaUrlFileKeyFromArgv,
  parseComponentSwapRequest,
} from '../engine/src/application/component-swap-request.js';
import {
  acceptsComponentDetachArgv,
  componentDetachArgvFromRequest,
  componentDetachFigmaUrlFileKeyFromArgv,
  parseComponentDetachRequest,
} from '../engine/src/application/component-detach-request.js';
import {
  acceptsComponentOverridesArgv,
  componentOverridesArgvFromRequest,
  componentOverridesFigmaUrlFileKeyFromArgv,
  parseComponentOverridesRequest,
} from '../engine/src/application/component-overrides-request.js';
import {
  acceptsComponentInventoryArgv,
  componentInventoryArgvFromRequest,
  parseComponentInventoryRequest,
} from '../engine/src/application/component-inventory-request.js';
import {
  acceptsPageStructureArgv,
  pageStructureArgvFromRequest,
  parsePageStructureRequest,
} from '../engine/src/application/page-structure-request.js';
import {
  acceptsPrototypeInspectionArgv,
  parsePrototypeInspectionRequest,
  prototypeInspectionArgvFromRequest,
  prototypeInspectionFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/prototype-inspection-request.js';
import {
  acceptsPrototypeMutationArgv,
  parsePrototypeMutationRequest,
  prototypeMutationArgvFromRequest,
  prototypeMutationFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/prototype-mutation-request.js';
import {
  acceptsVariableDiscoveryArgv,
  parseVariableDiscoveryRequest,
  variableDiscoveryArgvFromRequest,
} from '../engine/src/application/variable-discovery-request.js';
import {
  acceptsVariableCreateArgv,
  parseVariableCreateRequest,
  variableCreateArgvFromRequest,
} from '../engine/src/application/variable-create-request.js';
import {
  acceptsVariableCreateBatchArgv,
  parseVariableCreateBatchRequest,
  variableCreateBatchArgvFromRequest,
} from '../engine/src/application/variable-create-batch-request.js';
import {
  acceptsVariableVisualizationArgv,
  parseVariableVisualizationRequest,
  variableVisualizationArgvFromRequest,
} from '../engine/src/application/variable-visualization-request.js';
import {
  acceptsTokenPresetArgv,
  parseTokenPresetRequest,
  tokenPresetArgvFromRequest,
} from '../engine/src/application/token-preset-request.js';
import {
  acceptsTokenAddArgv,
  parseTokenAddRequest,
  tokenAddArgvFromRequest,
} from '../engine/src/application/token-add-request.js';
import {
  acceptsTokenOverlapArgv,
  parseTokenOverlapRequest,
  tokenOverlapArgvFromRequest,
} from '../engine/src/application/token-overlap-request.js';
import {
  acceptsTokenRebindArgv,
  parseTokenRebindRequest,
  tokenRebindArgvFromRequest,
} from '../engine/src/application/token-rebind-request.js';
import {
  acceptsTokenImportArgv,
  parseTokenImportRequest,
  tokenImportArgvFromRequest,
} from '../engine/src/application/token-import-request.js';
import {
  acceptsDesignMdArgv,
  designMdArgvFromRequest,
  parseDesignMdRequest,
} from '../engine/src/application/design-md-request.js';
import {
  acceptsDesignSourceImportArgv,
  designSourceImportArgvFromRequest,
  parseDesignSourceImportRequest,
} from '../engine/src/application/design-source-import-request.js';
import {
  acceptsVariableSetValueArgv,
  parseVariableSetValueRequest,
  variableSetValueArgvFromRequest,
} from '../engine/src/application/variable-set-value-request.js';
import {
  acceptsVariableSetValueBatchArgv,
  parseVariableSetValueBatchRequest,
  variableSetValueBatchArgvFromRequest,
  VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY,
} from '../engine/src/application/variable-set-value-batch-request.js';
import {
  acceptsVariableCodeSyntaxArgv,
  parseVariableCodeSyntaxRequest,
  variableCodeSyntaxArgvFromRequest,
} from '../engine/src/application/variable-code-syntax-request.js';
import {
  acceptsVariableUpdateArgv,
  parseVariableUpdateRequest,
  variableUpdateArgvFromRequest,
} from '../engine/src/application/variable-update-request.js';
import {
  acceptsVariableUpdateBatchArgv,
  parseVariableUpdateBatchRequest,
  variableUpdateBatchArgvFromRequest,
} from '../engine/src/application/variable-update-batch-request.js';
import {
  acceptsVariableDeleteArgv,
  parseVariableDeleteRequest,
  variableDeleteArgvFromRequest,
} from '../engine/src/application/variable-delete-request.js';
import {
  acceptsVariableFactsArgv,
  parseVariableFactsRequest,
  variableFactsArgvFromRequest,
} from '../engine/src/application/variable-facts-request.js';
import {
  acceptsVariableResolutionArgv,
  parseVariableResolutionRequest,
  variableResolutionArgvFromRequest,
  variableResolutionFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/variable-resolution-request.js';
import {
  acceptsTokenPublishStatusArgv,
  parseTokenPublishStatusRequest,
  tokenPublishStatusArgvFromRequest,
} from '../engine/src/application/token-publish-status-request.js';
import {
  acceptsFontInspectionArgv,
  fontInspectionArgvFromRequest,
  fontInspectionFigmaUrlFileKeyFromArgv,
  parseFontInspectionRequest,
} from '../engine/src/application/font-inspection-request.js';
import {
  acceptsFontVariableBindingArgv,
  fontVariableBindingArgvFromRequest,
  fontVariableBindingFigmaUrlFileKeyFromArgv,
  parseFontVariableBindingRequest,
} from '../engine/src/application/font-variable-binding-request.js';
import {
  acceptsComponentMainArgv,
  componentMainArgvFromRequest,
  componentMainFigmaUrlFileKeyFromArgv,
  parseComponentMainRequest,
} from '../engine/src/application/component-main-request.js';
import {
  acceptsComponentCombineArgv,
  componentCombineArgvFromRequest,
  componentCombineFigmaUrlFileKeyFromArgv,
  parseComponentCombineRequest,
} from '../engine/src/application/component-combine-request.js';
import {
  acceptsStyleFactsArgv,
  parseStyleFactsRequest,
  styleFactsArgvFromRequest,
} from '../engine/src/application/style-facts-request.js';
import {
  acceptsStyleCatalogArgv,
  parseStyleCatalogRequest,
  styleCatalogArgvFromRequest,
} from '../engine/src/application/style-catalog-request.js';
import {
  acceptsStyleConsumerArgv,
  parseStyleConsumerRequest,
  styleConsumerArgvFromRequest,
} from '../engine/src/application/style-consumer-request.js';
import {
  acceptsStylePublishStatusArgv,
  parseStylePublishStatusRequest,
  stylePublishStatusArgvFromRequest,
} from '../engine/src/application/style-publish-status-request.js';
import {
  acceptsStyleApplyArgv,
  parseStyleApplyRequest,
  styleApplyArgvFromRequest,
  styleApplyFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/style-apply-request.js';
import {
  acceptsStyleCreateArgv,
  parseStyleCreateRequest,
  styleCreateArgvFromRequest,
} from '../engine/src/application/style-create-request.js';
import {
  acceptsStyleUpdateArgv,
  parseStyleUpdateRequest,
  styleUpdateArgvFromRequest,
} from '../engine/src/application/style-update-request.js';
import {
  acceptsStyleDeleteArgv,
  parseStyleDeleteRequest,
  styleDeleteArgvFromRequest,
} from '../engine/src/application/style-delete-request.js';
import {
  acceptsTextStyleVariableBindingArgv,
  parseTextStyleVariableBindingRequest,
  textStyleVariableBindingArgvFromRequest,
} from '../engine/src/application/text-style-variable-binding-request.js';
import {
  acceptsLayoutGridFactsArgv,
  layoutGridFactsArgvFromRequest,
  layoutGridFactsFigmaUrlFileKeyFromArgv,
  parseLayoutGridFactsRequest,
} from '../engine/src/application/layout-grid-facts-request.js';
import {
  acceptsScreenshotArgv,
  parseScreenshotRequest,
  screenshotArgvFromRequest,
  screenshotFigmaUrlFileKeyFromArgv,
} from '../engine/src/application/screenshot-request.js';
import {
  acceptsLegacyRasterExportArgv,
  legacyRasterExportArgvFromRequest,
  legacyRasterExportFigmaUrlFileKeyFromArgv,
  parseLegacyRasterExportRequest,
} from '../engine/src/application/legacy-raster-export-request.js';
import {
  planVerificationArtifacts,
  verificationArtifactDirectory,
} from '../engine/src/application/verification-artifact.js';
import {
  acceptsSemanticRenderArgv,
  semanticCompoundRenderArgvFromRequest,
  semanticCompoundRenderRequestFromArgv,
  semanticRenderArgvFromRequest,
  semanticRenderArgvRoute,
  semanticRenderAssetIntentFromArgv,
  semanticRenderPolicyFromArgv,
  semanticRenderRequestFromArgv,
} from '../engine/src/application/semantic-render-request.js';
import { resolveFigmaTarget } from './figma-target.js';
import {
  FIGMA_URL_TARGET_ROOTS,
  projectFigmaUrlFileKey,
} from './figma-target-projection.js';
import {
  canonicalFigmaCommandRoot,
  listFigmaCommandGrammar,
  resolveFigmaCommandAction,
} from './figma-command-grammar.js';

const readGroup = (summary, readSubcommands, extra = {}) => ({
  summary, mutation: 'group', readSubcommands: new Set(readSubcommands), ...extra,
});

const COMMANDS = Object.freeze({
  render: { summary: 'Render JSX into Figma or print a semantic browser capture expression', mutation: 'render', timeout: 'long', target: 'conditional', path: 'render-inputs' },
  'render-batch': { summary: 'Render several JSX frames into Figma', mutation: 'render', timeout: 'long', target: 'conditional', path: 'render-inputs' },
  create: {
    summary: 'Create typed Figma primitives, optionally inside an existing parent',
    mutation: 'write',
  },
  combos: { summary: 'Generate component variant combinations', mutation: 'write' },
  sizes: { summary: 'Generate component size variants', mutation: 'write' },
  node: readGroup('Inspect or mutate nodes', ['tree', 'bindings', 'css'], { path: 'node-inputs' }),
  component: readGroup('Manage component properties and variants', ['list', 'main']),
  tokens: { summary: 'Read, generate or sync design tokens', mutation: 'tokens', path: 'token-files' },
  var: readGroup('Manage local variables', ['list', 'find', 'show', 'resolve', 'publish-status']),
  col: readGroup('Manage variable collections', ['list', 'show', 'publish-status']),
  style: readGroup('Manage local paint, text, effect, and grid styles', ['list', 'show', 'consumers', 'publish-status']),
  library: readGroup('Discover enabled libraries and import published assets', ['collections', 'variables']),
  prototype: readGroup('Inspect or manage native prototype reactions', ['inspect']),
  measure: readGroup('Inspect or manage Dev Mode measurements', ['list']),
  shader: readGroup('Discover, import, and apply native shaders', ['list']),
  layout: { summary: 'Inspect or manage native auto-layout features', mutation: 'layout' },
  slot: readGroup('Create, configure, validate, or reset component slots', ['inspect', 'validate']),
  draw: readGroup('Inspect or manage native Figma Draw features', ['inspect']),
  section: readGroup('Inspect or manage Figma sections', ['list']),
  grid: readGroup('Inspect or manage Layout Guides (not Auto Layout Grid)', ['list']),
  dev: readGroup('Inspect or manage dev-resource links', ['list']),
  annotate: readGroup('Inspect or manage annotations and categories', ['list', 'categories']),
  a11y: { summary: 'Run accessibility checks', mutation: 'read' },
  canvas: readGroup('Inspect pages or mutate the canvas', ['info', 'pages', 'page', 'next']),
  find: { summary: 'Find nodes by name', mutation: 'read', retry: 'safe-read', path: 'node-discovery-input' },
  verify: { summary: 'Capture a verification screenshot', mutation: 'read', path: 'verify-image', retry: 'safe-read' },
  inspect: { summary: 'Inspect one node as structured facts', mutation: 'read', retry: 'safe-read', path: 'inspect-input' },
  export: { summary: 'Export design facts, images and assets', mutation: 'read' },
  gradient: { summary: 'Extract and apply gradients', mutation: 'gradient', target: 'conditional', path: 'gradient-input' },
  pin: { summary: 'Pin nodes to parent edges', mutation: 'write' },
  api: { summary: 'Read the offline Figma Plugin reference', mutation: 'read', target: 'none' },
  import: { summary: 'Import a design source into Figma', mutation: 'write', path: 'design-source-import-input' },
  motion: readGroup('Inspect or manage motion data', ['styles', 'inspect'], { path: 'motion-inputs' }),
  extract: { summary: 'Extract the open file into DESIGN.md', mutation: 'read', path: 'design-doc' },
  spec: { summary: 'Read or enforce an extracted component spec', mutation: 'read', target: 'conditional', path: 'spec-file' },
  analyze: { summary: 'Analyze colors, typography and spacing', mutation: 'read' },
  font: readGroup('Inspect typography, bind variables, or preserve variable-axis metadata', ['inspect', 'axes'], { retry: 'safe-read' }),
  map: { summary: 'Map Figma components to code', mutation: 'read', path: 'map-file' },
  link: readGroup('Link durable Design Entities across code and Figma', ['inspect', 'list', 'configure', 'status', 'accept', 'context'], {
    target: 'conditional', path: 'design-link-registry',
  }),
  contract: { summary: 'Capture or check canonical Design Contracts for linked entities', mutation: 'read', path: 'design-contract' },
  'verify-build': { summary: 'Verify code against exported design facts', mutation: 'read', target: 'conditional', path: 'verify-build' },
  history: readGroup('Create or compare structural snapshots and save named Figma versions', ['snapshot', 'list', 'diff'], { path: 'history-output' }),
  jam: readGroup('Inspect or author FigJam boards', ['board']),
  slides: readGroup('Inspect or author Figma Slides decks (beta)', ['inspect']),
  kit: { summary: 'Prepare a design system for agent use', mutation: 'read', timeout: 'long', path: 'kit-files' },
});

const missingTargetProjections = Object.keys(COMMANDS)
  .filter((name) => !Object.hasOwn(FIGMA_URL_TARGET_ROOTS, name));
const orphanedTargetProjections = Object.keys(FIGMA_URL_TARGET_ROOTS)
  .filter((name) => !Object.hasOwn(COMMANDS, name));
if (missingTargetProjections.length || orphanedTargetProjections.length) {
  throw new Error(
    `Figma URL target projection catalog drift (missing: ${missingTargetProjections.join(', ') || 'none'}; `
    + `orphaned: ${orphanedTargetProjections.join(', ') || 'none'}).`,
  );
}

const HELP_TOKENS = new Set(['--help', '-h']);
const SAFE_READ_ACTIONS = new Set([
  'component.prop.list',
]);
// Editor context is deliberately separate from document content. Keep these
// action ids closed and source-audited: they are the commands that directly
// read or write selection, viewport, focus, or the current page.
const EDITOR_CONTEXT_READ_ACTIONS = new Set([
  'canvas.info', 'canvas.next', 'canvas.pages',
  'slides.inspect',
  'export.screenshot',
  'dev.list', 'annotate.list', 'a11y.vision', 'a11y.focus',
  'jam.board', 'jam.arrange',
]);
const EDITOR_CONTEXT_WRITE_ACTIONS = new Set([
  'sizes', 'var.visualize', 'gradient.mesh',
  'slides.create', 'slides.duplicate',
  'jam.sticky', 'jam.stickies', 'jam.shape', 'jam.table',
  'canvas.page',
]);
const COMMAND_PLANS = new WeakSet();
const CLI_COMMAND_APPLICATIONS = new Set([
  'import',
  'create.frame',
  'create.rect', 'create.ellipse', 'create.polygon', 'create.star',
  'create.vector', 'create.slice',
  'create.line',
  'create.autolayout',
  'create.text',
  'measure.add', 'measure.edit', 'measure.delete',
  'canvas.info', 'canvas.next', 'canvas.page', 'canvas.page-create',
  'canvas.page-divider', 'canvas.pages',
  'contract.capture', 'contract.check',
  'export.assets', 'export.code-spec', 'export.css', 'export.dtcg',
  'export.node', 'export.screenshot',
  'history.snapshot', 'history.list', 'history.diff', 'inspect', 'link.inspect',
  'link.set', 'node.bind', 'node.bindings', 'node.boolean', 'node.css', 'node.delete', 'node.duplicate', 'node.flatten', 'node.group', 'node.move', 'node.rename', 'node.reparent', 'node.resize', 'node.set', 'node.set-fill', 'node.set-image', 'node.set-text', 'node.ungroup',
  'node.to-component', 'node.tree', 'find',
  'font.bind', 'font.unbind', 'font.inspect', 'prototype.inspect',
  'prototype.add', 'prototype.set', 'prototype.clear',
  'render', 'render-batch', 'var.resolve', 'var.show', 'verify',
  'var.list', 'var.find',
  'var.create',
  'var.create-batch',
  'var.visualize',
  'tokens.spacing',
  'tokens.radii',
  'tokens.add',
  'tokens.import',
  'tokens.import-design-md',
  'tokens.overlap',
  'tokens.rebind',
  'var.set-value',
  'var.set-value-batch',
  'var.code-syntax',
  'var.update',
  'var.update-batch',
  'var.delete',
  'col.list', 'col.show',
  'var.publish-status', 'col.publish-status',
  'col.create',
  'col.update',
  'col.mode-add', 'col.mode-rename', 'col.mode-remove',
  'col.delete',
  'col.extend',
  'component.main', 'component.combine', 'component.add-variant', 'component.create',
  'component.swap', 'component.detach', 'component.overrides',
  'component.list',
  'component.instantiate',
  'component.prop.add', 'component.prop.delete', 'component.prop.list', 'component.prop.set',
  'style.list',
  'style.create',
  'style.update',
  'style.delete',
  'style.bind-font',
  'style.unbind-font',
  'style.apply',
  'style.consumers',
  'style.publish-status',
  'style.show',
  'grid.list',
]);
const VALUE_FLAGS = new Set(['--sections', '--pages', '-s', '--scale', '-f', '--format', '-d', '--depth']);
const UNKNOWN = Object.freeze({
  name: 'unknown',
  actionId: 'unknown',
  help: false,
  available: false,
  mutatesDesign: true,
  target: 'figma',
  retry: 'never',
  timeoutClass: 'default',
  execution: 'foreground',
  pathPolicy: 'none',
  summary: 'Unknown command',
  options: Object.freeze({ terminatorIndex: null, entries: Object.freeze([]) }),
});
const TOP_LEVEL_HELP = Object.freeze({
  name: '--help',
  actionId: 'help',
  help: true,
  available: true,
  mutatesDesign: false,
  target: 'none',
  retry: 'never',
  timeoutClass: 'default',
  execution: 'foreground',
  pathPolicy: 'none',
  summary: 'List available Figma Commands',
  options: Object.freeze({ terminatorIndex: null, entries: Object.freeze([]) }),
});

function optionEntries(optionFacts, names) {
  const accepted = new Set(Array.isArray(names) ? names : [names]);
  return optionFacts.entries.filter((entry) => accepted.has(entry.name));
}

function hasOption(optionFacts, name) {
  return optionEntries(optionFacts, name).length > 0;
}

/**
 * Temporary fail-closed gates for legacy mutations that cannot yet preserve a
 * bounded, preflighted and recoverable outcome. Returned text is static and
 * safe for user projection; no payload value is retained or interpolated.
 */
export function legacyCommandRiskGateReason(args) {
  if (!Array.isArray(args)) return null;
  if (args[0] === 'var' && args[1] === 'delete-all') {
    return 'var delete-all is disabled: use exact var delete <names...> or ambiguity-aware col delete <collection>.';
  }
  const action = resolveFigmaCommandAction(args);
  if (!action.accepted || action.help) return null;
  if (action.actionId === 'tokens.rebind'
    && hasOption(action.options, '--page') && hasOption(action.options, '--apply')) {
    return 'tokens rebind --page --apply is disabled until page-wide rebinding has bounded preflight and rollback. Use --page without --apply for a dry run, or --node <id> --apply for a scoped write.';
  }
  if (['node.set', 'node.bind'].includes(action.actionId)
    && hasOption(action.options, '--batch')) {
    return `${action.actionId.replace('.', ' ')} --batch is disabled until the typed bounded mutation operation is available. Use one explicit node per command.`;
  }
  return null;
}

function mutatesDesign(entry, args, options, actionId) {
  if (!args.length) return false;
  if (SAFE_READ_ACTIONS.has(actionId)) return false;
  const sub = args[1];
  if (actionId === 'import') {
    const request = parseDesignSourceImportRequest(args);
    if (request.printContext || request.type === 'storybook' || isUrl(request.source)) return false;
  }
  if (entry.mutation === 'write') return true;
  if (entry.mutation === 'render') return semanticRenderPolicyFromArgv(args).mutatesDesign;
  if (entry.mutation === 'read') return false;
  if (entry.mutation === 'gradient') {
    return sub !== 'extract' || hasOption(options, '--apply-to');
  }
  if (entry.mutation === 'layout') return !(sub === 'grid' && args[2] === 'inspect');
  const subIsAction = sub !== undefined && !sub.startsWith('-');
  if (entry.mutation === 'tokens') {
    if (sub === 'import-design-md' && hasOption(options, '--print-context')) return false;
    if (sub === 'sync' || sub === 'rebind') return hasOption(options, '--apply');
    return subIsAction && sub !== 'overlap';
  }
  if (entry.mutation === 'group') {
    return subIsAction && !entry.readSubcommands.has(sub);
  }
  return true;
}

function targetPolicy(name, entry, args, options) {
  if (name === 'import') {
    const request = parseDesignSourceImportRequest(args);
    if (request.printContext || request.type === 'storybook' || isUrl(request.source)) return 'none';
  }
  if (name === 'tokens' && args[1] === 'import-design-md'
    && hasOption(options, '--print-context')) return 'none';
  if (entry.target !== 'conditional') return entry.target || 'figma';
  if (name === 'spec') return hasOption(options, '--check') ? 'figma' : 'none';
  if (name === 'verify-build') return hasOption(options, '--node') ? 'figma' : 'none';
  if (name === 'gradient') {
    return args[1] === 'extract' && !hasOption(options, '--apply-to') ? 'none' : 'figma';
  }
  if (name === 'link') return ['list', 'configure'].includes(args[1]) ? 'none' : 'figma';
  if (name === 'render' || name === 'render-batch') return semanticRenderPolicyFromArgv(args).target;
  return 'figma';
}

function specializedPolicy(name, entry, args, actionId) {
  const sub = args[1];
  let execution = 'foreground';
  let timeoutClass = entry.timeout || 'default';
  let pathPolicy = entry.path || 'none';
  let retry = entry.retry || 'never';
  if (name === 'import') {
    timeoutClass = 'long';
    pathPolicy = 'design-source-import-input';
  }
  if (SAFE_READ_ACTIONS.has(actionId)) retry = 'safe-read';
  if (name === 'export') {
    if (sub === 'assets') {
      execution = 'background';
      timeoutClass = 'background';
      pathPolicy = 'assets-dir';
    } else if (sub === 'video') {
      pathPolicy = 'video-output';
    } else if (sub === 'node' || sub === 'screenshot') {
      pathPolicy = 'export-image';
    } else if (sub === 'code-spec') {
      retry = 'safe-read';
      pathPolicy = 'code-spec-input';
    } else if (sub === 'css' || sub === 'dtcg') {
      retry = 'safe-read';
      timeoutClass = 'long';
      pathPolicy = 'token-export-input';
    } else if (sub === 'node-json') {
      pathPolicy = 'node-json-output';
    }
  }
  if (name === 'link' && sub === 'inspect') retry = 'safe-read';
  if (name === 'node' && sub === 'bindings') retry = 'safe-read';
  if (name === 'node' && sub === 'css') retry = 'safe-read';
  if (name === 'node' && sub === 'tree') retry = 'safe-read';
  if (name === 'node' && sub === 'to-component') pathPolicy = 'node-to-component-input';
  if (name === 'node' && sub === 'duplicate') pathPolicy = 'node-duplicate-input';
  if (name === 'create' && sub === 'frame') pathPolicy = 'create-frame-input';
  if (['create.rect', 'create.ellipse', 'create.polygon', 'create.star'].includes(actionId)) {
    pathPolicy = 'create-shape-input';
  }
  if (['create.vector', 'create.slice'].includes(actionId)) pathPolicy = 'create-canvas-node-input';
  if (actionId === 'create.line') pathPolicy = 'create-line-input';
  if (actionId === 'create.autolayout') pathPolicy = 'create-auto-layout-input';
  if (actionId === 'create.text') pathPolicy = 'create-text-input';
  if (['measure.add', 'measure.edit', 'measure.delete'].includes(actionId)) {
    pathPolicy = 'measurement-mutation-input';
  }
  if (name === 'prototype' && sub === 'inspect') {
    retry = 'safe-read';
    pathPolicy = 'prototype-inspection-input';
  }
  if (name === 'prototype' && ['add', 'set', 'clear'].includes(sub)) {
    pathPolicy = 'prototype-mutation-input';
  }
  if (name === 'var' && sub === 'show') {
    retry = 'safe-read';
    pathPolicy = 'variable-facts-input';
  }
  if (name === 'var' && ['list', 'find'].includes(sub)) {
    retry = 'safe-read';
    pathPolicy = 'variable-discovery-input';
  }
  if (name === 'var' && sub === 'create') pathPolicy = 'variable-create-input';
  if (name === 'var' && sub === 'create-batch') pathPolicy = 'variable-create-batch-input';
  if (name === 'var' && sub === 'visualize') {
    timeoutClass = 'long';
    pathPolicy = 'variable-visualization-input';
  }
  if (name === 'tokens' && ['spacing', 'radii'].includes(sub)) {
    pathPolicy = 'token-preset-input';
  }
  if (name === 'tokens' && sub === 'add') pathPolicy = 'token-add-input';
  if (name === 'tokens' && sub === 'import') {
    timeoutClass = 'long';
    pathPolicy = 'token-import-input';
  }
  if (name === 'tokens' && sub === 'import-design-md') {
    timeoutClass = hasOption(resolveFigmaCommandAction(args).options, '--print-context')
      ? 'default' : 'long';
    pathPolicy = 'design-md-input';
  }
  if (name === 'tokens' && sub === 'overlap') {
    retry = 'safe-read';
    timeoutClass = 'long';
    pathPolicy = 'token-overlap-input';
  }
  if (name === 'tokens' && sub === 'rebind') {
    retry = args.includes('--apply') ? 'never' : 'safe-read';
    timeoutClass = 'long';
    pathPolicy = 'token-rebind-input';
  }
  if (name === 'var' && sub === 'set-value') pathPolicy = 'variable-set-value-input';
  if (name === 'var' && sub === 'set-value-batch') pathPolicy = 'variable-set-value-batch-input';
  if (name === 'var' && sub === 'code-syntax') pathPolicy = 'variable-code-syntax-input';
  if (name === 'var' && sub === 'update') pathPolicy = 'variable-update-input';
  if (name === 'var' && sub === 'update-batch') pathPolicy = 'variable-update-batch-input';
  if (name === 'var' && sub === 'delete') pathPolicy = 'variable-delete-input';
  if (name === 'var' && sub === 'resolve') {
    retry = 'safe-read';
    pathPolicy = 'variable-resolution-input';
  }
  if (name === 'col' && sub === 'list') {
    retry = 'safe-read';
    pathPolicy = 'collection-catalog-input';
  }
  if (name === 'col' && sub === 'show') {
    retry = 'safe-read';
    pathPolicy = 'collection-facts-input';
  }
  if ((name === 'var' || name === 'col') && sub === 'publish-status') {
    retry = 'safe-read';
    pathPolicy = 'token-publish-status-input';
  }
  if (name === 'col' && sub === 'create') pathPolicy = 'collection-create-input';
  if (name === 'col' && sub === 'update') pathPolicy = 'collection-update-input';
  if (name === 'col' && ['mode-add', 'mode-rename', 'mode-remove'].includes(sub)) {
    pathPolicy = 'collection-mode-input';
  }
  if (name === 'col' && sub === 'delete') pathPolicy = 'collection-delete-input';
  if (name === 'col' && sub === 'extend') pathPolicy = 'collection-extend-input';
  if (name === 'font' && sub === 'inspect') {
    retry = 'safe-read';
    pathPolicy = 'font-inspection-input';
  }
  if (name === 'font' && ['bind', 'unbind'].includes(sub)) pathPolicy = 'font-variable-binding-input';
  if (name === 'component' && sub === 'main') {
    retry = 'safe-read';
    pathPolicy = 'component-main-input';
  }
  if (name === 'component' && sub === 'combine') {
    pathPolicy = 'component-combine-input';
  }
  if (name === 'component' && sub === 'add-variant') {
    pathPolicy = 'component-set-reference-input';
  }
  if (name === 'component' && sub === 'create') {
    pathPolicy = 'component-create-input';
  }
  if (name === 'component' && sub === 'instantiate') {
    pathPolicy = 'component-instantiate-input';
  }
  if (name === 'component' && sub === 'swap') {
    pathPolicy = 'component-swap-input';
  }
  if (name === 'component' && sub === 'detach') {
    pathPolicy = 'component-detach-input';
  }
  if (name === 'component' && sub === 'overrides') {
    pathPolicy = 'component-overrides-input';
  }
  if (name === 'component' && sub === 'list') {
    retry = 'safe-read';
    if (args.includes('--all-pages')) timeoutClass = 'long';
    pathPolicy = 'component-inventory-input';
  }
  if (name === 'component' && sub === 'prop' && args[2] === 'set') {
    pathPolicy = 'component-property-set-input';
  }
  if (name === 'component' && sub === 'prop' && args[2] === 'add') {
    pathPolicy = 'component-property-add-input';
  }
  if (name === 'component' && sub === 'prop' && args[2] === 'delete') {
    pathPolicy = 'component-property-delete-input';
  }
  if (name === 'component' && sub === 'prop' && args[2] === 'list') {
    pathPolicy = 'component-property-list-input';
  }
  if (name === 'style' && sub === 'show') {
    retry = 'safe-read';
    pathPolicy = 'style-facts-input';
  }
  if (name === 'style' && sub === 'list') {
    retry = 'safe-read';
    pathPolicy = 'style-catalog-input';
  }
  if (name === 'style' && sub === 'consumers') {
    retry = 'safe-read';
    timeoutClass = 'long';
    pathPolicy = 'style-consumer-input';
  }
  if (name === 'style' && sub === 'publish-status') {
    retry = 'safe-read';
    pathPolicy = 'style-publish-status-input';
  }
  if (name === 'style' && sub === 'create') pathPolicy = 'style-create-input';
  if (name === 'style' && sub === 'update') pathPolicy = 'style-update-input';
  if (name === 'style' && sub === 'delete') pathPolicy = 'style-delete-input';
  if (name === 'style' && ['bind-font', 'unbind-font'].includes(sub)) pathPolicy = 'text-style-binding-input';
  if (name === 'style' && sub === 'apply') pathPolicy = 'style-apply-input';
  if (name === 'grid' && sub === 'list') {
    retry = 'safe-read';
    pathPolicy = 'layout-grid-facts-input';
  }
  if (name === 'canvas' && ['info', 'next'].includes(sub)) {
    retry = 'safe-read';
    pathPolicy = 'canvas-awareness-input';
  }
  if (name === 'canvas' && ['pages', 'page'].includes(sub)) {
    if (sub === 'pages') retry = 'safe-read';
    pathPolicy = 'page-navigation-input';
  }
  if (name === 'canvas' && ['page-create', 'page-divider'].includes(sub)) {
    pathPolicy = 'page-structure-input';
  }
  if (name === 'slides') {
    if (sub === 'inspect') retry = 'safe-read';
    pathPolicy = 'slides-reference-input';
  }
  return { execution, timeoutClass, pathPolicy, retry };
}

/** Resolve the private policy for one concrete argv. */
function commandCapability(args) {
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') {
    return UNKNOWN;
  }
  const requestedName = args[0];
  if (HELP_TOKENS.has(requestedName)) {
    return Object.freeze({ ...TOP_LEVEL_HELP, name: requestedName });
  }
  const name = canonicalFigmaCommandRoot(requestedName);
  if (!name) return Object.freeze({ ...UNKNOWN, name: requestedName });
  const entry = COMMANDS[name];
  if (!entry) return Object.freeze({ ...UNKNOWN, name });
  const action = resolveFigmaCommandAction(args);
  args = requestedName === name ? args : [name, ...args.slice(1)];
  if (legacyCommandRiskGateReason(args)) return Object.freeze({ ...UNKNOWN, name });
  if (!action.accepted) {
    return action.reason === 'unknown-option'
      ? Object.freeze({ ...UNKNOWN, name, mutatesDesign: false, target: 'none' })
      : Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'link' && !action.help && !acceptsDesignLinkArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'contract' && !action.help && !acceptsDesignContractArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'export' && args[1] === 'assets' && !action.help && !acceptsAssetExportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'export' && args[1] === 'code-spec' && !action.help && !acceptsCodeSpecArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'export' && ['css', 'dtcg'].includes(args[1])
    && !action.help && !acceptsTokenExportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'create' && args[1] === 'frame'
    && !action.help && !acceptsCreateFrameArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (['create.rect', 'create.ellipse', 'create.polygon', 'create.star'].includes(action.actionId)
    && !action.help && !acceptsCreateShapeArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (['create.vector', 'create.slice'].includes(action.actionId)
    && !action.help && !acceptsCreateCanvasNodeArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (action.actionId === 'create.line' && !action.help && !acceptsCreateLineArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (action.actionId === 'create.autolayout'
    && !action.help && !acceptsCreateAutoLayoutArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (action.actionId === 'create.text' && !action.help && !acceptsCreateTextArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (['measure.add', 'measure.edit', 'measure.delete'].includes(action.actionId)
    && !action.help && !acceptsMeasurementMutationArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'set-text' && !action.help && !acceptsNodeTextArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'move' && !action.help && !acceptsNodeMoveArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'duplicate'
    && !action.help && !acceptsNodeDuplicateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'rename' && !action.help && !acceptsNodeRenameArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'resize' && !action.help && !acceptsNodeResizeArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'reparent'
    && !action.help && !acceptsNodeReparentArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'group' && !action.help && !acceptsNodeGroupArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'ungroup' && !action.help && !acceptsNodeUngroupArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'boolean' && !action.help && !acceptsNodeBooleanArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'bind' && !action.help && !acceptsNodeBindArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'set' && !action.help && !acceptsNodeSetArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'set-fill' && !action.help && !acceptsNodeSetFillArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'set-image' && !action.help && !acceptsNodeSetImageArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'flatten' && !action.help && !acceptsNodeFlattenArgv(args)) return Object.freeze({ ...UNKNOWN, name });
  if (name === 'node' && args[1] === 'delete' && !action.help && !acceptsNodeDeleteArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'to-component'
    && !action.help && !acceptsNodeToComponentArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'tree' && !action.help && !acceptsNodeTreeArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'css' && !action.help && !acceptsNodeCssArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'node' && args[1] === 'bindings' && !action.help && !acceptsNodeBindingsArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'add-variant'
    && !action.help && !acceptsComponentSetReferenceArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'create'
    && !action.help && !acceptsComponentCreateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'instantiate'
    && !action.help && !acceptsComponentInstantiateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'swap'
    && !action.help && !acceptsComponentSwapArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'detach'
    && !action.help && !acceptsComponentDetachArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'overrides'
    && !action.help && !acceptsComponentOverridesArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'list'
    && !action.help && !acceptsComponentInventoryArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'prop' && args[2] === 'set'
    && !action.help && !acceptsComponentPropertySetArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'prop' && args[2] === 'add'
    && !action.help && !acceptsComponentPropertyAddArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'prop' && args[2] === 'delete'
    && !action.help && !acceptsComponentPropertyDeleteArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'prop' && args[2] === 'list'
    && !action.help && !acceptsComponentPropertyListArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'slides' && !action.help && !acceptsSlidesReferenceArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'find' && !action.help && !acceptsNodeDiscoveryArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'prototype' && args[1] === 'inspect'
    && !action.help && !acceptsPrototypeInspectionArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'prototype' && ['add', 'set', 'clear'].includes(args[1])
    && !action.help && !acceptsPrototypeMutationArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'show'
    && !action.help && !acceptsVariableFactsArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && ['list', 'find'].includes(args[1])
    && !action.help && !acceptsVariableDiscoveryArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'create'
    && !action.help && !acceptsVariableCreateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'create-batch'
    && !action.help && !acceptsVariableCreateBatchArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'visualize'
    && !action.help && !acceptsVariableVisualizationArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && ['spacing', 'radii'].includes(args[1])
    && !action.help && !acceptsTokenPresetArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && args[1] === 'add'
    && !action.help && !acceptsTokenAddArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && args[1] === 'import'
    && !action.help && !acceptsTokenImportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && args[1] === 'import-design-md'
    && !action.help && !acceptsDesignMdArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'import' && !action.help && !acceptsDesignSourceImportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && args[1] === 'overlap'
    && !action.help && !acceptsTokenOverlapArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'tokens' && args[1] === 'rebind'
    && !action.help && !acceptsTokenRebindArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'set-value'
    && !action.help && !acceptsVariableSetValueArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'set-value-batch'
    && !action.help && !acceptsVariableSetValueBatchArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'code-syntax'
    && !action.help && !acceptsVariableCodeSyntaxArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'update'
    && !action.help && !acceptsVariableUpdateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'update-batch'
    && !action.help && !acceptsVariableUpdateBatchArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'delete'
    && !action.help && !acceptsVariableDeleteArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'var' && args[1] === 'resolve'
    && !action.help && !acceptsVariableResolutionArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'list'
    && !action.help && !acceptsCollectionCatalogArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'show'
    && !action.help && !acceptsCollectionFactsArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if ((name === 'var' || name === 'col') && args[1] === 'publish-status'
    && !action.help && !acceptsTokenPublishStatusArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'create'
    && !action.help && !acceptsCollectionCreateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'update'
    && !action.help && !acceptsCollectionUpdateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && ['mode-add', 'mode-rename', 'mode-remove'].includes(args[1])
    && !action.help && !acceptsCollectionModeArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'delete'
    && !action.help && !acceptsCollectionDeleteArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'col' && args[1] === 'extend'
    && !action.help && !acceptsCollectionExtendArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'font' && args[1] === 'inspect'
    && !action.help && !acceptsFontInspectionArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'font' && ['bind', 'unbind'].includes(args[1])
    && !action.help && !acceptsFontVariableBindingArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'main'
    && !action.help && !acceptsComponentMainArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'component' && args[1] === 'combine'
    && !action.help && !acceptsComponentCombineArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'show'
    && !action.help && !acceptsStyleFactsArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'list'
    && !action.help && !acceptsStyleCatalogArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'consumers'
    && !action.help && !acceptsStyleConsumerArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'publish-status'
    && !action.help && !acceptsStylePublishStatusArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'create'
    && !action.help && !acceptsStyleCreateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'update'
    && !action.help && !acceptsStyleUpdateArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'delete'
    && !action.help && !acceptsStyleDeleteArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && ['bind-font', 'unbind-font'].includes(args[1])
    && !action.help && !acceptsTextStyleVariableBindingArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'style' && args[1] === 'apply'
    && !action.help && !acceptsStyleApplyArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'grid' && args[1] === 'list'
    && !action.help && !acceptsLayoutGridFactsArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'canvas' && ['info', 'next'].includes(args[1])
    && !action.help && !acceptsCanvasAwarenessArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'canvas' && ['pages', 'page'].includes(args[1])
    && !action.help && !acceptsPageNavigationArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'canvas' && ['page-create', 'page-divider'].includes(args[1])
    && !action.help && !acceptsPageStructureArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'inspect' && !action.help && !acceptsInspectArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'history' && ['snapshot', 'list', 'diff'].includes(args[1])
    && !action.help && !acceptsHistoryArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'verify' && !action.help && !acceptsScreenshotArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if (name === 'export' && ['node', 'screenshot'].includes(args[1])
    && !action.help && !acceptsLegacyRasterExportArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  if ((name === 'render' || name === 'render-batch') && !acceptsSemanticRenderArgv(args)) {
    return Object.freeze({ ...UNKNOWN, name });
  }
  const specialized = action.help
    ? { execution: 'foreground', timeoutClass: 'default', pathPolicy: 'none', retry: 'never' }
    : specializedPolicy(name, entry, args, action.actionId);
  return Object.freeze({
    name,
    actionId: action.actionId,
    help: action.help,
    available: true,
    mutatesDesign: action.help
      ? false
      : mutatesDesign(entry, args, action.options, action.actionId),
    target: action.help ? 'none' : targetPolicy(name, entry, args, action.options),
    retry: specialized.retry,
    timeoutClass: specialized.timeoutClass,
    execution: specialized.execution,
    pathPolicy: specialized.pathPolicy,
    summary: entry.summary,
    options: action.options,
  });
}

function allowedCommandNames() {
  return Object.freeze(Object.keys(COMMANDS));
}

function isBackgroundCommand(args) {
  return commandCapability(args).execution === 'background';
}

function acceptedExitCodes(args) {
  if (args?.[0] === 'history' && args?.[1] === 'diff') return [0, 1];
  if (args?.[0] === 'contract' && args?.[1] === 'check') return [0, 1];
  // Exit 1 is a valid verify report containing findings, not a transport
  // failure. MCP callers need the report in order to fix those findings.
  if (args?.[0] === 'verify-build') return [0, 1];
  if ((args?.[0] === 'render' || args?.[0] === 'render-batch') && acceptsSemanticRenderArgv(args)) {
    const route = semanticRenderArgvRoute(args);
    if (route.kind === 'simple' || route.kind === 'compound' || route.reason === 'structural-gate') return [0, 1];
  }
  return [0];
}

function commandHelpIndex() {
  const aliases = new Map(listFigmaCommandGrammar()
    .map((root) => [root.name, root.aliases]));
  return [...allowedCommandNames()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const names = aliases.get(name) || [];
      const alias = names.length ? ` (alias: ${names.join(', ')})` : '';
      return `${name} — ${COMMANDS[name].summary}${alias}`;
    })
    .join('\n');
}

const MAX_COMMAND_REJECTION_CODE_UNITS = 700;

function boundedCommandRejection(message) {
  return String(message).slice(0, MAX_COMMAND_REJECTION_CODE_UNITS);
}

function acceptedActionHint(rootName) {
  const root = listFigmaCommandGrammar().find((candidate) => candidate.name === rootName);
  const actions = (root?.children || []).filter((action) => action.exposed)
    .map((action) => action.name).sort((left, right) => left.localeCompare(right));
  const shown = actions.slice(0, 16);
  return shown.length
    ? `${shown.join(', ')}${actions.length > shown.length ? ', …' : ''}`
    : 'Run ["--help"]';
}

function optionNameFromArgv(args) {
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (token === '--figma-file') { index++; continue; }
    if (typeof token !== 'string' || token === '-' || !token.startsWith('-')) continue;
    const candidate = token.split('=', 1)[0];
    const match = candidate.match(/^--?[a-zA-Z][a-zA-Z0-9-]{0,63}/);
    return match ? match[0] : null;
  }
  return null;
}

function acceptedForm(actionId) {
  if (actionId === 'var.list') {
    return '["var","list","--limit","<1-1000>","--json"]';
  }
  if (actionId === 'var.find') {
    return '["var","find","<pattern>","--limit","<1-1000>","--json"]';
  }
  const [root, action] = actionId.split('.');
  return action ? `["${root}","${action}","--help"]` : `["${root}","--help"]`;
}

/**
 * Project a denied argv into bounded, payload-free guidance for human and MCP
 * Adapters. This does not change the fail-closed Command Plan.
 */
export function explainFigmaCommandRejection(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const rootName = canonicalFigmaCommandRoot(args[0]);
  const prefix = 'Unknown or unsupported Figma Command — ';
  if (!rootName) {
    return `${prefix}Unknown command group. Accepted form: ["--help"].`;
  }

  const normalized = args[0] === rootName ? [...args] : [rootName, ...args.slice(1)];
  const action = resolveFigmaCommandAction(normalized);
  if (!action.accepted) {
    if (action.reason === 'unknown-option') {
      const option = optionNameFromArgv(normalized);
      return boundedCommandRejection(
        `${prefix}Unsupported option${option ? ` ${option}` : ''} for ${rootName}. `
        + `Accepted actions: ${acceptedActionHint(rootName)}.`,
      );
    }
    return boundedCommandRejection(
      `${prefix}Unknown action for ${rootName}. Accepted actions: ${acceptedActionHint(rootName)}.`,
    );
  }

  const actionId = action.actionId.replace(/\.help$/, '');
  if (actionId === 'var.list' || actionId === 'var.find') {
    const label = actionId.replace('.', ' ');
    const option = optionNameFromArgv(normalized);
    if (option === '--collection' || option === '-c') {
      return boundedCommandRejection(
        `${prefix}${label} does not support --collection. Discover collections with `
        + '["col","list"], inspect one with ["col","show","<collection>"], then filter '
        + `returned Variable rows by collection identity. Accepted form: ${acceptedForm(actionId)}.`,
      );
    }
    try {
      parseVariableDiscoveryRequest(normalized);
    } catch (error) {
      const raw = error?.message || String(error);
      const detail = raw
        .replace(/^Invalid var (?:list|find) command: /, '')
        .replace(/\.$/, '');
      if (/^unknown option /.test(detail)) {
        const safeOption = option || detail.slice('unknown option '.length).match(/^--?[a-zA-Z][a-zA-Z0-9-]{0,63}/)?.[0];
        return boundedCommandRejection(
          `${prefix}Unsupported option${safeOption ? ` ${safeOption}` : ''} for ${label}. `
          + `Accepted form: ${acceptedForm(actionId)}.`,
        );
      }
      return boundedCommandRejection(
        `${prefix}Malformed value for ${label}: ${detail}. Accepted form: ${acceptedForm(actionId)}.`,
      );
    }
  }

  return boundedCommandRejection(
    `${prefix}Malformed request for ${actionId.replaceAll('.', ' ')}. `
    + `Accepted form: ${acceptedForm(actionId)}.`,
  );
}

function absolute(baseDir, value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function localPath(baseDir, value) {
  return isUrl(value) ? value : absolute(baseDir, value);
}

function inlineOptionValue(token, name) {
  if (typeof token !== 'string' || typeof name !== 'string') return null;
  if (token.startsWith(`${name}=`)) {
    return { separator: '=', value: token.slice(name.length + 1) };
  }
  if (/^-[^-]$/.test(name) && token.startsWith(name) && token.length > name.length) {
    return { separator: '', value: token.slice(name.length) };
  }
  return null;
}

function pathFlag(args, flags, baseDir, options) {
  const matches = optionEntries(options, flags);
  if (matches.length > 1) throw new Error(`Duplicate path option ${matches[1].name}.`);
  for (const entry of matches) {
    const arg = args[entry.index];
    const inline = entry.inline ? inlineOptionValue(arg, entry.name) : null;
    if (inline?.value) {
      const value = localPath(baseDir, inline.value);
      args[entry.index] = `${entry.name}${inline.separator}${value}`;
      return { value };
    }
    if (!entry.inline && typeof args[entry.index + 1] === 'string'
      && args[entry.index + 1] !== '--' && !args[entry.index + 1].startsWith('-')) {
      args[entry.index + 1] = localPath(baseDir, args[entry.index + 1]);
      return { value: args[entry.index + 1] };
    }
    throw new Error(`${entry.name} requires a path value.`);
  }
  return null;
}

function outputFlag(args, baseDir, defaultValue, options) {
  const matches = optionEntries(options, ['-o', '--output']);
  if (matches.length > 1) throw new Error(`Duplicate output option ${matches[1].name}.`);
  const entry = matches[0];
  if (entry && !entry.inline && typeof args[entry.index + 1] === 'string'
    && args[entry.index + 1] !== '--' && !args[entry.index + 1].startsWith('-')) {
    args[entry.index + 1] = absolute(baseDir, args[entry.index + 1]);
    return args[entry.index + 1];
  }
  if (entry?.inline) {
    const inline = inlineOptionValue(args[entry.index], entry.name);
    if (!inline?.value) throw new Error(`${entry.name} requires a path value.`);
    const value = absolute(baseDir, inline.value);
    args[entry.index] = `${entry.name}${inline.separator}${value}`;
    return value;
  }
  if (entry) throw new Error(`${entry.name} requires a path value.`);
  const value = absolute(baseDir, defaultValue);
  const insertion = options.terminatorIndex ?? args.length;
  args.splice(insertion, 0, '-o', value);
  return value;
}

function optionalOutputFlag(args, baseDir, options) {
  const matches = optionEntries(options, ['-o', '--output']);
  if (matches.length > 1) throw new Error(`Duplicate output option ${matches[1].name}.`);
  const entry = matches[0];
  if (!entry) return null;
  if (!entry.inline && typeof args[entry.index + 1] === 'string'
    && args[entry.index + 1] !== '--' && !args[entry.index + 1].startsWith('-')) {
    args[entry.index + 1] = absolute(baseDir, args[entry.index + 1]);
    return args[entry.index + 1];
  }
  if (!entry.inline) throw new Error(`${entry.name} requires a path value.`);
  const inline = inlineOptionValue(args[entry.index], entry.name);
  if (!inline?.value) throw new Error(`${entry.name} requires a path value.`);
  const value = absolute(baseDir, inline.value);
  args[entry.index] = `${entry.name}${inline.separator}${value}`;
  return value;
}

function normalizeVerifyBuild(args, baseDir, notePath) {
  const pathFlags = new Set([
    '--assets', '--compare', '--design', '--diff-out', '--fidelity-ledger', '--browser-capture',
  ]);
  const skipValue = new Set(['--node', '--max-diff']);
  let positionalDone = false;
  let literal = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!literal && arg === '--') { literal = true; continue; }
    if (literal) {
      if (!positionalDone) {
        args[index] = absolute(baseDir, arg);
        notePath(args[index], 'read', 'verify-build-project', 'directory');
        positionalDone = true;
      }
      continue;
    }
    const combined = arg.match(/^(--[a-z-]+)=(.*)$/);
    if (combined) {
      if (pathFlags.has(combined[1])) {
        const value = absolute(baseDir, combined[2]);
        args[index] = `${combined[1]}=${value}`;
        notePath(value, combined[1] === '--diff-out' ? 'write' : 'read', `verify-build-${combined[1].slice(2)}`, combined[1] === '--assets' ? 'any' : 'file');
      }
      continue;
    }
    if (pathFlags.has(arg)) {
      if (typeof args[index + 1] === 'string') {
        args[index + 1] = absolute(baseDir, args[index + 1]);
        notePath(args[index + 1], arg === '--diff-out' ? 'write' : 'read', `verify-build-${arg.slice(2)}`, arg === '--assets' ? 'any' : 'file');
      }
      index++;
      continue;
    }
    if (skipValue.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    if (!positionalDone) {
      args[index] = absolute(baseDir, arg);
      notePath(args[index], 'read', 'verify-build-project', 'directory');
      positionalDone = true;
    }
  }
}

function insertBeforeTerminator(args, ...values) {
  const terminator = args.indexOf('--');
  args.splice(terminator === -1 ? args.length : terminator, 0, ...values);
}

function positionalIndexes(args, start, valueFlags = []) {
  const consumesValue = new Set(valueFlags);
  const indexes = [];
  let literal = false;
  for (let index = start; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === '--') { literal = true; continue; }
    if (!literal && typeof token === 'string' && token.startsWith('-')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (equals === -1 && consumesValue.has(name)) index++;
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

/** Normalize all project-relative paths named by the command policy. */
function prepareCommandArgs(rawArgs, baseDir = process.cwd(), {
  projectUrlTarget = true,
  verificationArtifactNonce = undefined,
  temporaryArtifactRoot = undefined,
} = {}) {
  const args = [...rawArgs];
  const capability = commandCapability(args);
  if (capability.available && Object.hasOwn(COMMANDS, capability.name)
    && args[0] !== capability.name) {
    args[0] = capability.name;
  }
  let figmaUrlFileKey = projectUrlTarget && capability.available && !capability.help
    ? projectFigmaUrlFileKey(args, capability.actionId)
    : null;
  let outputPath = null;
  let outputRole = null;
  let artifactOutputs = [];
  let workspace = 'none';
  const paths = [];
  const notePath = (value, access, role, kind = access === 'read' ? 'file' : 'any') => {
    if (typeof value !== 'string' || isUrl(value)) return;
    paths.push(Object.freeze({ path: value, access, role, kind }));
  };
  const markRead = (value = null, role = 'workspace-input', kind = 'file') => {
    if (workspace === 'none') workspace = 'read';
    if (value) notePath(value, 'read', role, kind);
  };
  const markOptionalRead = (value, role = 'workspace-input', kind = 'file') => {
    if (workspace === 'none') workspace = 'read';
    if (value) notePath(value, 'read-optional', role, kind);
  };
  const markWrite = (value = null, role = 'workspace-output', kind = 'any') => {
    workspace = 'write';
    if (value) {
      outputPath = value;
      notePath(value, 'write', role, kind);
    }
  };
  switch (capability.pathPolicy) {
    case 'assets-dir':
      outputPath = outputFlag(args, baseDir, 'assets', capability.options);
      // Canonical semantic argv gives equivalent default spellings and option
      // order one background identity. The output is already absolute here.
      args.splice(0, args.length, ...assetExportArgvFromRequest(parseAssetExportRequest(args)));
      markWrite(outputPath, 'asset-export-directory', 'directory');
      break;
    case 'export-image':
      {
        const request = parseLegacyRasterExportRequest(args);
        const explicitPath = absolute(baseDir, request.outputPath);
        const closedFileKey = legacyRasterExportFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget && closedFileKey !== figmaUrlFileKey) {
          throw new Error('Raster Export target projection disagrees with its closed request Interface.');
        }
        args.splice(0, args.length, ...legacyRasterExportArgvFromRequest({
          ...request,
          outputPath: explicitPath,
        }));
        if (request.format === 'PNG') {
          markWrite(explicitPath, 'verification-image-output');
          outputPath = null;
          artifactOutputs = [...planVerificationArtifacts({ explicitPath })];
        } else {
          outputRole = 'export-image-output';
          markWrite(explicitPath, 'export-image-output');
        }
      }
      break;
    case 'video-output': {
      const format = String(flagValue(args, ['--format', '-f'], capability.options) || 'mp4').toLowerCase();
      outputPath = outputFlag(args, baseDir, `video.${format}`, capability.options);
      markWrite(outputPath, 'video-output');
      break;
    }
    case 'token-export-input': {
      const closedFileKey = tokenExportFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      const request = parseTokenExportRequest(args);
      const output = request.output ? absolute(baseDir, request.output) : null;
      args.splice(0, args.length, ...tokenExportArgvFromRequest({ ...request, output }));
      if (output) {
        outputRole = 'dtcg-output';
        markWrite(output, 'dtcg-output');
      }
      break;
    }
    case 'node-json-output': {
      const output = optionalOutputFlag(args, baseDir, capability.options);
      if (output) markWrite(output, 'node-json-output');
      break;
    }
    case 'design-doc': {
      let literal = false;
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (!literal && arg === '--') { literal = true; continue; }
        if (!literal && VALUE_FLAGS.has(arg)) { index++; continue; }
        if (!literal && arg.startsWith('-')) continue;
        args[index] = absolute(baseDir, arg);
        outputPath = args[index];
        markWrite(outputPath, 'design-document-output');
        break;
      }
      if (!outputPath) {
        outputPath = absolute(baseDir, 'DESIGN.md');
        args.push(outputPath);
        markWrite(outputPath, 'design-document-output');
      }
      break;
    }
    case 'map-file':
      if (args[1] === 'storybook') {
        const [sourceIndex] = positionalIndexes(args, 2, ['-o', '--output']);
        if (typeof args[sourceIndex] === 'string' && !isUrl(args[sourceIndex])) {
          args[sourceIndex] = absolute(baseDir, args[sourceIndex]);
          markRead(args[sourceIndex], 'storybook-source', 'any');
        }
      }
      outputPath = outputFlag(args, baseDir, 'figma-map.json', capability.options);
      markWrite(outputPath, 'component-map-output');
      break;
    case 'design-link-registry': {
      const supplied = pathFlag(args, ['--manifest'], baseDir, capability.options);
      const manifest = supplied?.value || absolute(baseDir, 'figma-bridge.json');
      if (!supplied) insertBeforeTerminator(args, '--manifest', manifest);
      outputPath = manifest;
      if (['set', 'accept', 'configure'].includes(args[1])) markWrite(manifest, 'design-link-manifest');
      else if (['inspect', 'list'].includes(args[1])) markOptionalRead(manifest, 'design-link-manifest');
      else markRead(manifest, 'design-link-manifest');
      if (args[1] === 'accept') {
        const compare = pathFlag(args, ['--compare'], baseDir, capability.options);
        if (compare) markRead(compare.value, 'design-link-comparison');
      }
      break;
    }
    case 'design-contract': {
      const suppliedManifest = pathFlag(args, ['--manifest'], baseDir, capability.options);
      const manifest = suppliedManifest?.value || absolute(baseDir, 'figma-bridge.json');
      if (!suppliedManifest) insertBeforeTerminator(args, '--manifest', manifest);
      markRead(manifest, 'design-contract-manifest');
      let file = pathFlag(args, ['--file'], baseDir, capability.options)?.value;
      if (!file) {
        const slug = String(args[2] || 'entity').replace(/[^a-zA-Z0-9._-]+/g, '_');
        file = absolute(baseDir, path.join('design-contracts', `${slug}.json`));
        insertBeforeTerminator(args, '--file', file);
      }
      if (args[1] === 'capture') markWrite(file, 'design-contract-file');
      else markRead(file, 'design-contract-file');
      break;
    }
    case 'verify-build':
      normalizeVerifyBuild(args, baseDir, notePath);
      markRead();
      break;
    case 'verify-image': {
      if (projectUrlTarget) figmaUrlFileKey = screenshotFigmaUrlFileKeyFromArgv(args);
      const request = parseScreenshotRequest(args);
      if (request.persistence === 'workspace') {
        const explicitPath = absolute(baseDir, request.savePath);
        args.splice(0, args.length, ...screenshotArgvFromRequest({ ...request, savePath: explicitPath }));
        markWrite(explicitPath, 'verification-image-output');
        outputPath = null;
        artifactOutputs = [...planVerificationArtifacts({ explicitPath })];
      } else {
        args.splice(0, args.length, ...screenshotArgvFromRequest(request));
        if (request.persistence === 'temporary') {
          artifactOutputs = [...planVerificationArtifacts({
            ...(verificationArtifactNonce === undefined ? {} : { nonce: verificationArtifactNonce }),
            ...(temporaryArtifactRoot === undefined ? {} : { temporaryRoot: temporaryArtifactRoot }),
          })];
        }
      }
      break;
    }
    case 'render-inputs': {
      const initialRoute = semanticRenderArgvRoute(args);
      // Browser-capture expression generation returns before every project
      // input in Commander. Keep its Plan honest: unused paths are neither
      // authorized nor reported as effects.
      if (['browser-capture-expression', 'prop-reference'].includes(initialRoute.reason)) break;
      const icons = pathFlag(args, ['--icons'], baseDir, capability.options);
      if (icons) markRead(icons.value, 'render-icons', 'directory');
      const capture = pathFlag(args, ['--dom-capture'], baseDir, capability.options);
      if (capture) markRead(capture.value, 'dom-capture');
      const suppliedManifest = pathFlag(args, ['--manifest'], baseDir, capability.options);
      const manifest = suppliedManifest?.value || absolute(baseDir, 'figma-bridge.json');
      markOptionalRead(manifest, 'render-manifest');
      markOptionalRead(path.join(path.dirname(manifest), 'figma-map.json'), 'legacy-component-map');
      const routeAfterPaths = semanticRenderArgvRoute(args);
      if (routeAfterPaths.kind === 'simple') {
        const request = semanticRenderRequestFromArgv(args);
        args.splice(0, args.length, ...semanticRenderArgvFromRequest({ ...request, manifest }));
      } else if (routeAfterPaths.kind === 'compound') {
        const request = semanticCompoundRenderRequestFromArgv(args);
        args.splice(0, args.length, ...semanticCompoundRenderArgvFromRequest({ ...request, manifest }));
      } else if (!suppliedManifest) {
        const terminator = args.indexOf('--');
        args.splice(terminator === -1 ? args.length : terminator, 0, '--manifest', manifest);
      }
      const finalRoute = semanticRenderArgvRoute(args);
      if (finalRoute.kind === 'compound') {
        const assets = semanticRenderAssetIntentFromArgv(args);
        for (const localAsset of assets.localPaths) {
          markRead(absolute(baseDir, localAsset), 'render-image');
        }
      }
      if (hasOption(capability.options, '--verify')) {
        const request = finalRoute.kind === 'compound'
          ? semanticCompoundRenderRequestFromArgv(args)
          : null;
        const existingDirectory = request?.stages.verificationDirectory
          || flagValue(args, '--verification-output-dir', capability.options);
        artifactOutputs = [...planVerificationArtifacts({
          count: request?.roots.length || 1,
          ...(verificationArtifactNonce === undefined ? {} : { nonce: verificationArtifactNonce }),
          ...(temporaryArtifactRoot === undefined ? {} : { temporaryRoot: temporaryArtifactRoot }),
          ...(existingDirectory ? { plannedDirectory: existingDirectory } : {}),
        })];
        const plannedDirectory = verificationArtifactDirectory(artifactOutputs);
        if (request) {
          args.splice(0, args.length, ...semanticCompoundRenderArgvFromRequest({
            ...request,
            stages: Object.freeze({ ...request.stages, verificationDirectory: plannedDirectory }),
          }));
        } else if (!existingDirectory) {
          const terminator = args.indexOf('--');
          args.splice(terminator === -1 ? args.length : terminator, 0,
            `--verification-output-dir=${plannedDirectory}`);
        }
      }
      break;
    }
    case 'node-inputs': {
      if (args[1] === 'bindings') {
        const closedNodeBindingsFileKey = nodeBindingsFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeBindingsFileKey;
        args.splice(0, args.length,
          ...nodeBindingsArgvFromRequest(parseNodeBindingsRequest(args)));
      } else if (args[1] === 'css') {
        const closedNodeCssFileKey = nodeCssFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeCssFileKey;
        args.splice(0, args.length, ...nodeCssArgvFromRequest(parseNodeCssRequest(args)));
      } else if (args[1] === 'tree') {
        const closedNodeTreeFileKey = nodeTreeFigmaUrlFileKeyFromArgv(args);
        // Tree options may precede the optional node. The typed request owns
        // target projection instead of the legacy fixed argv position.
        if (projectUrlTarget) figmaUrlFileKey = closedNodeTreeFileKey;
        args.splice(0, args.length, ...nodeTreeArgvFromRequest(parseNodeTreeRequest(args)));
      } else if (args[1] === 'set-text') {
        // Equivalent node spellings and optional literal delimiters become
        // one semantic argv. The original input remains available separately
        // to Figma Target Context resolution for URL-derived file identity.
        const closedNodeTextFileKey = nodeTextFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget && closedNodeTextFileKey !== figmaUrlFileKey) {
          throw new Error('Node Text target projection disagrees with its closed request Interface.');
        }
        args.splice(0, args.length, ...nodeTextArgvFromRequest(parseNodeTextRequest(args)));
      } else if (args[1] === 'move') {
        const closedNodeMoveFileKey = nodeMoveFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeMoveFileKey;
        args.splice(0, args.length, ...nodeMoveArgvFromRequest(parseNodeMoveRequest(args)));
      } else if (args[1] === 'rename') {
        const closedNodeRenameFileKey = nodeRenameFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeRenameFileKey;
        args.splice(0, args.length,
          ...nodeRenameArgvFromRequest(parseNodeRenameRequest(args)));
      } else if (args[1] === 'resize') {
        const closedNodeResizeFileKey = nodeResizeFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeResizeFileKey;
        args.splice(0, args.length,
          ...nodeResizeArgvFromRequest(parseNodeResizeRequest(args)));
      } else if (args[1] === 'reparent') {
        const closedNodeReparentFileKey = nodeReparentFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeReparentFileKey;
        args.splice(0, args.length,
          ...nodeReparentArgvFromRequest(parseNodeReparentRequest(args)));
      } else if (args[1] === 'group') {
        const closedNodeGroupFileKey = nodeGroupFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeGroupFileKey;
        args.splice(0, args.length, ...nodeGroupArgvFromRequest(parseNodeGroupRequest(args)));
      } else if (args[1] === 'ungroup') {
        const closedNodeUngroupFileKey = nodeUngroupFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeUngroupFileKey;
        args.splice(0, args.length, ...nodeUngroupArgvFromRequest(parseNodeUngroupRequest(args)));
      } else if (args[1] === 'boolean') {
        const closedNodeBooleanFileKey = nodeBooleanFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeBooleanFileKey;
        args.splice(0, args.length, ...nodeBooleanArgvFromRequest(parseNodeBooleanRequest(args)));
      } else if (args[1] === 'bind') {
        const closedNodeBindFileKey = nodeBindFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeBindFileKey;
        args.splice(0, args.length, ...nodeBindArgvFromRequest(parseNodeBindRequest(args)));
      } else if (args[1] === 'set') {
        const closedNodeSetFileKey = nodeSetFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeSetFileKey;
        args.splice(0, args.length, ...nodeSetArgvFromRequest(parseNodeSetRequest(args)));
      } else if (args[1] === 'set-fill') {
        const closedNodeSetFillFileKey = nodeSetFillFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeSetFillFileKey;
        args.splice(0, args.length, ...nodeSetFillArgvFromRequest(parseNodeSetFillRequest(args)));
      } else if (args[1] === 'flatten') {
        const closedNodeFlattenFileKey = nodeFlattenFigmaUrlFileKeyFromArgv(args); if (projectUrlTarget) figmaUrlFileKey = closedNodeFlattenFileKey;
        args.splice(0, args.length, ...nodeFlattenArgvFromRequest(parseNodeFlattenRequest(args)));
      } else if (args[1] === 'delete') {
        const closedNodeDeleteFileKey = nodeDeleteFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeDeleteFileKey;
        args.splice(0, args.length, ...nodeDeleteArgvFromRequest(parseNodeDeleteRequest(args)));
      } else if (args[1] === 'set-image') {
        const imageIndex = positionalIndexes(args, 2, ['--scale'])[1];
        if (typeof args[imageIndex] === 'string') {
          args[imageIndex] = absolute(baseDir, args[imageIndex]);
          markRead(args[imageIndex], 'node-image');
        }
        const closedNodeSetImageFileKey = nodeSetImageFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget) figmaUrlFileKey = closedNodeSetImageFileKey;
        args.splice(0, args.length, ...nodeSetImageArgvFromRequest(parseNodeSetImageRequest(args)));
      }
      break;
    }
    case 'node-to-component-input': {
      const closedFileKey = nodeToComponentFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...nodeToComponentArgvFromRequest(parseNodeToComponentRequest(args)));
      break;
    }
    case 'node-duplicate-input': {
      const closedFileKey = nodeDuplicateFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...nodeDuplicateArgvFromRequest(parseNodeDuplicateRequest(args)));
      break;
    }
    case 'create-frame-input': {
      const closedFileKey = createFrameFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...createFrameArgvFromRequest(parseCreateFrameRequest(args)));
      break;
    }
    case 'create-shape-input': {
      const closedFileKey = createShapeFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...createShapeArgvFromRequest(parseCreateShapeRequest(args)));
      break;
    }
    case 'create-canvas-node-input': {
      const closedFileKey = createCanvasNodeFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...createCanvasNodeArgvFromRequest(parseCreateCanvasNodeRequest(args)));
      break;
    }
    case 'create-line-input': {
      const closedFileKey = createLineFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...createLineArgvFromRequest(parseCreateLineRequest(args)));
      break;
    }
    case 'create-auto-layout-input': {
      const closedFileKey = createAutoLayoutFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...createAutoLayoutArgvFromRequest(parseCreateAutoLayoutRequest(args)));
      break;
    }
    case 'create-text-input': {
      const closedFileKey = createTextFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...createTextArgvFromRequest(parseCreateTextRequest(args)));
      break;
    }
    case 'measurement-mutation-input': {
      if (projectUrlTarget) figmaUrlFileKey = measurementMutationFigmaUrlFileKeyFromArgv(args);
      args.splice(0, args.length,
        ...measurementMutationArgvFromRequest(parseMeasurementMutationRequest(args)));
      break;
    }
    case 'component-main-input': {
      const closedFileKey = componentMainFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...componentMainArgvFromRequest(parseComponentMainRequest(args)));
      break;
    }
    case 'component-combine-input': {
      const closedFileKey = componentCombineFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...componentCombineArgvFromRequest(parseComponentCombineRequest(args)));
      break;
    }
    case 'component-set-reference-input': {
      const closedFileKey = componentSetReferenceFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentSetReferenceArgvFromRequest(
        parseComponentSetReferenceRequest(args)));
      break;
    }
    case 'component-instantiate-input': {
      const closedFileKey = componentInstantiateFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentInstantiateArgvFromRequest(
        parseComponentInstantiateRequest(args)));
      break;
    }
    case 'component-create-input': {
      const closedFileKey = componentCreateFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentCreateArgvFromRequest(
        parseComponentCreateRequest(args)));
      break;
    }
    case 'component-swap-input': {
      const closedFileKey = componentSwapFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentSwapArgvFromRequest(
        parseComponentSwapRequest(args)));
      break;
    }
    case 'component-detach-input': {
      const closedFileKey = componentDetachFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentDetachArgvFromRequest(
        parseComponentDetachRequest(args)));
      break;
    }
    case 'component-overrides-input': {
      const closedFileKey = componentOverridesFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentOverridesArgvFromRequest(
        parseComponentOverridesRequest(args)));
      break;
    }
    case 'component-inventory-input':
      args.splice(0, args.length, ...componentInventoryArgvFromRequest(
        parseComponentInventoryRequest(args)));
      break;
    case 'component-property-set-input': {
      const closedFileKey = componentPropertySetFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentPropertySetArgvFromRequest(
        parseComponentPropertySetRequest(args)));
      break;
    }
    case 'component-property-add-input': {
      const closedFileKey = componentPropertyAddFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentPropertyAddArgvFromRequest(
        parseComponentPropertyAddRequest(args)));
      break;
    }
    case 'component-property-delete-input': {
      const closedFileKey = componentPropertyDeleteFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentPropertyDeleteArgvFromRequest(
        parseComponentPropertyDeleteRequest(args)));
      break;
    }
    case 'component-property-list-input': {
      const closedFileKey = componentPropertyListFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...componentPropertyListArgvFromRequest(
        parseComponentPropertyListRequest(args)));
      break;
    }
    case 'style-facts-input': {
      args.splice(0, args.length,
        ...styleFactsArgvFromRequest(parseStyleFactsRequest(args)));
      break;
    }
    case 'style-catalog-input': {
      args.splice(0, args.length,
        ...styleCatalogArgvFromRequest(parseStyleCatalogRequest(args)));
      break;
    }
    case 'style-consumer-input': {
      args.splice(0, args.length,
        ...styleConsumerArgvFromRequest(parseStyleConsumerRequest(args)));
      break;
    }
    case 'style-publish-status-input': {
      args.splice(0, args.length,
        ...stylePublishStatusArgvFromRequest(parseStylePublishStatusRequest(args)));
      break;
    }
    case 'style-create-input': {
      args.splice(0, args.length, ...styleCreateArgvFromRequest(parseStyleCreateRequest(args)));
      break;
    }
    case 'style-update-input': {
      args.splice(0, args.length, ...styleUpdateArgvFromRequest(parseStyleUpdateRequest(args)));
      break;
    }
    case 'style-delete-input': {
      args.splice(0, args.length, ...styleDeleteArgvFromRequest(parseStyleDeleteRequest(args)));
      break;
    }
    case 'text-style-binding-input': {
      args.splice(0, args.length, ...textStyleVariableBindingArgvFromRequest(
        parseTextStyleVariableBindingRequest(args)));
      break;
    }
    case 'style-apply-input': {
      const closedFileKey = styleApplyFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length, ...styleApplyArgvFromRequest(parseStyleApplyRequest(args)));
      break;
    }
    case 'layout-grid-facts-input': {
      const closedFileKey = layoutGridFactsFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...layoutGridFactsArgvFromRequest(parseLayoutGridFactsRequest(args)));
      break;
    }
    case 'canvas-awareness-input': {
      args.splice(0, args.length,
        ...canvasAwarenessArgvFromRequest(parseCanvasAwarenessRequest(args)));
      break;
    }
    case 'page-navigation-input': {
      const closedPageFileKey = pageNavigationFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedPageFileKey;
      args.splice(0, args.length,
        ...pageNavigationArgvFromRequest(parsePageNavigationRequest(args)));
      break;
    }
    case 'page-structure-input': {
      args.splice(0, args.length,
        ...pageStructureArgvFromRequest(parsePageStructureRequest(args)));
      break;
    }
    case 'slides-reference-input': {
      const closedFileKey = slidesReferenceFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...slidesReferenceArgvFromRequest(parseSlidesReferenceRequest(args)));
      break;
    }
    case 'node-discovery-input': {
      args.splice(0, args.length,
        ...nodeDiscoveryArgvFromRequest(parseNodeDiscoveryRequest(args)));
      break;
    }
    case 'prototype-inspection-input': {
      const closedPrototypeFileKey = prototypeInspectionFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget && closedPrototypeFileKey !== figmaUrlFileKey) {
        throw new Error('Prototype Inspection target projection disagrees with its closed request Interface.');
      }
      args.splice(0, args.length,
        ...prototypeInspectionArgvFromRequest(parsePrototypeInspectionRequest(args)));
      break;
    }
    case 'prototype-mutation-input': {
      if (projectUrlTarget) figmaUrlFileKey = prototypeMutationFigmaUrlFileKeyFromArgv(args);
      args.splice(0, args.length,
        ...prototypeMutationArgvFromRequest(parsePrototypeMutationRequest(args)));
      break;
    }
    case 'variable-facts-input': {
      args.splice(0, args.length,
        ...variableFactsArgvFromRequest(parseVariableFactsRequest(args)));
      break;
    }
    case 'variable-discovery-input': {
      args.splice(0, args.length,
        ...variableDiscoveryArgvFromRequest(parseVariableDiscoveryRequest(args)));
      break;
    }
    case 'variable-create-input': {
      args.splice(0, args.length,
        ...variableCreateArgvFromRequest(parseVariableCreateRequest(args)));
      break;
    }
    case 'variable-create-batch-input': {
      args.splice(0, args.length,
        ...variableCreateBatchArgvFromRequest(parseVariableCreateBatchRequest(args)));
      break;
    }
    case 'variable-visualization-input': {
      args.splice(0, args.length,
        ...variableVisualizationArgvFromRequest(parseVariableVisualizationRequest(args)));
      break;
    }
    case 'token-preset-input': {
      args.splice(0, args.length,
        ...tokenPresetArgvFromRequest(parseTokenPresetRequest(args)));
      break;
    }
    case 'token-add-input': {
      args.splice(0, args.length,
        ...tokenAddArgvFromRequest(parseTokenAddRequest(args)));
      break;
    }
    case 'token-import-input': {
      const request = parseTokenImportRequest(args);
      const file = absolute(baseDir, request.file);
      args.splice(0, args.length, ...tokenImportArgvFromRequest({ ...request, file }));
      markRead(file, 'token-file');
      break;
    }
    case 'token-overlap-input': {
      args.splice(0, args.length,
        ...tokenOverlapArgvFromRequest(parseTokenOverlapRequest(args)));
      break;
    }
    case 'token-rebind-input': {
      args.splice(0, args.length,
        ...tokenRebindArgvFromRequest(parseTokenRebindRequest(args)));
      break;
    }
    case 'variable-set-value-input': {
      args.splice(0, args.length,
        ...variableSetValueArgvFromRequest(parseVariableSetValueRequest(args)));
      break;
    }
    case 'variable-set-value-batch-input': {
      args.splice(0, args.length,
        ...variableSetValueBatchArgvFromRequest(parseVariableSetValueBatchRequest(args)));
      break;
    }
    case 'variable-code-syntax-input': {
      args.splice(0, args.length,
        ...variableCodeSyntaxArgvFromRequest(parseVariableCodeSyntaxRequest(args)));
      break;
    }
    case 'variable-update-input': {
      args.splice(0, args.length,
        ...variableUpdateArgvFromRequest(parseVariableUpdateRequest(args)));
      break;
    }
    case 'variable-update-batch-input': {
      args.splice(0, args.length,
        ...variableUpdateBatchArgvFromRequest(parseVariableUpdateBatchRequest(args)));
      break;
    }
    case 'variable-delete-input': {
      args.splice(0, args.length,
        ...variableDeleteArgvFromRequest(parseVariableDeleteRequest(args)));
      break;
    }
    case 'variable-resolution-input': {
      const closedFileKey = variableResolutionFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...variableResolutionArgvFromRequest(parseVariableResolutionRequest(args)));
      break;
    }
    case 'collection-catalog-input': {
      args.splice(0, args.length,
        ...collectionCatalogArgvFromRequest(parseCollectionCatalogRequest(args)));
      break;
    }
    case 'collection-facts-input': {
      args.splice(0, args.length,
        ...collectionFactsArgvFromRequest(parseCollectionFactsRequest(args)));
      break;
    }
    case 'token-publish-status-input': {
      args.splice(0, args.length,
        ...tokenPublishStatusArgvFromRequest(parseTokenPublishStatusRequest(args)));
      break;
    }
    case 'collection-create-input': {
      args.splice(0, args.length,
        ...collectionCreateArgvFromRequest(parseCollectionCreateRequest(args)));
      break;
    }
    case 'collection-update-input': {
      args.splice(0, args.length,
        ...collectionUpdateArgvFromRequest(parseCollectionUpdateRequest(args)));
      break;
    }
    case 'collection-mode-input': {
      args.splice(0, args.length,
        ...collectionModeArgvFromRequest(parseCollectionModeRequest(args)));
      break;
    }
    case 'collection-delete-input': {
      args.splice(0, args.length,
        ...collectionDeleteArgvFromRequest(parseCollectionDeleteRequest(args)));
      break;
    }
    case 'collection-extend-input': {
      args.splice(0, args.length,
        ...collectionExtendArgvFromRequest(parseCollectionExtendRequest(args)));
      break;
    }
    case 'font-inspection-input': {
      const closedFileKey = fontInspectionFigmaUrlFileKeyFromArgv(args);
      // Commander accepts options before the node. The closed request owns
      // semantic target projection; fixed legacy argv positions do not.
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...fontInspectionArgvFromRequest(parseFontInspectionRequest(args)));
      break;
    }
    case 'font-variable-binding-input': {
      const closedFileKey = fontVariableBindingFigmaUrlFileKeyFromArgv(args);
      if (projectUrlTarget) figmaUrlFileKey = closedFileKey;
      args.splice(0, args.length,
        ...fontVariableBindingArgvFromRequest(parseFontVariableBindingRequest(args)));
      break;
    }
    case 'inspect-input': {
      const closedInspectFileKey = inspectFigmaUrlFileKeyFromArgv(args);
      // Commander accepts options before or after the positional node. The
      // typed request, rather than a fixed argv index, therefore owns target
      // projection for this migrated Command Application.
      if (projectUrlTarget) figmaUrlFileKey = closedInspectFileKey;
      args.splice(0, args.length, ...inspectArgvFromRequest(parseInspectRequest(args)));
      break;
    }
    case 'code-spec-input': {
      if (projectUrlTarget) figmaUrlFileKey = codeSpecFigmaUrlFileKeyFromArgv(args);
      args.splice(0, args.length, ...codeSpecArgvFromRequest(parseCodeSpecRequest(args)));
      break;
    }
    case 'gradient-input': {
      const [imageIndex] = positionalIndexes(args, 2, [
        '--mode', '--apply-to', '--direction', '--stops', '--blur',
      ]);
      if (args[1] === 'extract' && typeof args[imageIndex] === 'string') {
        args[imageIndex] = absolute(baseDir, args[imageIndex]);
        markRead(args[imageIndex], 'gradient-image');
      }
      break;
    }
    case 'token-files': {
      const [fileIndex] = positionalIndexes(args, 2, [
        '-c', '--collection', '--lockfile',
      ]);
      if (['import', 'sync', 'import-design-md'].includes(args[1])
        && typeof args[fileIndex] === 'string') {
        args[fileIndex] = absolute(baseDir, args[fileIndex]);
        markRead(args[fileIndex], 'token-file');
      }
      const lockfile = pathFlag(args, ['--lockfile'], baseDir, capability.options);
      if (lockfile) {
        // A missing lockfile is valid on first sync, so authorize it as a
        // write target. Existing files are reopened securely by WorkspaceIO.
        if (args[1] === 'sync') markWrite(lockfile.value, 'token-lockfile');
        else markRead(lockfile.value, 'token-lockfile');
      } else if (args[1] === 'sync') {
        // Sync persists its default lockfile beside the token file.
        if (typeof args[fileIndex] !== 'string') {
          throw new Error('tokens sync requires one token file before policy planning.');
        }
        const defaultLock = absolute(baseDir,
          path.join(path.dirname(args[fileIndex]), 'figma-tokens.lock.json'));
        markWrite(defaultLock, 'token-lockfile');
      }
      break;
    }
    case 'design-md-input': {
      const request = parseDesignMdRequest(args);
      const file = absolute(baseDir, request.file);
      args.splice(0, args.length, ...designMdArgvFromRequest({ ...request, file }));
      markRead(file, 'design-document');
      break;
    }
    case 'design-source-import-input': {
      const request = parseDesignSourceImportRequest(args);
      const source = isUrl(request.source) ? request.source : absolute(baseDir, request.source);
      const save = request.save == null ? null : absolute(baseDir, request.save);
      args.splice(0, args.length, ...designSourceImportArgvFromRequest({
        ...request, source, save,
      }));
      if (!isUrl(source)) markRead(source, 'import-source', 'any');
      if (save) {
        markWrite(save, 'import-output');
        outputRole = 'import-output';
      }
      break;
    }
    case 'motion-inputs': {
      const [motionInputIndex] = positionalIndexes(args, 2);
      if (args[1] === 'apply' && typeof args[motionInputIndex] === 'string'
        && !args[motionInputIndex].trimStart().startsWith('{')) {
        args[motionInputIndex] = absolute(baseDir, args[motionInputIndex]);
        markRead(args[motionInputIndex], 'motion-file');
      }
      break;
    }
    case 'spec-file': {
      const supplied = pathFlag(args, ['-f', '--file'], baseDir, capability.options);
      if (supplied) markRead(supplied.value, 'design-spec-file');
      else markRead(absolute(baseDir, '.'), 'design-spec-search', 'directory');
      break;
    }
    case 'history-output': {
      if (['snapshot', 'list', 'diff'].includes(args[1])) {
        const request = parseHistoryRequest(args);
        const closedFileKey = historyFigmaUrlFileKeyFromArgv(args);
        if (projectUrlTarget && closedFileKey !== figmaUrlFileKey) {
          throw new Error('History target projection disagrees with its closed request Interface.');
        }
        const normalized = request.action === 'diff' && request.changelogPath
          ? { ...request, changelogPath: absolute(baseDir, request.changelogPath) }
          : request;
        args.splice(0, args.length, ...historyArgvFromRequest(normalized));
        if (normalized.action === 'diff' && normalized.changelogPath) {
          markWrite(normalized.changelogPath, 'history-changelog');
        }
      }
      break;
    }
    case 'kit-files': {
      if (args[1] === 'init') {
        const [projectIndex] = positionalIndexes(args, 2, [
          '--out', '--storybook', '--node', '--manifest',
        ]);
        if (typeof args[projectIndex] === 'string') {
          args[projectIndex] = absolute(baseDir, args[projectIndex]);
        }
        const projectRoot = args[projectIndex] || absolute(baseDir, '.');
        const out = flagValue(args, '--out', capability.options) || 'design';
        const storybook = pathFlag(args, ['--storybook'], baseDir, capability.options);
        if (storybook && isUrl(storybook.value)) {
          // URLs are external inputs, not workspace reads.
        } else if (storybook) markRead(storybook.value, 'storybook-source', 'any');
        markWrite(projectRoot, 'kit-project-directory', 'directory');
        notePath(path.resolve(projectRoot, out), 'write', 'kit-output-directory', 'directory');
      }
      break;
    }
    default:
      break;
  }
  return {
    args,
    outputPath,
    outputRole,
    artifactOutputs: Object.freeze(artifactOutputs),
    capability,
    workspace,
    paths: Object.freeze(paths),
    figmaUrlFileKey,
  };
}

function backgroundJobIdentity(args, fileKey) {
  if (!isBackgroundCommand(args)) return null;
  return JSON.stringify({ fileKey: fileKey || null, args });
}

function flagValue(args, flags, options) {
  const names = Array.isArray(flags) ? flags : [flags];
  const matches = optionEntries(options, names);
  if (matches.length > 1) throw new Error(`Duplicate option ${matches[1].name}.`);
  const entry = matches[0];
  if (!entry) return null;
  if (entry.inline) {
    return inlineOptionValue(args[entry.index], entry.name)?.value || null;
  }
  const value = args[entry.index + 1];
  return typeof value === 'string' && value !== '--' ? value : null;
}

/** External outbound access only; authenticated localhost transport is separate. */
function networkEffect(args, capability) {
  if (args[0] === 'map' && args[1] === 'storybook') {
    const [sourceIndex] = positionalIndexes(args, 2, ['-o', '--output']);
    if (isUrl(args[sourceIndex] || '')) return 'read';
  }
  if (args[0] === 'import') {
    const [sourceIndex] = positionalIndexes(args, 1, ['-c', '--collection', '--save']);
    if (isUrl(args[sourceIndex] || '')) return 'read';
  }
  if (args[0] === 'kit' && args[1] === 'init'
    && isUrl(flagValue(args, '--storybook', capability.options) || '')) return 'read';
  if ((args[0] === 'render' || args[0] === 'render-batch')
    && acceptsSemanticRenderArgv(args)
    && semanticRenderAssetIntentFromArgv(args).remoteCount > 0) return 'read';
  return 'none';
}

/** @param {readonly any[]} artifactOutputs */
function sharedEffect(args, artifactOutputs, capability) {
  if (artifactOutputs.some((output) => output.scope === 'private-temporary')) return 'write';
  if (args[0] === 'api') {
    if (args[1] === 'setup' || args[1] === 'index') return 'write';
    return 'read';
  }
  if (args[0] === 'history') {
    if (args[1] === 'snapshot') return hasOption(capability.options, '--json') ? 'none' : 'write';
    if (args[1] === 'list' || args[1] === 'diff') return 'read';
  }
  return 'none';
}

function editorEffect(args, capability) {
  if (!capability.available || capability.help || capability.target === 'none') return 'none';
  const { actionId } = capability;
  if (actionId === 'canvas.page-create') {
    return hasOption(capability.options, '--no-switch') ? 'none' : 'write';
  }
  if (actionId === 'combos') {
    if (!hasOption(capability.options, '--dry-run')) return 'write';
    const [nodeIndex] = positionalIndexes(args, 1, ['-g', '--gap']);
    return nodeIndex === undefined ? 'read' : 'none';
  }
  if (actionId?.startsWith('create.')) return 'write';
  if (EDITOR_CONTEXT_WRITE_ACTIONS.has(actionId)) return 'write';
  if (actionId === 'extract' && hasOption(capability.options, '--selection')) return 'read';
  if (actionId === 'verify' && !parseScreenshotRequest(args).nodeId) return 'read';
  if (actionId === 'export.code-spec' && !parseCodeSpecRequest(args).nodeId) return 'read';
  if (actionId === 'node.bindings' && !parseNodeBindingsRequest(args).nodeId) return 'read';
  if (actionId === 'component.prop.list'
    && !parseComponentPropertyListRequest(args).componentId) return 'read';
  if (actionId === 'grid.list' && !parseLayoutGridFactsRequest(args).nodeId) return 'read';
  if (actionId === 'link.inspect'
    && !parseDesignLinkRequest(args, { requireManifest: false }).nodeId) return 'read';
  if (actionId === 'gradient.extract'
    && String(flagValue(args, '--apply-to', capability.options)).toLowerCase() === 'selected') {
    return 'read';
  }
  if (actionId === 'pin'
    && !hasOption(capability.options, '--node')
    && !hasOption(capability.options, '--query')) return 'read';
  if (EDITOR_CONTEXT_READ_ACTIONS.has(actionId)) return 'read';
  return 'none';
}

function availabilityFor(args, capability) {
  if (!capability.available) return { transport: 'none', editor: 'either', feature: null };
  if (capability.target === 'none') {
    return {
      transport: 'none',
      editor: 'either',
      feature: args[0] === 'api' ? 'offline-docs' : null,
    };
  }
  return {
    transport: 'plugin',
    editor: args[0] === 'jam' ? 'figjam'
      : args[0] === 'slides' ? 'slides'
        : args[0] === 'measure' ? 'dev'
          : 'figma',
    feature: args[0] === 'motion' ? 'motion-beta'
      : args[0] === 'slides' ? 'slides-beta'
        : args[0] === 'map' ? 'storybook'
          : args[0] === 'link' ? 'design-links'
            : args[0] === 'contract' ? 'design-contracts' : null,
  };
}

/**
 * Resolve one Figma Command completely for an Adapter.
 *
 * This is the primary Interface: policy callers receive decisions, never the
 * catalog's matcher rules. Relative paths are anchored to workspaceDir.
 */
export function planFigmaCommand(rawArgs, {
  adapter = 'mcp',
  workspaceDir = process.cwd(),
  fileKey = null,
  registryFileKey = null,
  workspaceIO = null,
  verificationArtifactNonce = undefined,
  temporaryArtifactRoot = undefined,
} = {}) {
  const input = Array.isArray(rawArgs) ? rawArgs : [];
  const hasExplicitFileKey = fileKey !== null
    && fileKey !== undefined
    && String(fileKey).trim().length > 0;
  const prepared = prepareCommandArgs(input, workspaceDir, {
    projectUrlTarget: !hasExplicitFileKey,
    verificationArtifactNonce,
    temporaryArtifactRoot,
  });
  const argv = Object.freeze(prepared.args);
  const capability = prepared.capability;
  if (workspaceIO) {
    for (const intent of prepared.paths) {
      workspaceIO.authorizePath(intent.path, {
        access: intent.access,
        role: intent.role,
        kind: intent.kind,
      });
    }
  }
  const effects = Object.freeze({
    figma: capability.mutatesDesign ? 'write' : capability.target === 'none' ? 'none' : 'read',
    editor: editorEffect(prepared.args, capability),
    workspace: capability.help ? 'none' : prepared.workspace,
    network: capability.help ? 'none' : networkEffect(prepared.args, capability),
    shared: capability.help ? 'none'
      : sharedEffect(prepared.args, prepared.artifactOutputs, capability),
  });
  const target = capability.target === 'none'
    ? Object.freeze({ kind: 'none', fileKey: null, source: 'not-applicable' })
    : resolveFigmaTarget({
      explicitFileKey: fileKey,
      args: argv,
      figmaUrlFileKey: prepared.figmaUrlFileKey,
      registryFileKey: capability.available ? registryFileKey : null,
    });
  const outputs = Object.freeze([
    ...(prepared.outputPath
      ? [Object.freeze({
        role: prepared.outputRole || capability.pathPolicy,
        path: prepared.outputPath,
      })]
      : []),
    ...prepared.artifactOutputs,
  ]);
  const operation = Object.values(effects).includes('write')
    ? 'write'
    : Object.values(effects).includes('read')
      ? 'read'
      : 'none';
  const jobKey = backgroundJobIdentity(argv, target.fileKey);
  const retry = capability.mutatesDesign || effects.editor === 'write' ? 'never' : capability.retry;
  const plan = {
    id: capability.actionId || 'unknown',
    adapter,
    allowed: capability.available
      && (adapter === 'mcp' || (adapter === 'cli' && CLI_COMMAND_APPLICATIONS.has(capability.actionId))),
    argv,
    target,
    effects,
    confirmation: capability.mutatesDesign ? 'configured' : 'none',
    mutationPolicy: capability.actionId === 'var.set-value-batch'
      ? Object.freeze({ rollback: VARIABLE_SET_VALUE_BATCH_ROLLBACK_POLICY })
      : null,
    execution: Object.freeze({
      mode: capability.execution === 'background' ? 'tracked-job' : 'foreground',
      timeout: capability.timeoutClass,
      retry,
      pluginDispatch: ['style.consumers', 'node.bindings', 'tokens.overlap'].includes(capability.actionId)
        ? 'typed-read'
        : effects.figma === 'none' ? 'none' : 'serialized',
      idempotence: jobKey ? 'deduped' : retry === 'safe-read' ? 'read-only' : 'unknown',
      okExitCodes: Object.freeze(acceptedExitCodes(prepared.args)),
      jobKey,
    }),
    availability: Object.freeze(availabilityFor(prepared.args, capability)),
    outputs,
    // Closed semantic projection for the Audit Trail. It deliberately omits
    // argv, file keys, paths, labels, and payloads; the writer stores only
    // non-reversible summaries for those values.
    audit: Object.freeze({
      capability: capability.actionId || 'unknown',
      operation,
      effects,
      targetKind: target.kind,
      outputRoles: Object.freeze([...new Set(outputs.map(({ role }) => role))]),
      ...(prepared.args[0] === 'api'
        ? { materialVersion: FIGMA_TYPINGS_MATERIAL_VERSION }
        : {}),
    }),
    summary: capability.summary,
  };
  const frozen = Object.freeze(plan);
  COMMAND_PLANS.add(frozen);
  return frozen;
}

/** Only plans created by this Module may cross the execution seam. */
export function isFigmaCommandPlan(value) {
  return value !== null && typeof value === 'object' && COMMAND_PLANS.has(value);
}

/** Secondary Interface for help, exposure and generated contract tests. */
export function listFigmaCapabilities({ adapter = 'mcp', formatted = false } = {}) {
  if (formatted) return commandHelpIndex();
  if (adapter !== 'mcp') return Object.freeze([]);
  return Object.freeze(
    [...allowedCommandNames()]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => Object.freeze({ name, summary: COMMANDS[name].summary })),
  );
}
