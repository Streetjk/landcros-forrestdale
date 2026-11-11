// Presentation-only map reframe for the mobile details drawer. This adjusts
// the projection's visible centre, not the actual camera/orbit pose.
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function mobileCameraFraming({
  stage = 'closed', viewportWidth = 0, viewportHeight = 0,
  panelHeight = 0, panelWidth = 0, bottomInset = 0,
  landscape = false, focusScreenX = null, focusScreenY = null,
} = {}) {
  const width = Number(viewportWidth), height = Number(viewportHeight);
  if (!['summary','full'].includes(stage) || !(width > 0 && height > 0)) return {x:0,y:0};

  if (landscape) {
    const blocked = clamp(Number(panelWidth) || 0, 0, width * 0.85);
    const base = clamp((blocked + 48) / 2, 0, width * 0.43);
    const safeLeft = 28;
    const safeRight = Math.max(safeLeft + 18, width - blocked - 28);
    const offset = Number.isFinite(focusScreenX)
      ? clamp(Math.max(base, focusScreenX - safeRight), 0,
          Math.max(0, Math.min(width * 0.43, focusScreenX - safeLeft)))
      : base;
    return {x:Math.round(offset),y:0};
  }

  const blocked = clamp((Number(panelHeight) || 0) + (Number(bottomInset) || 0), 0, height * 0.92);
  const controls = stage === 'full' ? 0 : Math.min(64, height * 0.1);
  const base = clamp((blocked + controls) / 2, 0, height * 0.43);
  const safeTop = clamp(height * 0.12, 90, Math.max(90, height * 0.22));
  const safeBottom = Math.max(safeTop + 18, height - blocked - controls - 18);
  const offset = Number.isFinite(focusScreenY)
    ? clamp(Math.max(base, focusScreenY - safeBottom), 0,
        Math.max(0, Math.min(height * 0.43, focusScreenY - safeTop)))
    : base;
  return {x:0,y:Math.round(offset)};
}
