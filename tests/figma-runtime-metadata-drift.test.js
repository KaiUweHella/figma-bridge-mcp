import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PUBLISHABLE_METADATA_POLICY,
  auditPublishableMetadataProbe,
  publishableMetadataProbeCode,
  validatePublishableMetadataProbe,
} from '../scripts/lib/publishable-metadata-probe.js';
import { officialInterfaceFieldContract } from '../scripts/lib/figma-typing-union-audit.js';

const typingsPath = fileURLToPath(
  new URL('../node_modules/@figma/plugin-typings/plugin-api.d.ts', import.meta.url),
);

function completeProbe() {
  const fields = Object.fromEntries(Object.entries(PUBLISHABLE_METADATA_POLICY.fields)
    .map(([field, policy]) => [field, policy.kind]));
  return {
    schema: 'figma-bridge/publishable-metadata-probe',
    version: 1,
    subjects: PUBLISHABLE_METADATA_POLICY.subjects.map((subject) => ({
      subject,
      sampled: true,
      fields: { ...fields },
    })),
  };
}

test('publishable runtime policy matches required official Figma typing shapes', () => {
  const official = officialInterfaceFieldContract({
    typingsPath,
    interfaceName: 'PublishableMixin',
    fields: Object.keys(PUBLISHABLE_METADATA_POLICY.fields),
  });
  assert.deepEqual(official, {
    description: { required: true, kind: 'string' },
    descriptionMarkdown: { required: true, kind: 'string' },
    documentationLinks: { required: true, kind: 'array' },
    remote: { required: true, kind: 'boolean' },
    key: { required: true, kind: 'string' },
  });
});

test('only the reviewed Text Style Markdown omission is compatible', () => {
  const probe = completeProbe();
  probe.subjects.find((entry) => entry.subject === 'style.TEXT')
    .fields.descriptionMarkdown = 'missing';
  const audit = auditPublishableMetadataProbe(probe);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.exceptions, [{
    subject: 'style.TEXT', field: 'descriptionMarkdown', observed: 'missing',
  }]);

  probe.subjects.find((entry) => entry.subject === 'style.PAINT')
    .fields.descriptionMarkdown = 'missing';
  const drifted = auditPublishableMetadataProbe(probe);
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.errors, [{
    subject: 'style.PAINT', field: 'descriptionMarkdown', expected: 'string', observed: 'missing',
  }]);
});

test('new missing required metadata fails while unsampled kinds stay explicit', () => {
  const probe = completeProbe();
  probe.subjects.find((entry) => entry.subject === 'component.COMPONENT').fields.key = 'missing';
  const absent = probe.subjects.find((entry) => entry.subject === 'component.COMPONENT_SET');
  absent.sampled = false;
  absent.fields = null;
  const audit = auditPublishableMetadataProbe(probe);
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.unsampled, ['component.COMPONENT_SET']);
  assert.deepEqual(audit.errors, [{
    subject: 'component.COMPONENT', field: 'key', expected: 'string', observed: 'missing',
  }]);
});

test('runtime probe is closed, bounded and contains no metadata values or identities', () => {
  const probe = completeProbe();
  assert.equal(validatePublishableMetadataProbe(probe), true);
  assert.equal(validatePublishableMetadataProbe({ ...probe, fileKey: 'private' }), false);
  assert.equal(validatePublishableMetadataProbe({
    ...probe,
    subjects: probe.subjects.map((entry, index) => (
      index === 0 ? { ...entry, fields: { ...entry.fields, description: 'actual content' } } : entry
    )),
  }), false);
  const code = publishableMetadataProbeCode();
  assert.doesNotMatch(code, /\.name\b|\.id\b|sourceNodeId|characters/);
  assert.match(code, /return \[field, 'missing'\]/);
});
