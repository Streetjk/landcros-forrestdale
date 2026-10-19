// Pointer-based zoom/pan for scene pin photos. No global pointer handlers:
// gestures stay inside the photo, so they cannot rotate the 3D camera.
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

export function createPhotoZoom(image, { label = 'Photo' } = {}) {
  if (!image || image.tagName !== 'IMG') throw new TypeError('An image is required');

  const viewport = document.createElement('div');
  viewport.className = 'sn-photo-zoom';
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', label + ': pinch or scroll to zoom, drag to pan');
  viewport.tabIndex = 0;
  image.classList.add('sn-photo-zoom-image');
  image.draggable = false;
  viewport.appendChild(image);

  const buttons = document.createElement('div');
  buttons.className = 'sn-photo-zoom-controls';
  const makeButton = (symbol, title, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = symbol;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('pointerdown', event => event.stopPropagation());
    button.addEventListener('click', event => { event.stopPropagation(); action(); });
    buttons.appendChild(button);
    return button;
  };

  const pointers = new Map();
  let zoom = 1;
  let x = 0;
  let y = 0;

  function bounds(scale) {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const naturalWidth = image.naturalWidth || width;
    const naturalHeight = image.naturalHeight || height;
    if (!width || !height) return { x: 0, y: 0 };
    const fit = Math.min(width / naturalWidth, height / naturalHeight);
    const renderedWidth = naturalWidth * fit * scale;
    const renderedHeight = naturalHeight * fit * scale;
    return {
      x: Math.max(0, (renderedWidth - width) / 2),
      y: Math.max(0, (renderedHeight - height) / 2),
    };
  }

  function paint() {
    const b = bounds(zoom);
    x = Math.max(-b.x, Math.min(b.x, x));
    y = Math.max(-b.y, Math.min(b.y, y));
    // Translate before scaling: x/y remain screen-space pixels.
    image.style.transform = `translate3d(${x}px,${y}px,0) scale(${zoom})`;
    viewport.classList.toggle('sn-photo-zoomed', zoom > 1.001);
    viewport.dataset.zoom = zoom.toFixed(2);
  }

  function reset() {
    zoom = 1;
    x = 0;
    y = 0;
    pointers.clear();
    paint();
  }

  function zoomAt(targetZoom, px = 0, py = 0) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
    if (Math.abs(next - zoom) < 0.00001) return;
    const ratio = next / zoom;
    x = px - (px - x) * ratio;
    y = py - (py - y) * ratio;
    zoom = next;
    paint();
  }

  function localPoint(event) {
    const box = viewport.getBoundingClientRect();
    return { x: event.clientX - box.left - box.width / 2,
             y: event.clientY - box.top - box.height / 2 };
  }

  const points = () => [...pointers.values()];
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function pointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pointers.set(event.pointerId, localPoint(event));
    viewport.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    const before = points();
    const current = localPoint(event);
    pointers.set(event.pointerId, current);
    const after = points();

    if (before.length === 1 && zoom > 1) {
      x += current.x - before[0].x;
      y += current.y - before[0].y;
      paint();
    } else if (before.length >= 2) {
      const oldMid = midpoint(before[0], before[1]);
      const newMid = midpoint(after[0], after[1]);
      const oldDistance = distance(before[0], before[1]);
      const factor = oldDistance > 0 ? distance(after[0], after[1]) / oldDistance : 1;
      zoomAt(zoom * factor, oldMid.x, oldMid.y);
      x += newMid.x - oldMid.x;
      y += newMid.y - oldMid.y;
      paint();
    }
  }

  function pointerUp(event) {
    if (!pointers.has(event.pointerId)) return;
    event.stopPropagation();
    pointers.delete(event.pointerId);
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  }

  function wheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const p = localPoint(event);
    // Mouse wheels and trackpad pinch (ctrl+wheel) use the same focal point.
    const units = event.deltaMode === 1 ? event.deltaY * 16 :
                  event.deltaMode === 2 ? event.deltaY * viewport.clientHeight : event.deltaY;
    zoomAt(zoom * Math.exp(-units * 0.0018), p.x, p.y);
  }

  function doubleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const p = localPoint(event);
    if (zoom > 1.05) reset();
    else zoomAt(2, p.x, p.y);
  }

  function keyboard(event) {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault(); zoomAt(zoom * 1.25);
    } else if (event.key === '-') {
      event.preventDefault(); zoomAt(zoom / 1.25);
    } else if (event.key === '0' || event.key === 'Escape') {
      event.preventDefault(); reset();
    } else return;
    event.stopPropagation();
  }

  makeButton('+', 'Zoom in', () => zoomAt(zoom * 1.4));
  makeButton('−', 'Zoom out', () => zoomAt(zoom / 1.4));
  makeButton('1:1', 'Reset photo zoom', reset);

  viewport.addEventListener('pointerdown', pointerDown);
  viewport.addEventListener('pointermove', pointerMove);
  viewport.addEventListener('pointerup', pointerUp);
  viewport.addEventListener('pointercancel', pointerUp);
  viewport.addEventListener('lostpointercapture', pointerUp);
  viewport.addEventListener('wheel', wheel, { passive: false });
  viewport.addEventListener('dblclick', doubleClick);
  viewport.addEventListener('keydown', keyboard);
  image.addEventListener('load', paint);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(paint) : null;
  observer?.observe(viewport);

  function destroy() {
    observer?.disconnect();
    viewport.removeEventListener('pointerdown', pointerDown);
    viewport.removeEventListener('pointermove', pointerMove);
    viewport.removeEventListener('pointerup', pointerUp);
    viewport.removeEventListener('pointercancel', pointerUp);
    viewport.removeEventListener('lostpointercapture', pointerUp);
    viewport.removeEventListener('wheel', wheel);
    viewport.removeEventListener('dblclick', doubleClick);
    viewport.removeEventListener('keydown', keyboard);
    image.removeEventListener('load', paint);
    pointers.clear();
    buttons.replaceChildren();
    image.style.transform = '';
  }

  // Controls intentionally live outside the clipped viewport so they remain
  // usable while the photo is enlarged or panned.
  const container = document.createElement('div');
  container.className = 'sn-photo-zoom-container';
  container.append(viewport, buttons);
  paint();
  return { container, viewport, reset, zoomAt, destroy, get zoom() { return zoom; } };
}
