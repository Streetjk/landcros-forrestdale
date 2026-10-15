// Choose a safe, unambiguous camera target for a shared-scene deep link.
// Never guess among multiple custom labels, or focus unpublished/other scenes.
export function singleSharedSceneLabelPosition(objects) {
  if (!Array.isArray(objects)) return null;
  let selected = null;
  for (const obj of objects) {
    if (obj?.kind !== 'label' || typeof obj.id !== 'string' || !obj.id) continue;
    const position = obj?.transform?.position;
    if (!Array.isArray(position) || position.length !== 3
        || !position.every(v => typeof v === 'number' && Number.isFinite(v)
          && Math.abs(v) <= 200)) continue;
    if (selected) return null;
    selected = {id:obj.id,x:position[0],y:position[1],z:position[2]};
  }
  return selected;
}
