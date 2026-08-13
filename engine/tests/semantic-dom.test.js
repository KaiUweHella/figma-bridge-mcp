import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_STYLE_PROPERTIES,
  SVG_PRESENTATION_PROPERTIES,
  browserDomCaptureScript,
  setSvgOpeningAttribute,
} from '../src/lib/browser-dom-capture.js';
import { domCaptureToSemanticModel, resolveGlyphIcon } from '../src/lib/semantic-dom-model.js';
import { domCaptureToJsx, domCaptureToRenderPlan } from '../src/lib/dom-capture-to-jsx.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

const baseStyle = (overrides = {}) => ({
  display: 'block', position: 'static', overflow: 'visible', opacity: '1',
  width: 'auto', height: 'auto', minWidth: '0px', minHeight: '0px',
  maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
  flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'normal', alignItems: 'normal',
  alignSelf: 'auto', gap: 'normal', rowGap: 'normal', columnGap: 'normal',
  flexGrow: '0', flexShrink: '1', flexBasis: 'auto', order: '0',
  gridTemplateRows: 'none', gridTemplateColumns: 'none', gridAutoFlow: 'row',
  gridRowStart: 'auto', gridRowEnd: 'auto', gridColumnStart: 'auto', gridColumnEnd: 'auto',
  backgroundColor: 'rgba(0, 0, 0, 0)', color: 'rgb(25, 26, 31)',
  borderTop: '0px none rgb(0, 0, 0)', borderRight: '0px none rgb(0, 0, 0)',
  borderBottom: '0px none rgb(0, 0, 0)', borderLeft: '0px none rgb(0, 0, 0)',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
  boxShadow: 'none', backdropFilter: 'none', mixBlendMode: 'normal',
  fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', fontStyle: 'normal',
  lineHeight: 'normal', letterSpacing: 'normal', textAlign: 'start', textTransform: 'none',
  ...overrides,
});

const node = ({ tag = 'div', classes = '', rect, style, authoredStyle = {}, texts = [], children = [], ...rest }) => ({
  tag, classes, rect, style: baseStyle(style), authoredStyle, texts, children,
  before: null, after: null, ...rest,
});

const semanticCapture = {
  version: 2,
  root: node({
    tag: 'main', classes: 'screen', rect: { x: 0, y: 0, w: 1440, h: 1000 },
    style: {
      display: 'grid', gridTemplateColumns: '236px 1204px', gridTemplateRows: '1000px',
      backgroundColor: 'rgb(245, 245, 241)',
    },
    authoredStyle: { gridTemplateColumns: '236px 1fr', backgroundColor: 'var(--surface)' },
    customProperties: { '--surface': '#f5f5f1' },
    children: [
      node({
        tag: 'aside', classes: 'sidebar', rect: { x: 0, y: 0, w: 236, h: 1000 },
        style: { display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '26px', paddingRight: '18px', paddingBottom: '20px', paddingLeft: '18px' },
        children: [
          node({ tag: 'span', classes: 'label', rect: { x: 18, y: 26, w: 80, h: 20 }, texts: [{ text: 'Northern', rect: { x: 18, y: 26, w: 80, h: 20 }, style: baseStyle() }] }),
        ],
      }),
      node({
        tag: 'section', classes: 'workspace', rect: { x: 236, y: 0, w: 1204, h: 1000 },
        style: { display: 'flex', flexDirection: 'column' },
        children: [
          node({
            tag: 'span', classes: 'icon', rect: { x: 260, y: 20, w: 17, h: 17 },
            iconRole: { name: 'team', source: 'glyph' },
            texts: [{ text: '♙', rect: { x: 260, y: 20, w: 17, h: 17 }, style: baseStyle() }],
          }),
          node({
            tag: 'span', classes: 'orb', rect: { x: 1200, y: 20, w: 100, h: 100 },
            style: { position: 'absolute', backgroundColor: 'rgb(201, 255, 88)' },
          }),
        ],
      }),
    ],
  }),
};

describe('semantic browser capture contract', () => {
  it('captures the layout and provenance facts required for native Figma structure', () => {
    for (const property of [
      'flexDirection', 'justifyContent', 'alignItems', 'gap', 'paddingTop',
      'gridTemplateColumns', 'gridRowStart', 'justifyItems', 'placeItems', 'alignSelf', 'justifySelf', 'flexGrow', 'order', 'zIndex',
    ]) assert.ok(CAPTURE_STYLE_PROPERTIES.includes(property), property);

    const script = browserDomCaptureScript('.screen');
    assert.match(script, /getComputedStyle/);
    assert.match(script, /gridTemplateColumns/);
    assert.match(script, /authoredStyle/);
    assert.match(script, /customProperties/);
    assert.match(script, /iconRole/);
    assert.match(script, /contentOrder/);
    assert.match(script, /element\.outerHTML/);
    assert.match(script, /getComputedStyle\(source\)/);
    assert.match(script, /svgMarkup\(element\)/);
    assert.match(script, /figma-filter-/);
    for (const property of [
      'fill', 'fillOpacity', 'stopColor', 'stopOpacity',
      'stroke', 'strokeWidth', 'strokeDasharray', 'filter', 'opacity',
    ]) {
      assert.ok(SVG_PRESENTATION_PROPERTIES.includes(property), property);
    }
  });

  it('updates exact SVG presentation attributes without colliding with prefixed names', () => {
    const opening = '<stop offset="100%" stop-color="currentColor" stop-opacity="0" opacity="0.5"';
    const withOpacity = setSvgOpeningAttribute(opening, 'opacity', '1');
    assert.match(withOpacity, /stop-opacity="0"/);
    assert.match(withOpacity, /opacity="1"/);

    const withStopOpacity = setSvgOpeningAttribute(withOpacity, 'stop-opacity', '0');
    assert.match(withStopOpacity, /stop-opacity="0"/);
    assert.equal((withStopOpacity.match(/stop-opacity=/g) || []).length, 1);
  });

  it('normalizes flow, grid, overlay, token and unresolved-icon intent', () => {
    const model = domCaptureToSemanticModel(semanticCapture);
    assert.equal(model.root.layout.kind, 'grid');
    assert.deepEqual(model.root.layout.columns.map((track) => track.kind), ['fixed', 'flex']);
    assert.equal(model.root.paint.background.token, 'surface');
    assert.equal(model.root.children[0].layout.kind, 'flex');
    assert.equal(model.root.children[0].layout.direction, 'column');
    assert.deepEqual(model.root.children[0].layout.padding, [26, 18, 20, 18]);
    assert.equal(model.root.children[1].children[1].positioning.kind, 'absolute');
    assert.deepEqual(model.diagnostics.unresolvedIcons, []);
    assert.deepEqual(model.root.children[1].children[0].asset, { kind: 'builtin-icon', name: 'users' });
    assert.equal(model.diagnostics.unclassifiedFallbacks.length, 0);
    assert.deepEqual(model.diagnostics.layouts, { grid: 1, flex: 2, flow: 2, leaf: 1 });
    assert.equal(model.diagnostics.absoluteNodes, 1);
    assert.equal(model.diagnostics.tokenReferences, 1);
  });

  it('resolves an explicitly instrumented code component through a Design Entity link', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.children[0].sourceIdentity = {
      entity: null,
      component: 'ui.sidebar',
      exportName: 'Sidebar',
    };
    const model = domCaptureToSemanticModel(capture, {
      resolveComponent: (id) => id === 'ui.sidebar'
        ? { entityId: id, key: 'published-component-key', variant: 'State=Default' }
        : null,
    });

    assert.deepEqual(model.root.children[0].component, {
      entityId: 'ui.sidebar', key: 'published-component-key', variant: 'State=Default',
    });
    assert.deepEqual(model.diagnostics.unresolvedComponents, []);

    const { renderPlan } = domCaptureToRenderPlan(capture, {
      componentLinks: {
        'ui.sidebar': { entityId: 'ui.sidebar', key: 'published-component-key', variant: 'State=Default' },
      },
    });
    assert.equal(renderPlan.root.children[0].source.type, 'instance');
    assert.equal(renderPlan.root.children[0].source.props.entity, 'ui.sidebar');
    assert.equal(renderPlan.root.children[0].source.props.key, 'published-component-key');
  });

  it('stops instead of guessing when an instrumented component has no Registry link', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.children[0].sourceIdentity = { component: 'ui.sidebar' };
    const model = domCaptureToSemanticModel(capture);

    assert.deepEqual(model.diagnostics.unresolvedComponents, [{
      entityId: 'ui.sidebar', path: 'screen/sidebar',
    }]);
    assert.match(model.diagnostics.unclassifiedFallbacks[0].fact, /Design Entity ui\.sidebar/);
  });

  it('emits Grid/Auto Layout JSX and keeps only true overlays absolute', () => {
    const { jsx, diagnostics } = domCaptureToJsx(semanticCapture);
    assert.match(jsx, /name="screen"[^>]+flex="grid"/);
    assert.match(jsx, /gridColumns="fixed:236,flex"/);
    assert.match(jsx, /name="sidebar"[^>]+flex="col"[^>]+pt="26"[^>]+pr="18"[^>]+pb="20"[^>]+pl="18"/);
    assert.match(jsx, /name="workspace"[^>]+flex="col"/);
    assert.doesNotMatch(jsx, /name="sidebar"[^>]+position="absolute"/);
    assert.match(jsx, /name="orb"[^>]+position="absolute"/);
    assert.match(jsx, /bg="var:surface\|#f5f5f1"/);
    assert.match(jsx, /<Icon name="users" color="#191a1f"/);
    assert.doesNotMatch(jsx, />♙<\/Text>/);
    assert.equal(diagnostics.semantic.unresolvedIcons.length, 0);
  });

  it('directly plans semantic Grid/Flex capture with byte-identical execution', async () => {
    const legacy = domCaptureToJsx(semanticCapture);
    const direct = domCaptureToRenderPlan(semanticCapture);
    const legacyClient = new FigmaClient();
    legacyClient.setIcons(legacy.icons);
    const legacyCode = await legacyClient.parseJSX(legacy.jsx);

    const directClient = new FigmaClient();
    directClient.setIcons(direct.icons);
    directClient.parseJSXTree = () => { throw new Error('semantic DOM adapter must not parse JSX'); };
    const directCode = await directClient.compileRenderPlan(direct.renderPlan);

    assert.equal(directCode, legacyCode);
    assert.equal(direct.renderPlan.adapter, 'dom-capture');
    assert.equal(direct.renderPlan.root.layout.kind, 'grid');
    assert.equal(direct.renderPlan.diagnostics.tokenReferences, 1);
    assert.deepEqual(direct.renderPlan.root.paint.background, { value: '#f5f5f1', token: 'surface' });
  });

  it('omits absent DOM properties from the direct executable plan', () => {
    const { renderPlan } = domCaptureToRenderPlan(semanticCapture);
    const findIcon = (entry) => entry.source.type === 'icon'
      ? entry
      : entry.children.map(findIcon).find(Boolean);
    const icon = findIcon(renderPlan.root);

    assert.equal(icon.source.type, 'icon');
    assert.equal(Object.hasOwn(icon.source.props, 'grow'), false);
    assert.equal(Object.values(icon.source.props).includes(undefined), false);
  });

  it('makes filled CSS spread-shadow frames compatible with native Figma effects', () => {
    const capture = structuredClone(semanticCapture);
    const orb = capture.root.children[1].children[1];
    orb.style.boxShadow = 'rgb(225, 239, 193) 0px 0px 0px 3px';

    const { renderPlan } = domCaptureToRenderPlan(capture);
    const plannedOrb = renderPlan.root.children[1].children.find((child) => child.source.props.name === 'orb');

    assert.equal(plannedOrb.source.props.bg, '#c9ff58');
    assert.equal(plannedOrb.source.props.shadow, '0 0 0 3 #e1efc1');
    assert.equal(plannedOrb.source.props.clip, 'true');
  });

  it('expresses fractional measured radii as exact Figma-safe scoped variable intent', () => {
    const capture = structuredClone(semanticCapture);
    const orb = capture.root.children[1].children[1];
    orb.rect = { ...orb.rect, w: 7, h: 7 };
    orb.style.borderTopLeftRadius = '50%';
    orb.style.borderTopRightRadius = '50%';
    orb.style.borderBottomRightRadius = '50%';
    orb.style.borderBottomLeftRadius = '50%';

    const { renderPlan } = domCaptureToRenderPlan(capture);
    const plannedOrb = renderPlan.root.children[1].children.find((child) => child.source.props.name === 'orb');

    assert.equal(plannedOrb.source.props.rounded, 'var:radius/3-5px|3.5');
  });

  it('keeps CSS column-flow provenance while explicit native Grid cells need no flow instruction', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.style.gridAutoFlow = 'column';

    const { renderPlan, semanticModel } = domCaptureToRenderPlan(capture);

    assert.equal(semanticModel.root.layout.autoFlow, 'column');
    assert.equal(Object.hasOwn(renderPlan.root.source.props, 'gridAutoFlow'), false);
    for (const child of renderPlan.root.children) {
      assert.equal(Number.isInteger(child.source.props.gridRow), true);
      assert.equal(Number.isInteger(child.source.props.gridColumn), true);
    }
  });

  it('retains weighted minmax fractions and reports the unenforced minimum', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.authoredStyle.gridTemplateColumns = 'minmax(0px, 1.3fr) minmax(330px, 0.7fr)';
    capture.root.style.gridTemplateColumns = '780px 424px';
    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.root.layout.columns.map((item) => item.value), [1.3, 0.7]);
    assert.equal(model.root.layout.columns[1].minimum, 330);
    assert.equal(model.diagnostics.classifiedFallbacks[1].fallback, 'minmax.native-grid');
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /gridColumns="flex:1.3,flex:0.7"/);
  });

  it('keeps an unknown glyph role unresolved instead of guessing', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.children[1].children[0].iconRole = { name: 'mystery', source: 'glyph', glyph: '⌘' };
    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.diagnostics.unresolvedIcons, [
      { name: 'mystery', source: 'glyph', path: 'screen/workspace/icon' },
    ]);
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /<Icon name="unresolved-mystery"/);
  });

  it('resolves an unknown glyph role from a project SVG basename', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.children[1].children[0].iconRole = { name: 'CommandMark', source: 'glyph', glyph: '⌘' };
    const projectIcons = { commandmark: '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>' };
    const { jsx, semanticModel } = domCaptureToJsx(capture, { projectIcons });

    assert.deepEqual(semanticModel.diagnostics.unresolvedIcons, []);
    assert.deepEqual(semanticModel.root.children[1].children[0].asset, { kind: 'project-icon', name: 'commandmark' });
    assert.match(jsx, /<Icon name="commandmark"/);
    assert.doesNotMatch(jsx, /unresolved-CommandMark/);
  });

  it('maps every observed regression fixture glyph role to vector geometry', () => {
    const observed = [
      ['overview', '⌂', 'home'], ['projects', '◇', 'folder'], ['inbox', '↗', 'arrow-up-right'],
      ['team', '♙', 'users'], ['automations', '⌁', 'zap'], ['settings', '⚙', 'settings'],
      ['button', '⌕', 'search'], ['lime', '↗', 'arrow-up-right'],
      ['violet', '◎', 'target'], ['blue', '◌', 'circle'],
    ];
    for (const [name, glyph, expected] of observed) {
      assert.equal(resolveGlyphIcon({ name, glyph, source: 'glyph' }), expected, name);
    }
  });

  it('resolves CSS negative grid lines and auto-places following children', () => {
    const capture = structuredClone(semanticCapture);
    capture.root.children[0].style.gridColumnStart = '1';
    capture.root.children[0].style.gridColumnEnd = '-1';
    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.root.children[0].gridCell, {
      column: 1, columnSpan: 2, row: 1, rowSpan: 1,
    });
    assert.deepEqual(model.root.children[1].gridCell, {
      row: 2, column: 1, rowSpan: 1, columnSpan: 1,
    });
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="sidebar"[^>]+gridRow="1"[^>]+gridColumn="1"[^>]+gridColumnSpan="2"/);
    assert.match(jsx, /name="workspace"[^>]+gridRow="2"[^>]+gridColumn="1"/);
  });

  it('uses measured cells for mixed anonymous text and element Grid items', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'metadata', rect: { x: 0, y: 0, w: 92, h: 34 },
        style: {
          display: 'grid', gridTemplateColumns: '12px 75px', gridTemplateRows: '12px 17px',
          columnGap: '5px', rowGap: '5px',
        },
        authoredStyle: { gridTemplateColumns: 'auto 1fr', gridTemplateRows: '12px 17px' },
        texts: [{ text: 'Design handoff', rect: { x: 17, y: 0, w: 75, h: 12 }, style: baseStyle({ fontSize: '9px' }) }],
        children: [
          node({ classes: 'signal', rect: { x: 0, y: 0, w: 7, h: 7 } }),
          node({ classes: 'strong', rect: { x: 17, y: 17, w: 31, h: 17 }, texts: [{ text: '312', rect: { x: 17, y: 17, w: 31, h: 17 }, style: baseStyle() }] }),
        ],
      }),
    };

    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.root.children[0].gridCell, { row: 1, column: 1, rowSpan: 1, columnSpan: 1 });
    assert.deepEqual(model.root.children[1].gridCell, { row: 2, column: 2, rowSpan: 1, columnSpan: 1 });
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /Design handoff<\/Text>/);
    assert.match(jsx, /name="signal"[^>]+w="7"[^>]+h="7"[^>]+gridRow="1"[^>]+gridColumn="1"/);
    assert.match(jsx, /name="strong"[^>]+w="31"[^>]+h="fill"[^>]+gridRow="2"[^>]+gridColumn="2"/);
  });

  it('sizes mapped SVG geometry from the glyph box rather than its button', () => {
    const capture = {
      version: 2,
      root: node({
        tag: 'button', classes: 'icon-button', rect: { x: 100, y: 50, w: 42, h: 42 },
        iconRole: { name: 'search', source: 'glyph', glyph: '⌕' },
        texts: [{
          text: '⌕', rect: { x: 114.976, y: 58, w: 12.046, h: 26 },
          style: baseStyle({ fontSize: '20px' }),
        }],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /<Icon name="search"[^>]+position="absolute"[^>]+x="10\.999"[^>]+y="11"[^>]+w="20"[^>]+h="20"/);
  });

  it('collapses a centered one-cell text Grid to centered vertical Auto Layout', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'avatar violet', rect: { x: 292, y: 702, w: 38, h: 38 },
        style: {
          display: 'grid', gridTemplateColumns: '38px', gridTemplateRows: '38px',
          alignItems: 'center', justifyItems: 'center', placeItems: 'center',
        },
        authoredStyle: { display: 'grid' },
        texts: [{ text: 'MK', rect: { x: 302.5, y: 713.75, w: 17, h: 14.5 }, style: baseStyle() }],
      }),
    };

    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.root.layout, {
      kind: 'flex', direction: 'column', wrap: false, gap: 0, rowGap: 0, columnGap: 0,
      justify: 'center', items: 'center', padding: [0, 0, 0, 0], source: 'trivial-centered-grid',
    });
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="avatar\.violet"[^>]+flex="col"[^>]+justify="center"[^>]+items="center"/);
    assert.match(jsx, /<Text[^>]+w="hug"[^>]*>MK<\/Text>/);
    assert.doesNotMatch(jsx, /name="avatar\.violet"[^>]+flex="grid"/);
  });

  it('uses fill plus centered text when centered trivial Grid content occupies the track', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'centered-label', rect: { x: 0, y: 0, w: 100, h: 38 },
        style: {
          display: 'grid', gridTemplateColumns: '100px', gridTemplateRows: '38px',
          alignItems: 'center', justifyItems: 'center', placeItems: 'center',
        },
        texts: [{ text: 'A label that fills', rect: { x: 0, y: 11.75, w: 100, h: 14.5 }, style: baseStyle() }],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /<Text[^>]+w="fill"[^>]+align="center"[^>]*>A label that fills<\/Text>/);
  });

  it('collapses a centered one-cell Grid with one SVG element to centered Auto Layout', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'metric-icon lime', rect: { x: 100, y: 40, w: 37, h: 37 },
        style: {
          display: 'grid', gridTemplateColumns: '37px', gridTemplateRows: '37px',
          alignItems: 'center', justifyItems: 'center', placeItems: 'center',
        },
        children: [node({
          tag: 'svg', rect: { x: 109.5, y: 49.5, w: 18, h: 18 },
          svg: '<svg viewBox="0 0 18 18"><path d="M1 9h16"/></svg>',
        })],
      }),
    };

    const model = domCaptureToSemanticModel(capture);
    assert.equal(model.root.layout.source, 'trivial-centered-grid');
    assert.equal(model.root.layout.kind, 'flex');
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="metric-icon\.lime"[^>]+flex="col"[^>]+justify="center"[^>]+items="center"/);
    assert.match(jsx, /<Icon name="dom-svg-1" preserveColors="true" w="18" h="18"/);
    assert.doesNotMatch(jsx, /<Icon name="dom-svg-1"[^>]+position="absolute"/);
  });

  it('inherits Grid item alignment and lets align-self and justify-self override it', async () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'delivery-row', rect: { x: 0, y: 0, w: 339, h: 56 },
        style: {
          display: 'grid', gridTemplateColumns: '28px 110px 72px 54px 35px',
          gridTemplateRows: '56px', alignItems: 'center', justifyItems: 'start', columnGap: '10px',
        },
        children: [
          node({ classes: 'delivery-icon', rect: { x: 0, y: 15.5, w: 25, h: 25 } }),
          node({ classes: 'override', rect: { x: 38, y: 33, w: 40, h: 13 }, style: { alignSelf: 'end', justifySelf: 'end' } }),
        ],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="delivery-icon"[^>]+gridHAlign="min"[^>]+gridVAlign="center"/);
    assert.match(jsx, /name="override"[^>]+gridHAlign="max"[^>]+gridVAlign="max"/);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /gridChildHorizontalAlign = 'MIN'/);
    assert.match(code, /gridChildVerticalAlign = 'CENTER'/);
    assert.match(code, /gridChildHorizontalAlign = 'MAX'/);
    assert.match(code, /gridChildVerticalAlign = 'MAX'/);
  });

  it('keeps auto-width block children responsive on the cross axis of vertical flow', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'workspace', rect: { x: 0, y: 0, w: 400, h: 300 },
        children: [
          node({ classes: 'topbar', rect: { x: 0, y: 0, w: 400, h: 80 }, style: { display: 'flex' } }),
          node({ classes: 'fixed-card', rect: { x: 0, y: 100, w: 220, h: 80 }, authoredStyle: { width: '220px' } }),
        ],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="topbar"[^>]+w="fill"/);
    assert.match(jsx, /name="fixed-card"[^>]+w="220"/);
    assert.doesNotMatch(jsx, /name="fixed-card"[^>]+w="fill"/);
  });

  it('does not force fill against explicit non-stretch Flex alignment', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'centered-column', rect: { x: 0, y: 0, w: 400, h: 300 },
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
        children: [node({ classes: 'card', rect: { x: 0, y: 0, w: 400, h: 80 } })],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="card"[^>]+w="400"/);
    assert.doesNotMatch(jsx, /name="card"[^>]+w="fill"/);
  });

  it('preserves native single-line button centering as vertical Auto Layout', async () => {
    const capture = {
      version: 2,
      root: node({
        tag: 'button', classes: 'button primary', rect: { x: 1087.945, y: 26.5, w: 143.055, h: 42 },
        style: {
          display: 'block', textAlign: 'center',
          paddingTop: '0px', paddingRight: '17px', paddingBottom: '0px', paddingLeft: '17px',
        },
        texts: [{
          text: '＋ Invite member', rect: { x: 1104.945, y: 39.25, w: 109.055, h: 17 },
          style: baseStyle({ fontFamily: 'DM Sans', fontSize: '13px', fontWeight: '700', textAlign: 'center' }),
        }],
      }),
    };

    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.root.layout, {
      kind: 'flex', direction: 'column', wrap: false, gap: 0, rowGap: 0, columnGap: 0,
      justify: 'center', items: 'center', padding: [0, 17, 0, 17], source: 'single-centered-text-control',
    });
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="button\.primary"[^>]+flex="col"[^>]+justify="center"[^>]+items="center"/);
    assert.match(jsx, /<Text[^>]+w="fill"[^>]+align="center"[^>]*>＋ Invite member<\/Text>/);

    const figmaCode = await new FigmaClient().parseJSX(jsx);
    assert.match(figmaCode, /primaryAxisAlignItems = 'CENTER'/);
    assert.match(figmaCode, /counterAxisAlignItems = 'CENTER'/);
    assert.match(figmaCode, /layoutSizingHorizontal = 'FILL';[^]*textAutoResize = 'HEIGHT'/);
  });

  it('does not reinterpret ordinary centered block text as a control', () => {
    const capture = {
      version: 2,
      root: node({
        tag: 'div', classes: 'centered-copy', rect: { x: 0, y: 0, w: 143, h: 42 },
        style: { display: 'block', textAlign: 'center' },
        texts: [{ text: 'Copy', rect: { x: 54, y: 12, w: 35, h: 17 }, style: baseStyle({ textAlign: 'center' }) }],
      }),
    };

    assert.equal(domCaptureToSemanticModel(capture).root.layout.source, undefined);
  });

  it('maps CSS space-between to Figma automatic gap semantics', () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'toolbar', rect: { x: 0, y: 0, w: 240, h: 40 },
        style: { display: 'flex', flexDirection: 'row', justifyContent: 'space-between', gap: '12px' },
        children: [
          node({ classes: 'left', rect: { x: 0, y: 0, w: 40, h: 40 } }),
          node({ classes: 'right', rect: { x: 200, y: 0, w: 40, h: 40 } }),
        ],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /name="toolbar"[^>]+justify="between"/);
    assert.doesNotMatch(jsx, /name="toolbar"[^>]+gap=/);
  });

  it('compiles CSS space-around to centered equal Grid slots', async () => {
    const capture = {
      version: 2,
      root: node({
        classes: 'toolbar', rect: { x: 0, y: 0, w: 300, h: 42 },
        style: { display: 'flex', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
        contentOrder: [{ kind: 'element', index: 0 }, { kind: 'text', index: 0 }, { kind: 'element', index: 1 }],
        texts: [{ text: 'Middle', rect: { x: 125, y: 12, w: 50, h: 18 }, style: baseStyle() }],
        children: [
          node({ classes: 'first', rect: { x: 25, y: 6, w: 30, h: 30 } }),
          node({ classes: 'last', rect: { x: 245, y: 6, w: 30, h: 30 } }),
        ],
      }),
    };
    const model = domCaptureToSemanticModel(capture);
    assert.equal(model.root.layout.kind, 'grid');
    assert.equal(model.root.layout.source, 'space-around.equal-slots');
    assert.equal(model.root.layout.columns.length, 3);
    assert.equal(model.diagnostics.classifiedFallbacks[0].fallback, 'space-around.equal-slots');
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /flex="grid"[^>]+gridColumns="flex,flex,flex"/);
    assert.match(jsx, /name="first"[^>]+gridHAlign="center"[^>]+gridVAlign="center"[^>]+gridColumn="1"/);
    assert.match(jsx, /Middle<\/Text>/);
    assert.match(jsx, /gridColumn="2"[^>]+gridHAlign="center"[^>]+gridVAlign="center"/);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /gridChildHorizontalAlign = 'CENTER'/);
    assert.match(code, /gridChildVerticalAlign = 'CENTER'/);
  });

  it('keeps sticky in flow and records it as code-only metadata', () => {
    const capture = { version: 2, root: node({ classes: 'sticky', rect: { x: 0, y: 0, w: 100, h: 20 }, style: { position: 'sticky' } }) };
    const model = domCaptureToSemanticModel(capture);
    assert.equal(model.root.positioning.kind, 'flow');
    assert.deepEqual(model.diagnostics.codeOnlyFacts, [{ path: 'sticky', fact: 'position: sticky', strategy: 'sticky.metadata-only' }]);
  });

  it('requires a font decision before exact variable axes are approximated', () => {
    const capture = { version: 2, root: node({
      classes: 'variable-type', rect: { x: 0, y: 0, w: 200, h: 30 },
      style: { fontFamily: 'Roboto Flex', fontVariationSettings: '"wght" 615, "wdth" 92' },
      texts: [{ text: 'Variable', rect: { x: 0, y: 0, w: 80, h: 20 }, style: baseStyle({ fontFamily: 'Roboto Flex', fontVariationSettings: '"wght" 615, "wdth" 92' }) }],
    }) };
    const model = domCaptureToSemanticModel(capture);
    assert.equal(model.diagnostics.classifiedFallbacks[0].fallback, 'font.named-faces');
    assert.equal(model.diagnostics.fontRequirements[0].axes, '"wght" 615, "wdth" 92');
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /fontAxes="&quot;wght&quot; 615, &quot;wdth&quot; 92"/);
  });

  it('classifies only top-level CSS filter functions, not nested rgb()', () => {
    const capture = { version: 2, root: node({
      classes: 'glow', rect: { x: 0, y: 0, w: 80, h: 80 },
      style: { filter: 'blur(3px) drop-shadow(rgb(201, 255, 88) 0px 0px 22px)' },
    }) };
    const model = domCaptureToSemanticModel(capture);
    assert.deepEqual(model.diagnostics.unclassifiedFallbacks, []);
    assert.equal(model.diagnostics.classifiedFallbacks[0].fallback, 'filters.layer-stack');
  });

  it('keeps supported CSS background gradients as semantic paint facts', () => {
    const capture = { version: 2, root: node({
      classes: 'cover', rect: { x: 0, y: 0, w: 300, h: 140 },
      style: {
        backgroundImage: 'linear-gradient(135deg, rgb(30, 36, 32), rgb(52, 69, 41))',
      },
    }) };
    const model = domCaptureToSemanticModel(capture);
    assert.equal(model.root.paint.backgroundImage.value, capture.root.style.backgroundImage);
    assert.equal(model.diagnostics.unclassifiedFallbacks.length, 0);
    const { jsx } = domCaptureToJsx(capture);
    assert.match(jsx, /bg="linear-gradient\(135deg, rgb\(30, 36, 32\), rgb\(52, 69, 41\)\)"/);
  });

  it('stops unsupported CSS background images instead of dropping them silently', () => {
    const capture = { version: 2, root: node({
      classes: 'cover', rect: { x: 0, y: 0, w: 300, h: 140 },
      style: { backgroundImage: 'url("texture.png")' },
    }) };
    const model = domCaptureToSemanticModel(capture);
    assert.match(model.diagnostics.unclassifiedFallbacks[0].fact, /background-image/);
  });

  it('keeps direct text and element children in visual source order for a flex row', () => {
    const capture = {
      version: 2,
      root: node({
        tag: 'a', classes: 'nav-item', rect: { x: 18, y: 86, w: 199, h: 42 },
        style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '11px' },
        texts: [{ text: 'Overview', rect: { x: 58, y: 98.5, w: 58, h: 17 }, style: baseStyle() }],
        children: [node({ tag: 'span', classes: 'icon', rect: { x: 30, y: 96.5, w: 17, h: 21 } })],
      }),
    };

    const { jsx } = domCaptureToJsx(capture);
    assert.ok(jsx.indexOf('name="icon"') < jsx.indexOf('>Overview</Text>'), jsx);
  });

  it('coalesces adjacent direct DOM text nodes into one Figma text layer', () => {
    const capture = structuredClone(semanticCapture);
    const label = capture.root.children[0].children[0];
    label.texts = [
      { text: '82', rect: { x: 18, y: 26, w: 23, h: 20 }, style: baseStyle({ fontSize: '19px' }) },
      { text: '%', rect: { x: 41, y: 26, w: 17, h: 20 }, style: baseStyle({ fontSize: '19px' }) },
    ];
    label.contentOrder = [{ kind: 'text', index: 0 }, { kind: 'text', index: 1 }];

    const { renderPlan } = domCaptureToRenderPlan(capture);
    const labelPlan = renderPlan.root.children[0].children[0];

    assert.equal(labelPlan.children.length, 1);
    assert.equal(labelPlan.children[0].source.props.content, '82%');
  });

  it('maps a main-axis CSS auto margin to a growing native Auto Layout spacer', () => {
    const capture = structuredClone(semanticCapture);
    const sidebar = capture.root.children[0];
    sidebar.children.push(node({
      tag: 'div', classes: 'trial', rect: { x: 18, y: 840, w: 199, h: 120 },
      style: { marginTop: '740px', backgroundColor: 'rgb(32, 33, 39)' },
      authoredStyle: { marginTop: 'auto' },
    }));

    const { renderPlan } = domCaptureToRenderPlan(capture);
    const spacer = renderPlan.root.children[0].children[1];

    assert.equal(spacer.source.props.name, 'css-margin-top.auto');
    assert.equal(spacer.source.props.grow, 1);
    assert.equal(spacer.source.props.w, 'fill');
    assert.equal(spacer.source.props.h, 1);
    assert.equal(spacer.layout.kind, 'flex');
    assert.equal(renderPlan.root.children[0].children[2].source.props.name, 'trial');
  });

  it('preserves measured block-flow margins as fixed native Auto Layout spacers', () => {
    const capture = structuredClone(semanticCapture);
    const label = capture.root.children[0].children[0];
    label.rect = { x: 18, y: 26, w: 100, h: 80 };
    label.texts = [];
    label.contentOrder = [{ kind: 'element', index: 0 }, { kind: 'element', index: 1 }];
    label.children = [
      node({ tag: 'span', classes: 'first', rect: { x: 18, y: 26, w: 80, h: 20 }, texts: [{ text: 'First', rect: { x: 18, y: 26, w: 40, h: 20 }, style: baseStyle() }] }),
      node({ tag: 'span', classes: 'second', rect: { x: 18, y: 60, w: 80, h: 20 }, texts: [{ text: 'Second', rect: { x: 18, y: 60, w: 50, h: 20 }, style: baseStyle() }] }),
    ];

    const { renderPlan } = domCaptureToRenderPlan(capture);
    const flow = renderPlan.root.children[0].children[0];
    const spacer = flow.children[1];

    assert.equal(spacer.source.props.name, 'css-flow-gap.1');
    assert.equal(spacer.source.props.w, 'fill');
    assert.equal(spacer.source.props.h, 14);
    assert.equal(spacer.layout.kind, 'flex');
  });

  it('does not duplicate the leading free space of a centered Flex column', () => {
    const capture = {
      version: 2,
      root: node({
        tag: 'section', classes: 'centered-copy', rect: { x: 0, y: 0, w: 200, h: 200 },
        style: {
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          paddingTop: '20px', paddingRight: '20px', paddingBottom: '20px', paddingLeft: '20px',
        },
        children: [
          node({ tag: 'span', classes: 'first', rect: { x: 20, y: 60, w: 160, h: 20 } }),
          node({ tag: 'span', classes: 'second', rect: { x: 20, y: 90, w: 160, h: 20 } }),
        ],
      }),
    };

    const { renderPlan } = domCaptureToRenderPlan(capture);
    assert.deepEqual(
      renderPlan.root.children.map((child) => child.source.props.name),
      ['first', 'css-flow-gap.1', 'second'],
    );
    assert.equal(renderPlan.root.source.props.justify, 'center');
  });
});
