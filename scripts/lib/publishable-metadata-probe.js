export const PUBLISHABLE_METADATA_PROBE_SCHEMA = 'figma-bridge/publishable-metadata-probe';

export const PUBLISHABLE_METADATA_POLICY = Object.freeze({
  version: 1,
  fields: Object.freeze({
    description: Object.freeze({ kind: 'string' }),
    descriptionMarkdown: Object.freeze({ kind: 'string' }),
    documentationLinks: Object.freeze({ kind: 'array' }),
    remote: Object.freeze({ kind: 'boolean' }),
    key: Object.freeze({ kind: 'string' }),
  }),
  subjects: Object.freeze([
    'style.PAINT',
    'style.TEXT',
    'style.EFFECT',
    'style.GRID',
    'component.COMPONENT',
    'component.COMPONENT_SET',
  ]),
  allowedMissing: Object.freeze({
    // Observed live on one complete local Text Style with Plugin typings
    // 1.133.0. Do not generalize this exception to another family or field.
    'style.TEXT': Object.freeze(['descriptionMarkdown']),
  }),
});

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function publishableMetadataProbeCode() {
  const fields = Object.keys(PUBLISHABLE_METADATA_POLICY.fields);
  return `(async () => {
    const fields = ${JSON.stringify(fields)};
    const state = (subject) => Object.fromEntries(fields.map((field) => {
      if (!(field in subject) || subject[field] === undefined) return [field, 'missing'];
      if (Array.isArray(subject[field])) return [field, 'array'];
      if (subject[field] === null) return [field, 'null'];
      return [field, typeof subject[field]];
    }));
    const styleLists = await Promise.all([
      figma.getLocalPaintStylesAsync(),
      figma.getLocalTextStylesAsync(),
      figma.getLocalEffectStylesAsync(),
      figma.getLocalGridStylesAsync(),
    ]);
    const subjects = ['PAINT', 'TEXT', 'EFFECT', 'GRID'].map((type, index) => ({
      subject: 'style.' + type,
      sampled: styleLists[index].length > 0,
      fields: styleLists[index].length > 0 ? state(styleLists[index][0]) : null,
    }));
    await figma.loadAllPagesAsync();
    for (const type of ['COMPONENT', 'COMPONENT_SET']) {
      const sample = figma.root.findOne((node) => node.type === type);
      subjects.push({
        subject: 'component.' + type,
        sampled: sample !== null,
        fields: sample ? state(sample) : null,
      });
    }
    return JSON.stringify({
      schema: ${JSON.stringify(PUBLISHABLE_METADATA_PROBE_SCHEMA)},
      version: 1,
      subjects,
    });
  })()`;
}

export function validatePublishableMetadataProbe(value) {
  if (!exactKeys(value, ['schema', 'version', 'subjects'])
      || value.schema !== PUBLISHABLE_METADATA_PROBE_SCHEMA
      || value.version !== 1
      || !Array.isArray(value.subjects)
      || value.subjects.length !== PUBLISHABLE_METADATA_POLICY.subjects.length) {
    return false;
  }
  const expectedSubjects = new Set(PUBLISHABLE_METADATA_POLICY.subjects);
  const seen = new Set();
  for (const entry of value.subjects) {
    if (!exactKeys(entry, ['subject', 'sampled', 'fields'])
        || !expectedSubjects.has(entry.subject) || seen.has(entry.subject)
        || typeof entry.sampled !== 'boolean') return false;
    seen.add(entry.subject);
    if (!entry.sampled) {
      if (entry.fields !== null) return false;
      continue;
    }
    if (!exactKeys(entry.fields, Object.keys(PUBLISHABLE_METADATA_POLICY.fields))) return false;
    if (Object.values(entry.fields).some((state) => (
      !['missing', 'null', 'string', 'boolean', 'array'].includes(state)
    ))) return false;
  }
  return seen.size === expectedSubjects.size;
}

export function auditPublishableMetadataProbe(value) {
  if (!validatePublishableMetadataProbe(value)) {
    throw new Error('Publishable metadata probe returned an invalid bounded report');
  }
  const errors = [];
  const exceptions = [];
  const unsampled = [];
  for (const entry of value.subjects) {
    if (!entry.sampled) {
      unsampled.push(entry.subject);
      continue;
    }
    const allowed = new Set(PUBLISHABLE_METADATA_POLICY.allowedMissing[entry.subject] || []);
    for (const [field, policy] of Object.entries(PUBLISHABLE_METADATA_POLICY.fields)) {
      const observed = entry.fields[field];
      if (observed === 'missing' && allowed.has(field)) {
        exceptions.push(Object.freeze({ subject: entry.subject, field, observed }));
      } else if (observed !== policy.kind) {
        errors.push(Object.freeze({
          subject: entry.subject,
          field,
          expected: policy.kind,
          observed,
        }));
      }
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    exceptions: Object.freeze(exceptions),
    unsampled: Object.freeze(unsampled),
  });
}
