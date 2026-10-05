// Screen-space visibility helpers for public SiteNav labels.
// Building labels stay at their designed world-space anchors. We never move a
// label to another screen position to avoid an edge or collision; lower-priority
// labels simply hide until their designed position can be shown cleanly.

export function labelScaleForZoom(zoom) {
  const z = Number.isFinite(zoom) ? Math.max(0, zoom) : 26;
  if (z <= 18) return 0.66;
  if (z <= 42) return 0.66 - ((z - 18) / 24) * 0.12;
  if (z <= 58) return 0.54;
  return Math.max(0.44, 0.54 - ((z - 58) / 22) * 0.10);
}

function overlaps(a, b, gap) {
  return !(
    a.right + gap <= b.left ||
    a.left >= b.right + gap ||
    a.bottom + gap <= b.top ||
    a.top >= b.bottom + gap
  );
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

function inside(rect, viewport, margin) {
  return rect.left >= margin &&
    rect.top >= margin &&
    rect.right <= viewport.width - margin &&
    rect.bottom <= viewport.height - margin;
}

export function layoutLabels(items, viewport, options = {}) {
  const gap = Number.isFinite(options.gap) ? options.gap : 7;
  const margin = Number.isFinite(options.margin) ? options.margin : 8;
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return new Map();

  const placed = [];
  const out = new Map();
  const sorted = [...items].sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  );

  for (const item of sorted) {
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y) ||
        item.x < -100 || item.y < -100 ||
        item.x > viewport.width + 100 || item.y > viewport.height + 100) {
      out.set(item.id, { visible: false, scale: item.scale, dx: 0, dy: 0, slot: -1 });
      continue;
    }

    const rect = rectFor(item, item.scale);
    const blocked = !inside(rect, viewport, margin) ||
      placed.some(p => overlaps(rect, p.rect, gap));

    if (blocked) {
      out.set(item.id, { visible: false, scale: item.scale, dx: 0, dy: 0, slot: -1 });
      continue;
    }

    placed.push({ id: item.id, rect });
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
