// User-visible HTML labels are hit-tested only after a genuine tap on the
// WebGL canvas. Pointer/touch gestures themselves always belong to OrbitControls.
// This pure module contains no DOM listeners, network requests or mutations.
export function isWithinTapRect(x, y, rect, padding = 0) {
  if (![x,y,rect?.left,rect?.right,rect?.top,rect?.bottom].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left-padding && x <= rect.right+padding &&
         y >= rect.top-padding && y <= rect.bottom+padding;
}

export function isVisibleTapTarget(element) {
  if (!element?.isConnected) return false;
  if (element.closest?.('[hidden]')) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' &&
    Number(style.opacity || 1) > 0;
}

export function isTouchMapDevice(win = window, navigatorLike = navigator) {
  return !!(win?.matchMedia?.('(any-pointer: coarse), (pointer: coarse)')?.matches ||
    navigatorLike?.maxTouchPoints > 0);
}

export function findLabelAtTap(entries, x, y) {
  const candidates = [];
  for(const entry of entries) {
    if (!entry?.activate || !Array.isArray(entry?.elements)) continue;
    for(const el of entry.elements) {
      if (!isVisibleTapTarget(el)) continue;
      const rect = el.getBoundingClientRect();
      if (!isWithinTapRect(x,y,rect,entry.padding ?? 0)) continue;
      const cx=(rect.left+rect.right)/2;
      const cy=(rect.top+rect.bottom)/2;
      // Prioritise visually foreground labels and the closest painted centre.
      const distance=Math.hypot(x-cx,y-cy);
      candidates.push({entry,distance});
      break;
    }
  }
  candidates.sort((a,b) => (b.entry.priority??0)-(a.entry.priority??0) ||
    a.distance-b.distance);
  return candidates[0]?.entry || null;
}
