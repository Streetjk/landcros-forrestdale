// Shared scene pin presentation for editor and viewer.
export function createSceneLabelPin(title, onActivate) {
  const root = document.createElement('div');
  root.className = 'scene-location-pin';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scene-location-pin__button';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 30 42');
  svg.setAttribute('class', 'scene-location-pin__icon');
  svg.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  outline.setAttribute('d', 'M15 1C7.8 1 2 6.8 2 14c0 10.6 13 26 13 26s13-15.4 13-26C28 6.8 22.2 1 15 1Z');
  outline.setAttribute('fill', '#2563eb');
  outline.setAttribute('stroke', '#fff');
  outline.setAttribute('stroke-width', '2');
  svg.appendChild(outline);
  const hole = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hole.setAttribute('cx', '15');
  hole.setAttribute('cy', '14');
  hole.setAttribute('r', '5');
  hole.setAttribute('fill', '#fff');
  svg.appendChild(hole);
  const caption = document.createElement('span');
  caption.className = 'scene-location-pin__caption';
  button.append(svg, caption);
  root.appendChild(button);
  const setTitle = text => {
    caption.textContent = String(text ?? '');
    button.setAttribute('aria-label', 'Show details: ' + String(text ?? ''));
    button.title = String(text ?? '');
  };
  setTitle(title);
  button.addEventListener('pointerup', event => {
    event.stopPropagation();
    event.preventDefault();
    onActivate?.();
  });
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (event.detail === 0) onActivate?.();
  });
  return { root, setTitle, button };
}


// Matches the existing SiteNav _addPinToScene floor frame, including its
// ground clearance and pulsing animation API. Shared by scene editor/viewer.
export const SCENE_PIN_FLOAT_HEIGHT = 1.3;

export function createSceneGroundFrame(THREE, color = 0x2563eb) {
  const half = 0.455;
  const lineWidth = 0.12;
  const thickness = 0.01;
  const material = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85,
    depthTest: false, depthWrite: false,
  });
  const group = new THREE.Group();
  group.name = 'scene-pin-ground-frame';
  for (const [x, z, width, depth] of [
    [0, -half, half * 2 + lineWidth, lineWidth],
    [0,  half, half * 2 + lineWidth, lineWidth],
    [-half, 0, lineWidth, half * 2 - lineWidth],
    [ half, 0, lineWidth, half * 2 - lineWidth],
  ]) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(width, thickness, depth), material,
    );
    strip.position.set(x, 0.05, z);
    strip.renderOrder = 999;
    group.add(strip);
  }
  return {
    group, material,
    setSelected(selected) { material.color.setHex(selected ? 0xffcc00 : color); },
    dispose() {
      group.children.forEach(child => child.geometry.dispose());
      material.dispose();
      group.parent?.remove(group);
    },
  };
}
