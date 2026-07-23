/**
 * Ordered instancing attempts from a reuse handle. Pure.
 * key first (cross-file / published library), id as the always-works same-file
 * fallback. The I/O shell tries each in order until one succeeds.
 */
export function resolveInstancePlan(reuse) {
  if (!reuse) return [];
  const plan = [];
  if (reuse.key) plan.push({ via: 'key', key: reuse.key });
  if (reuse.id) plan.push({ via: 'id', id: reuse.id });
  return plan;
}
