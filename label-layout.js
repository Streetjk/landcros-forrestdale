// Screen-space visibility helpers for public SiteNav labels.
// Building labels stay at their designed world-space anchors. We never move,
// reprioritise, or suppress a label because another label overlaps it. Labels
// remain rendered while any part of their designed card intersects the viewport;
// the label layer clips the off-screen portion visually.

export function labelScaleForZoom(zoom) {
  const z = Number.isFinite(zoom) ? Math.max(0, zoom) : 26;
  if (z <= 18) return 0.66;
  if (z <= 42) return 0.66 - ((z - 18) / 24) * 0.12;
  if (z <= 58) return 0.54;
  return Math.max(0.44, 0.54 - ((z - 58) / 22) * 0.10);
}

function rectFor(item, scale) {
  const width = Math.max(1, item.width * scale);
  const height = Math.max(1, item.height * scale);
  return {
    left: item.x - width / 2,
    right: item.x + width / 2,
    top: item.y - height / 2,
    bottom: item.y + height / 2,
  };
}

function intersectsViewport(rect, viewport) {
  return rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewport.width &&
    rect.top < viewport.height;
}

export function layoutLabels(items, viewport, options = {}) {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return new Map();

  const out = new Map();

  for (const item of items) {
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
      out.set(item.id, { visible: false, scale: item.scale, dx: 0, dy: 0, slot: -1 });
      continue;
    }

    const rect = rectFor(item, item.scale);
    if (!intersectsViewport(rect, viewport)) {
      out.set(item.id, { visible: false, scale: item.scale, dx: 0, dy: 0, slot: -1 });
      continue;
    }

    out.set(item.id, {
      visible: true,
      scale: item.scale,
      dx: 0,
      dy: 0,
      slot: 0,
    });
  }
  return out;
}

export function forwardWheelToTarget(sourceEvent, target, WheelEventCtor = globalThis.WheelEvent) {
  if (!sourceEvent || !target?.dispatchEvent || typeof WheelEventCtor !== 'function') return false;
  sourceEvent.preventDefault?.();
  sourceEvent.stopPropagation?.();
  const forwarded = new WheelEventCtor('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: sourceEvent.deltaX ?? 0,
    deltaY: sourceEvent.deltaY ?? 0,
    deltaZ: sourceEvent.deltaZ ?? 0,
    deltaMode: sourceEvent.deltaMode ?? 0,
    clientX: sourceEvent.clientX ?? 0,
    clientY: sourceEvent.clientY ?? 0,
    screenX: sourceEvent.screenX ?? 0,
    screenY: sourceEvent.screenY ?? 0,
    ctrlKey: !!sourceEvent.ctrlKey,
    shiftKey: !!sourceEvent.shiftKey,
    altKey: !!sourceEvent.altKey,
    metaKey: !!sourceEvent.metaKey,
  });
  target.dispatchEvent(forwarded);
  return true;
}
