import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { domCaptureToJsx, domCaptureToRenderPlan } from '../src/lib/dom-capture-to-jsx.js';
import { FigmaClient } from '../src/lib/jsx-render.js';

const style = (overrides = {}) => ({
  display: 'block', position: 'static', overflow: 'visible', opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTop: '0px none rgb(0, 0, 0)', borderRight: '0px none rgb(0, 0, 0)',
  borderBottom: '0px none rgb(0, 0, 0)', borderLeft: '0px none rgb(0, 0, 0)',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
  boxShadow: 'none', backdropFilter: 'none', mixBlendMode: 'normal',
  color: 'rgb(25, 26, 31)', fontFamily: '"DM Sans", sans-serif',
  fontSize: '13px', fontWeight: '600', fontStyle: 'normal',
  lineHeight: 'normal', letterSpacing: 'normal', textAlign: 'start',
  ...overrides,
});

const capture = {
  root: {
    tag: 'main', classes: 'screen', rect: { x: 0, y: 0, w: 400, h: 300 },
    style: style({ backgroundColor: 'rgb(245, 245, 241)' }), texts: [], before: null, after: null,
    children: [
      {
        tag: 'a', classes: 'nav-item active', rect: { x: 10, y: 20, w: 120, h: 42 },
        style: style({ backgroundColor: 'rgb(255, 255, 255)', borderTopLeftRadius: '11px', borderTopRightRadius: '11px', borderBottomRightRadius: '11px', borderBottomLeftRadius: '11px', boxShadow: 'rgb(159, 214, 36) 3px 0px 0px 0px inset' }),
        texts: [{ text: 'Team', rect: { x: 34, y: 32, w: 32, h: 17 }, style: style({ textTransform: 'uppercase' }) }],
        before: null, after: null, children: [],
      },
      {
        tag: 'div', classes: 'pulse-card', rect: { x: 160, y: 20, w: 152, h: 96 },
        style: style({ backgroundColor: 'rgba(20, 21, 25, 0.72)', borderTop: '1px solid rgba(255, 255, 255, 0.2)', borderRight: '1px solid rgba(255, 255, 255, 0.2)', borderBottom: '1px solid rgba(255, 255, 255, 0.2)', borderLeft: '1px solid rgba(255, 255, 255, 0.2)', backdropFilter: 'blur(10px)', boxShadow: 'rgba(0, 0, 0, 0.3) 0px 18px 38px 0px' }),
        texts: [], before: null, after: null, children: [],
      },
      {
        tag: 'span', classes: 'orb orb-two', rect: { x: 250, y: 130, w: 80, h: 80 },
        style: style({ backgroundColor: 'rgb(116, 87, 232)', borderTopLeftRadius: '50%', borderTopRightRadius: '50%', borderBottomRightRadius: '50%', borderBottomLeftRadius: '50%', mixBlendMode: 'screen' }),
        texts: [], before: null, after: null, children: [],
      },
      {
        tag: 'div', classes: 'trial-orbit', rect: { x: 320, y: 220, w: 70, h: 70 },
        style: style({ borderTop: '1px solid rgb(104, 107, 114)', borderRight: '1px solid rgb(104, 107, 114)', borderBottom: '1px solid rgb(104, 107, 114)', borderLeft: '1px solid rgb(104, 107, 114)', borderTopLeftRadius: '50%', borderTopRightRadius: '50%', borderBottomRightRadius: '50%', borderBottomLeftRadius: '50%' }),
        texts: [], before: null, children: [],
        after: { which: '::after', content: '""', style: style({ position: 'absolute', borderTop: '1px solid rgb(75, 77, 84)', borderRight: '1px solid rgb(75, 77, 84)', borderBottom: '1px solid rgb(75, 77, 84)', borderLeft: '1px solid rgb(75, 77, 84)', borderTopLeftRadius: '50%', borderTopRightRadius: '50%', borderBottomRightRadius: '50%', borderBottomLeftRadius: '50%' }), width: '30px', height: '30px', top: '20px', left: '20px', right: '20px', bottom: '20px' },
      },
      {
        tag: 'svg', classes: '', aria: 'Chart', rect: { x: 20, y: 180, w: 200, h: 80 },
        style: style({ color: 'rgb(118, 87, 232)' }), texts: [], before: null, after: null, children: [],
        svg: '<svg viewBox="0 0 200 80"><path stroke="currentColor" d="M0 80L200 0"/></svg>',
      },
    ],
  },
};

describe('DOM capture to Figma JSX', () => {
  it('compiles the direct DOM plan without serializing or reparsing JSX', async () => {
    const legacy = domCaptureToJsx(capture);
    const direct = domCaptureToRenderPlan(capture);
    const legacyClient = new FigmaClient();
    legacyClient.setIcons(legacy.icons);
    const legacyCode = await legacyClient.parseJSX(legacy.jsx);

    const directClient = new FigmaClient();
    directClient.setIcons(direct.icons);
    directClient.parseJSXTree = () => { throw new Error('direct DOM plans must not invoke the JSX parser'); };
    const directCode = await directClient.compileRenderPlan(direct.renderPlan);

    assert.equal(direct.renderPlan.adapter, 'dom-capture');
    assert.deepEqual(direct.renderPlan.provenance, { captureVersion: 1 });
    assert.equal(directCode, legacyCode);
  });

  it('emits a real Instance for an explicitly linked DOM component and keeps its layout placement', async () => {
    const linkedCapture = structuredClone(capture);
    linkedCapture.version = 2;
    linkedCapture.root.children[0].sourceIdentity = { component: 'ui.nav.active' };
    const { jsx } = domCaptureToJsx(linkedCapture, {
      componentLinks: {
        'ui.nav.active': { key: 'nav-active-key', id: '10:20', variant: 'State=Active' },
      },
    });

    assert.match(jsx, /<Instance entity="ui\.nav\.active" name="nav-item\.active" key="nav-active-key" id="10:20" variant="State=Active" w="120" h="42"/);
    assert.doesNotMatch(jsx, />TEAM<\/Text>/);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /__resolveComponent\("10:20", null, "State=Active", "nav-active-key"\)/);
    assert.match(code, /createInstance\(\)/);
  });

  it('keeps inline SVG in Flex flow unless CSS actually positions it', () => {
    const flowCapture = structuredClone(capture);
    flowCapture.version = 2;
    flowCapture.root.style.display = 'flex';
    flowCapture.root.style.flexDirection = 'row';
    const svg = flowCapture.root.children.find((child) => child.svg);
    svg.style.position = 'static';
    const { jsx } = domCaptureToJsx(flowCapture);

    assert.match(jsx, /<Icon name="dom-svg-1" preserveColors="true" w="200" h="80"/);
    assert.doesNotMatch(jsx, /<Icon name="dom-svg-1"[^>]+position="absolute"/);
  });

  it('uses HUG for intrinsic single-line flow text and preserves semantic named text-style intent', () => {
    const eyebrowCapture = {
      version: 2,
      root: {
        tag: 'div', classes: 'eyebrow', rect: { x: 0, y: 0, w: 180, h: 24 },
        style: style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }),
        sourceIdentity: { textStyle: null },
        texts: [{ text: 'SYSTEM MAP', rect: { x: 0, y: 4, w: 72, h: 13 }, style: style({ fontSize: '10px', lineHeight: '13px', letterSpacing: '1.2px' }) }],
        contentOrder: [{ kind: 'text', index: 0 }], before: null, after: null, children: [],
      },
    };

    const { jsx } = domCaptureToJsx(eyebrowCapture);
    assert.match(jsx, /<Text[^>]+w="hug"[^>]+style="Typography\/Eyebrow"[^>]*>SYSTEM MAP<\/Text>/);
  });

  it('preserves the fidelity features that were previously dropped', () => {
    const { jsx, icons, diagnostics } = domCaptureToJsx(capture);
    assert.match(jsx, /name="nav-item\.active"[^>]+innerShadow="3 0 0 0 #9fd624"/);
    assert.doesNotMatch(jsx, /name="nav-item\.active"[^>]+stroke="#9fd624"/);
    assert.doesNotMatch(jsx, /name="inset-shadow"/);
    assert.match(jsx, /name="pulse-card"[^>]+bg="#141519b8"/);
    assert.match(jsx, /name="pulse-card"[^>]+bgBlur="10"/);
    assert.match(jsx, /name="orb\.orb-two"[^>]+blendMode="screen"/);
    assert.match(jsx, /name="pseudo::after"/);
    assert.match(jsx, /name="pseudo::after"[^>]+position="absolute"/);
    assert.equal((jsx.match(/name="pseudo::after"/g) || []).length, 1);
    assert.match(jsx, /<Icon name="dom-svg-1" preserveColors="true"[^>]+w="200" h="80"/);
    assert.match(icons['dom-svg-1'], /#7657e8/);
    assert.equal(diagnostics.pseudos, 1);
    assert.match(jsx, /<Text[^>]+w="34"[^>]*>TEAM<\/Text>/);
  });

  it('keeps a static pseudo-element in Flex flow and preserves its ring shadow', () => {
    const pseudoCapture = {
      version: 2,
      root: {
        tag: 'span', classes: 'live-label', rect: { x: 0, y: 0, w: 45, h: 14 },
        style: style({ display: 'flex', alignItems: 'center', gap: '5px' }),
        texts: [{ text: 'Live', rect: { x: 12, y: 0, w: 33, h: 14 }, style: style({ fontSize: '10px', fontWeight: '800' }) }],
        before: {
          which: '::before', content: '""', width: '7px', height: '7px',
          style: style({
            position: 'static', backgroundColor: 'rgb(169, 220, 59)',
            borderTopLeftRadius: '50%', borderTopRightRadius: '50%',
            borderBottomRightRadius: '50%', borderBottomLeftRadius: '50%',
            boxShadow: 'rgb(237, 247, 213) 0px 0px 0px 4px',
          }),
        },
        after: null, children: [],
      },
    };

    const { jsx } = domCaptureToJsx(pseudoCapture);
    assert.match(jsx, /name="pseudo::before"[^>]+shadow="0 0 0 4 #edf7d5"/);
    assert.doesNotMatch(jsx, /name="pseudo::before"[^>]+position="absolute"/);
    assert.ok(jsx.indexOf('name="pseudo::before"') < jsx.indexOf('>Live<\/Text>'), jsx);
  });

  it('maps a CSS border-left to native per-side Figma stroke props', () => {
    const borderCapture = structuredClone(capture);
    const active = borderCapture.root.children[0];
    active.style.boxShadow = 'none';
    active.style.borderLeft = '3px solid rgb(159, 214, 36)';

    const { jsx } = domCaptureToJsx(borderCapture);
    assert.match(jsx, /name="nav-item\.active"[^>]+stroke="#9fd624"[^>]+strokeTopWidth="0"[^>]+strokeRightWidth="0"[^>]+strokeBottomWidth="0"[^>]+strokeLeftWidth="3"/);
    assert.doesNotMatch(jsx, /name="border\.left"/);
  });

  it('maps a dashed CSS border to a native Figma dash pattern', async () => {
    const dashedCapture = structuredClone(capture);
    const chartGridLine = dashedCapture.root.children[1];
    chartGridLine.style.borderTop = '1px dashed rgb(229, 229, 223)';
    chartGridLine.style.borderRight = '0px none rgb(0, 0, 0)';
    chartGridLine.style.borderBottom = '0px none rgb(0, 0, 0)';
    chartGridLine.style.borderLeft = '0px none rgb(0, 0, 0)';

    const { jsx } = domCaptureToJsx(dashedCapture);
    assert.match(jsx, /name="pulse-card"[^>]+stroke="#e5e5df"/);
    assert.match(jsx, /name="pulse-card"[^>]+strokeDashPattern="4 4"/);
    assert.match(jsx, /name="pulse-card"[^>]+strokeTopWidth="1"/);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /dashPattern = \[4,4\]/);
  });

  it('keeps a sharp CSS inset box-shadow as a native Figma inner shadow', async () => {
    const { jsx } = domCaptureToJsx(capture);
    const client = new FigmaClient();
    const code = await client.parseJSX(jsx);

    assert.match(jsx, /innerShadow="3 0 0 0 #9fd624"/);
    assert.match(code, /type:'INNER_SHADOW'[^]*offset:\{x:3,y:0\}[^]*radius:0,spread:0/);
  });

  it('compiles to positioned text, alpha paints and SVG dimensions', async () => {
    const { jsx, icons } = domCaptureToJsx(capture);
    const client = new FigmaClient();
    client.setIcons(icons);
    const code = await client.parseJSX(jsx);
    assert.match(code, /Text: TEAM/);
    assert.match(code, /\.x = 24/);
    assert.match(code, /opacity:0\.721/);
    assert.match(code, /BACKGROUND_BLUR/);
    assert.match(code, /\.resize\(200, 80\)/);
  });

  it('uses the first CSS-side paint for one native stroke while preserving per-side widths', () => {
    const borderCapture = structuredClone(capture);
    borderCapture.version = 2;
    borderCapture.root.children[1].style.borderTop = '2px solid rgb(255, 0, 0)';
    borderCapture.root.children[1].style.borderRight = '3px solid rgb(0, 255, 0)';
    borderCapture.root.children[1].style.borderBottom = '4px solid rgb(0, 0, 255)';
    borderCapture.root.children[1].style.borderLeft = '5px solid rgb(255, 255, 0)';
    const { jsx, icons, diagnostics } = domCaptureToJsx(borderCapture);
    assert.equal(diagnostics.borderVectors, 0);
    assert.match(jsx, /name="pulse-card"[^>]+stroke="#ff0000"/);
    assert.match(jsx, /strokeTopWidth="2"[^>]+strokeRightWidth="3"[^>]+strokeBottomWidth="4"[^>]+strokeLeftWidth="5"/);
    assert.doesNotMatch(jsx, /css-border-flatten-vector/);
    assert.deepEqual(icons, { 'dom-svg-1': icons['dom-svg-1'] });

    const { renderPlan } = domCaptureToRenderPlan(borderCapture);
    const pulseCard = renderPlan.root.children.find((node) => node.name === 'pulse-card');
    assert.deepEqual(pulseCard.fallbackAnnotations?.map((annotation) => annotation.policy), [
      'border.single-paint-native',
    ]);
    assert.match(pulseCard.fallbackAnnotations[0].labelMarkdown, /unterschiedliche Border-Farben/);
    assert.deepEqual(pulseCard.fallbackAnnotations[0].properties, ['strokes', 'strokeWeight']);
  });

  it('preserves supported CSS filter functions as an ordered same-layer chain', async () => {
    const filterCapture = structuredClone(capture);
    filterCapture.root.children[2].style.filter = 'blur(4px) drop-shadow(2px 3px 6px rgba(0, 0, 0, 0.25))';
    const { jsx } = domCaptureToJsx(filterCapture);
    assert.match(jsx, /filter="blur\(4px\) drop-shadow/);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /type:'LAYER_BLUR',radius:4[^]*type:'DROP_SHADOW'/);
  });

  it('parses the browser color-first drop-shadow form without corrupting geometry', async () => {
    const filterCapture = structuredClone(capture);
    filterCapture.root.children[2].style.filter = 'blur(3px) drop-shadow(rgb(201, 255, 88) 0px 0px 22px)';
    const { jsx } = domCaptureToJsx(filterCapture);
    const code = await new FigmaClient().parseJSX(jsx);
    assert.match(code, /type:'DROP_SHADOW',color:\{r:0\.788[^}]+g:1[^}]+b:0\.345/);
    assert.match(code, /offset:\{x:0,y:0\},radius:22/);
  });

  it('preserves SVG dash arrays, gradient stop opacity and descendant filters as native Figma effects', async () => {
    const svgCapture = structuredClone(capture);
    const svg = svgCapture.root.children[4];
    svg.svg = '<svg viewBox="0 0 200 80"><defs><linearGradient id="fade"><stop offset="0" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path stroke="currentColor" stroke-dasharray="4 6" d="M0 80L200 0"/><circle id="figma-filter-1" fill="currentColor" filter="drop-shadow(rgb(118, 87, 232) 0px 0px 6px)" cx="10" cy="10" r="4"/></svg>';
    const { icons, jsx } = domCaptureToJsx(svgCapture);
    assert.match(icons['dom-svg-1'], /stroke-dasharray="4 6"/);
    assert.match(icons['dom-svg-1'], /stop-opacity="0"/);
    assert.match(icons['dom-svg-1'], /filter="drop-shadow\(rgb\(118, 87, 232\) 0px 0px 6px\)"/);
    const client = new FigmaClient();
    client.setIcons(icons);
    const code = await client.parseJSX(jsx);
    assert.match(code, /findAll\(n => n\.name === "figma-filter-1"\)/);
    assert.match(code, /type:'DROP_SHADOW'[^]*offset:\{x:0,y:0\},radius:6/);
  });

  it('creates real Figma masks and preserves JSX sibling order', async () => {
    const client = new FigmaClient();
    const code = await client.parseJSX('<Frame name="Mask group" flex="none"><Ellipse name="Mask shape" w="40" h="40" mask="alpha"/><Rect name="Content" w="80" h="80" bg="#ff0000"/></Frame>');
    assert.ok(code.indexOf("isMask = true") < code.indexOf('name = "Content"'));
    assert.match(code, /isMask = true; [^]*maskType = 'ALPHA'/);
  });
});
