import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FigmaClient } from '../src/lib/jsx-render.js';
import { decodeTextEntities, parseRichTextContent } from '../src/lib/rich-text.js';
import { assertSemanticRenderPlan } from '../src/lib/semantic-render-plan.js';

test('entity decoding covers named, decimal and Unicode hex references', () => {
  assert.equal(decodeTextEntities('&lt;b&gt; &amp; &#169; &#x1F642; &unknown;'), '<b> & © 🙂 &unknown;');
});

test('inline markup becomes merged, nested UTF-16 ranges without losing copy', () => {
  const client = new FigmaClient();
  const plan = client.planJSX(
    '<Frame><Text>Hello <strong>bold &amp; <em>italic</em></strong> '
    + '<Span color="#ff0000" size="18">red</Span> '
    + '<a href="https://example.com">link</a> &#x1F642;</Text></Frame>',
  );
  const props = plan.root.children[0].source.props;
  assert.equal(props.content, 'Hello bold & italic red link 🙂');
  const bold = props.runs.find((run) => props.content.slice(run.start, run.end) === 'bold & ');
  const italic = props.runs.find((run) => props.content.slice(run.start, run.end) === 'italic');
  const red = props.runs.find((run) => props.content.slice(run.start, run.end) === 'red');
  const link = props.runs.find((run) => props.content.slice(run.start, run.end) === 'link');
  assert.deepEqual(bold.style, { weight: 'bold' });
  assert.deepEqual(italic.style, { weight: 'bold', italic: true });
  assert.deepEqual(red.style, { color: '#ff0000', size: '18' });
  assert.deepEqual(link.style, { href: 'https://example.com' });
  assert.equal(props.content.slice(-2).length, 2, 'astral Unicode uses the UTF-16 offsets Figma expects');
});

test('malformed inline markup and invalid plan ranges are rejected', () => {
  assert.throws(() => parseRichTextContent('<strong>open'), /unclosed/);
  const plan = new FigmaClient().planJSX('<Frame><Text>Good</Text></Frame>');
  plan.root.children[0].source.props.runs = [{ start: 0, end: 99, style: { weight: 700 } }];
  assert.throws(() => assertSemanticRenderPlan(plan), /invalid or overlapping range/);
});
