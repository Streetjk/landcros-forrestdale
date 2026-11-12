// Dependency-free rig maths for EX2000_7_SiteNav_v2.glb (three.js axes: Y up, +X forward, +Z machine right).
// Same equations as build_excavator.py; verified against the GLB by tests/check_glb.mjs.
// All pitch-plane 2-D points are (x, y) in the parent node's local frame (== blender (x, z)).

const D2R = Math.PI / 180;
const rot2 = (p, deg) => { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const p2 = (blenderPin) => [blenderPin[0], blenderPin[2]];

export function makeRig(params) {
  const pn = params.pins, uc = params.undercarriage, tp = uc.track_path;
  const perim = 4 * tp.c + 2 * Math.PI * tp.r;
  return {
    params,
    foot: p2(pn.SLEW.boom_foot),
    boomCylBase: { L: p2(pn.SLEW.boom_cyl_base_L), R: p2(pn.SLEW.boom_cyl_base_R) },
    boomCylRod: { L: p2(pn.BOOM.boom_cyl_rod_L), R: p2(pn.BOOM.boom_cyl_rod_R) },
    boomTip: p2(pn.BOOM.boom_tip),
    armCylBase: p2(pn.BOOM.arm_cyl_base),
    armCylRod: p2(pn.STICK.arm_cyl_rod),
    bucketPin: p2(pn.STICK.bucket_pin),
    bucketCylBase: p2(pn.STICK.bucket_cyl_base),
    guidePivot: p2(pn.STICK.guide_link_pivot),
    bucketLinkPin: p2(pn.BUCKET.bucket_link_pin),
    lg: params.linkage.guide_link_length, lb: params.linkage.bucket_link_length, side: params.linkage.solution_side,
    joints: params.joints,
    track: { c: tp.c, r: tp.r, perim, n: uc.shoes_per_side, pitch: perim / uc.shoes_per_side },
  };
}

function circleIntersect(G, lg, B, lb, side) {
  const d = sub(B, G), D = Math.hypot(d[0], d[1]);
  if (D > lg + lb || D < Math.abs(lg - lb) || D < 1e-9) throw new Error(`H-link unreachable D=${D}`);
  const a = (lg * lg - lb * lb + D * D) / (2 * D), h = Math.sqrt(Math.max(lg * lg - a * a, 0));
  const e = [d[0] / D, d[1] / D], perp = [-e[1], e[0]];
  return [G[0] + e[0] * a + perp[0] * h * side, G[1] + e[1] * a + perp[1] * h * side];
}
const cyl = (base, end) => { const d = sub(end, base); return { angle: Math.atan2(d[1], d[0]), length: Math.hypot(d[0], d[1]) }; };
export const clamp = (v, j) => Math.min(j.max, Math.max(j.min, v));

/** pose in degrees: {slew, boom, stick, bucket}. Returns radians for node.rotation and rod offsets. */
export function solvePose(R, pose) {
  const j = R.joints;
  const boom = clamp(pose.boom ?? j.boom.rest, j.boom), stick = clamp(pose.stick ?? j.stick.rest, j.stick);
  const bucket = clamp(pose.bucket ?? j.bucket.rest, j.bucket), slew = pose.slew ?? 0;
  const out = { slew: slew * D2R, boom: boom * D2R, stick: stick * D2R, bucket: bucket * D2R };
  for (const s of ["L", "R"]) out["boomCyl" + s] = cyl(R.boomCylBase[s], add(R.foot, rot2(R.boomCylRod[s], boom)));
  out.armCyl = cyl(R.armCylBase, add(R.boomTip, rot2(R.armCylRod, stick)));
  const Bl = add(R.bucketPin, rot2(R.bucketLinkPin, bucket));
  const J = circleIntersect(R.guidePivot, R.lg, Bl, R.lb, R.side);
  out.bucketCyl = cyl(R.bucketCylBase, J);
  out.guideLink = { angle: cyl(R.guidePivot, J).angle };
  out.bucketLink = { position: J, angle: cyl(J, Bl).angle };
  return out;
}

/** Shoe i transform in its TRACK_L / TRACK_R node: position (x, y) and rotation.z (radians). */
export function shoeTransform(R, i, phase) {
  const { c, r, perim, pitch } = R.track;
  let s = (((i * pitch + phase) % perim) + perim) % perim;
  const L = 2 * c, A = Math.PI * r;
  if (s < L) return { x: -c + s, y: -r, rz: 0 };
  s -= L;
  if (s < A) { const th = -Math.PI / 2 + s / r; return { x: c + r * Math.cos(th), y: r * Math.sin(th), rz: th + Math.PI / 2 }; }
  s -= A;
  if (s < L) return { x: c - s, y: r, rz: Math.PI };
  s -= L;
  const th = Math.PI / 2 + s / r;
  return { x: -c + r * Math.cos(th), y: r * Math.sin(th), rz: th + Math.PI / 2 };
}
/** sprocket / idler rotation.z for a given chain phase (both wheels have pitch radius = track r) */
export const wheelAngle = (R, phase) => phase / R.track.r;
