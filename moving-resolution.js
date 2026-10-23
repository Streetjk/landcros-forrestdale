// Session-only adaptive moving resolution. The full-resolution still image is
// managed by the viewer; this policy only learns a lower DPR for camera motion.
// Keep it independent of Three.js/DOM so pacing and override rules are testable.
export function createMovingResolutionPolicy({
  tier = 'medium', pixelRatio = 1, overrideDpr = null,
  slowFrameMs = 30, minSamples = 18, maxSamples = 32,
} = {}) {
  const fullDpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const forced = Number.isFinite(overrideDpr) && overrideDpr > 0;
  let movingDpr = Math.min(fullDpr, forced ? overrideDpr : 1);
  const adaptive = !forced && tier === 'high' && movingDpr > 0.75;
  let lastMovingAt = null;
  const intervals = [];

  function resetSamples() {
    lastMovingAt = null;
    intervals.length = 0;
  }

  function observeFrame(now, moving, ready = true) {
    if (!adaptive || movingDpr <= 0.75 || !ready || !moving || !Number.isFinite(now)) {
      resetSamples();
      return null;
    }
    if (lastMovingAt !== null) {
      const gap = now - lastMovingAt;
      // Ignore timer glitches, hidden-tab resumptions and unrelated long tasks.
      if (gap >= 8 && gap <= 110) {
        intervals.push(gap);
        if (intervals.length > maxSamples) intervals.shift();
      } else {
        intervals.length = 0;
      }
    }
    lastMovingAt = now;
    if (intervals.length < minSamples) return null;

    const ordered = [...intervals].sort((a, b) => a - b);
    const midpoint = Math.floor(ordered.length / 2);
    const medianMs = ordered.length % 2
      ? ordered[midpoint]
      : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
    if (medianMs < slowFrameMs) return null;

    const previousDpr = movingDpr;
    movingDpr = Math.min(fullDpr, 0.75);
    const evidence = { previousDpr, movingDpr, medianMs, samples: intervals.length };
    resetSamples();
    return evidence;
  }

  return {
    get movingDpr() { return movingDpr; },
    adaptive,
    observeFrame,
    resetSamples,
  };
}
