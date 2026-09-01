// Convert the pure Motion normalizer output into the shared transaction shape.

export function prepareNormalizedMotionTracks(action, normalized) {
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)
    || !Number.isFinite(normalized.duration) || normalized.duration < 0
    || !normalized.byNode || typeof normalized.byNode !== 'object' || Array.isArray(normalized.byNode)) {
    throw new TypeError('Normalized Motion tracks are invalid.');
  }
  const nodes = Object.entries(normalized.byNode).map(([requestedId, fields]) => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('Normalized Motion node tracks are invalid.');
    }
    const tracks = [];
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'fills' || name === 'strokes') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError('Normalized Motion paint tracks are invalid.');
        }
        for (const [index, binding] of Object.entries(value)) {
          if (!/^(0|[1-9]\d*)$/u.test(index)) throw new TypeError('Normalized Motion paint index is invalid.');
          tracks.push({
            label: `${name}[${index}]`,
            field: { type: 'INDEXED_ITEM', collection: name, index: Number(index) },
            binding,
          });
        }
      } else {
        tracks.push({ label: name, field: { type: 'PROPERTY', name }, binding: value });
      }
    }
    return { requestedId, tracks };
  });
  return { action, duration: normalized.duration, nodes };
}
