import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FigmaClient } from '../src/lib/jsx-render.js';

function assertValidJs(code) {
  assert.doesNotThrow(() => new Function(code), SyntaxError, `Generated code is not valid JS:\n${code}`);
}

// The client no longer fetches icon SVGs at all (no-network build) — <Icon>
// always takes the placeholder path, so no stubbing is needed.
function makeClient() {
  return new FigmaClient();
}

// Regression: the self-closing element regexes used [^/]* for the attribute
// section, so ANY attribute value containing a slash (var:green/600, URLs)
// silently dropped the whole element. Confirmed live: a render with var: icon
// colors produced a screen with every icon missing.
describe('self-closing elements with slashes in attribute values', () => {
  it('Icon with var: color (slash) is parsed, not dropped', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Icon name="lucide:leaf" size={20} color="var:green/600" /></Frame>'
    );
    assert.ok(code.includes('lucide:leaf'), 'icon element must survive parsing');
    assertValidJs(code);
  });

  it('Instance with slash in a prop value is parsed, not dropped', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="media/Plant Card" /></Frame>'
    );
    assert.ok(code.includes('__resolveComponent'), 'instance element must survive parsing');
    assertValidJs(code);
  });

  it('Rect / Ellipse / Image with var: fills (slash) are parsed', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col">' +
      '<Rect w={10} h={10} bg="var:sage/25" />' +
      '<Ellipse w={10} h={10} bg="var:green/100" />' +
      '<Image w={10} h={10} bg="var:teal/50" />' +
      '</Frame>'
    );
    assert.ok(code.includes('createRectangle'), 'Rect survives');
    assert.ok(code.includes('createEllipse'), 'Ellipse survives');
    assertValidJs(code);
  });

  it('attribute-less self-closing elements still parse (optional group)', async () => {
    const client = makeClient();
    const code = await client.parseJSX('<Frame name="P" flex="col"><Rect /><Ellipse /></Frame>');
    assert.ok(code.includes('createRectangle'), 'bare Rect still parses');
    assertValidJs(code);
  });
});

describe('<Instance> component reuse (cross-page, variants, overrides)', () => {
  it('resolves by name across pages via __resolveComponent helper', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Plant Card" /></Frame>'
    );
    assert.ok(code.includes('loadAllPagesAsync'), 'searches beyond the current page');
    assert.ok(code.includes("COMPONENT_SET"), 'accepts component sets');
    assertValidJs(code);
  });

  it('variant= picks a variant and applies setProperties', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Plant Card" variant="Tone=Teal" /></Frame>'
    );
    assert.ok(/__resolveComponent\(null, "Plant Card", "Tone=Teal", null\)/.test(code), 'variant reaches resolver');
    assert.ok(code.includes('setProperties(__variantPairs("Tone=Teal"))'), 'variant applied to instance');
    assertValidJs(code);
  });

  it('a requested variant that does not exist FAILS with a recipe — no silent default', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Plant Card" variant="Tone=Teal" /></Frame>'
    );
    // The throw lives inside the variantStr branch of the resolver…
    assert.ok(code.includes('not found on set'), 'missing variant throws');
    assert.ok(code.includes("'component', 'add-variant'"), 'error carries the add-variant recipe');
    assert.ok(code.includes('variantGroupProperties'), 'error lists existing axes/values');
    // …and the default fallback survives ONLY for instances without variant=
    // (the "give me the component" case must keep working).
    assert.ok(code.includes('variant || node.defaultVariant || node.children[0]'),
      'no-variant path still falls back to the default variant');
    assertValidJs(code);
  });

  it('the variant-miss throw is present in the batch path too (helper parity)', async () => {
    const client = makeClient();
    const code = await client.parseJSXBatch([
      '<Frame name="A" flex="col"><Instance component="Button" variant="Size=SM" /></Frame>',
    ]);
    assert.ok(code.includes('not found on set'), 'batch shares the hardened resolver');
    assertValidJs(code);
  });

  it('text:Layer= and prop:Name= overrides are emitted', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Plant Card" text:Name="Boston Fern" prop:Selected="true" /></Frame>'
    );
    assert.ok(code.includes('__setInstanceText(') && code.includes('"Boston Fern"'), 'text override emitted');
    assert.ok(code.includes('__mapProps(') && code.includes('"Selected"'), 'component property override emitted');
    assertValidJs(code);
  });

  it('id-shaped component value keeps backwards-compatible id resolution', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="4:618" /></Frame>'
    );
    assert.ok(/__resolveComponent\("4:618", null/.test(code), 'id-shaped value resolves by id');
    assertValidJs(code);
  });

  it('unresolved components are reported instead of silently skipped', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Instance component="Nope" /></Frame>'
    );
    assert.ok(code.includes("'component:' +"), 'missing component recorded for the unresolved report');
  });
});

describe('<Text> style + variable-bound size', () => {
  it('style="Name" applies a local text style via __applyTextStyle', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text style="Body/MD">Hi</Text></Frame>'
    );
    assert.ok(code.includes('getLocalTextStylesAsync'), 'text-style helper preamble included');
    assert.ok(code.includes('__applyTextStyle(el0, "Body/MD")'), 'style applied to the text node');
    assertValidJs(code);
  });

  it('size="var:text/md" binds fontSize to a FLOAT variable', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text size="var:text/md">Hi</Text></Frame>'
    );
    assert.ok(code.includes("setBoundVariable('fontSize'"), 'fontSize bound to variable');
    assert.ok(code.includes('lookupVar("text/md")'), 'variable resolved by name');
    assert.ok(code.includes('getLocalVariablesAsync'), 'var preamble loaded (size counts as var usage)');
    assert.ok(!code.includes('fontSize = var:'), 'raw var string must not leak into fontSize');
    assertValidJs(code);
  });

  it('plain numeric size is untouched', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text size={18}>Hi</Text></Frame>'
    );
    assert.ok(code.includes('fontSize = 18'), 'numeric size still direct');
    assert.ok(!code.includes('__applyTextStyle('), 'no explicit-style call without style prop');
  });
});

// Every plain <Text> gets attached to a shared local text style — reused when
// a style of the derived name exists, created when it doesn't. This is what
// keeps rendered screens from accumulating raw, style-less typography.
describe('<Text> auto text styles (create-or-reuse)', () => {
  it('plain text gets __ensureTextStyle with a deterministic name', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text size={14} weight="semibold">Hi</Text></Frame>'
    );
    assert.ok(code.includes('__ensureTextStyle(el0, "Inter", "Semi Bold", 14)'), 'auto style applied');
    assert.ok(code.includes('createTextStyle'), 'helper can create missing styles');
    assert.ok(code.includes('getLocalTextStylesAsync'), 'helper reuses existing local styles');
    assertValidJs(code);
  });

  it('reuses an existing style by TYPOGRAPHY, not just by name', () => {
    const client = makeClient();
    const code = client.generateTextStyleHelperCode();
    assert.ok(
      code.includes('st.fontSize === Number(size)') && code.includes('st.fontName.family === family'),
      'matches an existing style on family/style/size so a file\'s own naming wins'
    );
  });

  it('explicit style= wins over auto style', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text style="Body/MD" size={14}>Hi</Text></Frame>'
    );
    assert.ok(code.includes('__applyTextStyle(el0, "Body/MD")'), 'explicit style applied');
    assert.ok(!code.includes('__ensureTextStyle('), 'no auto style on top of explicit style');
  });

  it('var-bound size skips auto style (style would fight the binding)', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text size="var:text/md">Hi</Text></Frame>'
    );
    assert.ok(code.includes("setBoundVariable('fontSize'"), 'binding still emitted');
    assert.ok(!code.includes('__ensureTextStyle('), 'no auto style for var-bound size');
  });

  it('lineHeight/letterSpacing overrides skip auto style (they would detach it)', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text size={14} lineHeight={20}>Hi</Text></Frame>'
    );
    assert.ok(!code.includes('__ensureTextStyle('), 'no auto style with style-bound overrides');
  });

  it('unknown explicit style name is CREATED, not reported missing', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Text style="Brand/Hero">Hi</Text></Frame>'
    );
    assert.ok(code.includes('createTextStyle'), '__applyTextStyle can create the named style');
    assert.ok(!code.includes("'style:' +"), 'no more unresolved-style reporting — creation replaces it');
  });
});

// Spacing/radius numbers used to land on nodes as hard-coded values, ignoring
// the file's space/* and radius/* tokens entirely. Now every gap, padding and
// corner radius binds to a FLOAT variable: reused when one of the matching
// namespace already holds that value, created otherwise.
describe('spacing + radius tokens (reuse-or-create)', () => {
  it('nested frame gap/padding bind via __space with kind "space"', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Frame name="Card" flex="row" gap={16} p={24} /></Frame>'
    );
    assert.ok(code.includes('__space(el0, ["itemSpacing"], 16, "space")'), 'gap bound');
    assert.ok(code.includes('__space(el0, ["paddingTop"], 24, "space")'), 'padding bound');
    assert.ok(code.includes('el0.itemSpacing = 16'), 'raw value still assigned as fallback');
    assertValidJs(code);
  });

  it('rounded binds all four corner fields with kind "radius"', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Frame name="Card" rounded={14} /></Frame>'
    );
    assert.ok(
      code.includes('__space(el0, ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius"], 14, "radius")'),
      'radius bound on all corners'
    );
    assertValidJs(code);
  });

  it('root frame spacing binds too', async () => {
    const client = makeClient();
    const code = await client.parseJSX('<Frame name="P" flex="col" gap={12} p={32} rounded={16} />');
    assert.ok(code.includes('__space(frame, ["itemSpacing"], 12, "space")'), 'root gap bound');
    assert.ok(code.includes('__space(frame, ["paddingTop","paddingBottom"], 32, "space")'), 'root padding bound');
    assert.ok(code.includes('12, "space"') && code.includes('16, "radius"'), 'root radius bound');
    assertValidJs(code);
  });

  it('explicit var: reference is honoured instead of value matching', async () => {
    const client = makeClient();
    const code = await client.parseJSX(
      '<Frame name="P" flex="col"><Frame name="Card" gap="var:space/4" /></Frame>'
    );
    assert.ok(code.includes('__space(el0, ["itemSpacing"], "var:space/4", "space")'), 'var ref passed through');
    assert.ok(code.includes('el0.itemSpacing = 0'), 'var ref must not leak into the raw assignment');
    assert.ok(code.includes('getLocalVariablesAsync'), 'var cache loaded for the lookup');
    assertValidJs(code);
  });

  it('zero spacing is not tokenised', async () => {
    const client = makeClient();
    const code = await client.parseJSX('<Frame name="P" flex="col" gap={0}><Rect w={4} h={4} /></Frame>');
    assert.ok(!code.includes('__space('), 'nothing to tokenise → no helper calls');
    assert.ok(!code.includes('__spaceCache'), 'helper preamble omitted entirely');
  });

  it('namespace matching uses only the explicitly approved spacing/radius families', () => {
    const client = makeClient();
    const code = client.generateSpacingHelperCode();
    assert.ok(code.includes("head === 'space' || head === 'spacing'"), 'only exact spacing namespace heads match');
    assert.ok(code.includes("head === 'radius' || head === 'radii'"), 'only exact radius namespace heads match');
    assert.ok(!code.includes('head.includes'), 'substring guesses must never select or scope a variable');
  });

  it('creates a namespaced variable when no token matches', () => {
    const client = makeClient();
    const code = client.generateSpacingHelperCode();
    assert.ok(code.includes("'radius/' : 'space/'"), 'new variables are namespaced');
    assert.ok(code.includes("createVariable(name, col, 'FLOAT')"), 'creates a FLOAT variable');
    assert.ok(code.includes("['CORNER_RADIUS'] : ['GAP']"), 'created variables receive a narrow Figma scope');
    assert.ok(code.includes('setValueForMode'), 'sets the value for every mode');
  });

  it('keeps reused variable scopes and narrows only newly created variables', () => {
    const client = makeClient();
    const code = client.generateSpacingHelperCode();
    assert.ok(code.includes('if (!isNew) return variable'), 'existing user/library variables keep their scopes');
    assert.ok(code.includes('if (hit) return hit'), 'value-matched variables are reused unchanged');
    assert.ok(code.includes('__scopeSpaceVar(v, kind, true)'), 'only variables created by the render are narrowed');
  });

  it('batch path includes the spacing helper', async () => {
    const client = makeClient();
    const code = await client.parseJSXBatch(['<Frame name="A" flex="col" gap={8} />']);
    assert.ok(code.includes('__spaceCache'), 'spacing helper in batch preamble');
    assert.ok(code.includes('__space(f0, ["itemSpacing"], 8, "space")'), 'batch root gap bound');
    assertValidJs(code);
  });
});

describe('batch render path parity', () => {
  it('parseJSXBatch includes instance + text-style helpers when used', async () => {
    const client = makeClient();
    const code = await client.parseJSXBatch([
      '<Frame name="A" flex="col"><Instance component="Button" variant="Size=SM" /></Frame>',
      '<Frame name="B" flex="col"><Text style="Caption">x</Text></Frame>',
    ]);
    assert.ok(code.includes('__resolveComponent'), 'instance helper in batch preamble');
    assert.ok(code.includes('__applyTextStyle'), 'text-style helper in batch preamble');
    assertValidJs(code);
  });
});

describe('prop validation for new vocabulary', () => {
  it('accepts variant / text: / prop: on Instance and style on Text', () => {
    const client = makeClient();
    const warnings = client.validateJsxProps(
      '<Frame name="P"><Instance component="X" variant="Tone=Teal" text:Name="Y" prop:State="Z" /><Text style="Body">t</Text></Frame>'
    );
    assert.deepStrictEqual(warnings, [], `expected no warnings, got ${JSON.stringify(warnings)}`);
  });
});
