/**
 * Validates and normalizes splat placement settings.
 * Accepts only non-null, non-array plain objects with:
 *  - center: array of 3 finite numbers
 *  - scale: finite number > 0 (no string coercion)
 *
 * @param {unknown} value
 * @returns {Readonly<{center: Readonly<[number, number, number]>, scale: number}> | null}
 */
export function validateSplatNormalization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const { center, scale } = value;

  if (!Array.isArray(center) || center.length !== 3) {
    return null;
  }

  for (let i = 0; i < 3; i++) {
    const c = center[i];
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      return null;
    }
  }

  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const safeCenter = Object.freeze([center[0], center[1], center[2]]);
  return Object.freeze({
    center: safeCenter,
    scale
  });
}

const DEFAULT_PLACEMENT = Object.freeze({
  center: Object.freeze([0, 0, 0]),
  scale: 1,
  source: 'default'
});

/**
 * Resolves final splat placement with source indicator.
 * Priority: configured -> scanned -> default
 *
 * @param {{configured?: unknown, scanned?: unknown}} [options={}]
 * @returns {Readonly<{center: Readonly<[number, number, number]>, scale: number, source: 'configured' | 'scanned' | 'default'}>}
 */
export function resolveSplatPlacement({ configured = null, scanned = null } = {}) {
  const validConfigured = validateSplatNormalization(configured);
  if (validConfigured) {
    return Object.freeze({
      center: validConfigured.center,
      scale: validConfigured.scale,
      source: 'configured'
    });
  }

  const validScanned = validateSplatNormalization(scanned);
  if (validScanned) {
    return Object.freeze({
      center: validScanned.center,
      scale: validScanned.scale,
      source: 'scanned'
    });
  }

  return DEFAULT_PLACEMENT;
}
