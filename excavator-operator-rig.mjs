// EX2000-7 SiteNav v7 operator control helper (reference implementation for output/operator_rig_contract_v7.json).
// Dependency-free: works on three.js Object3D nodes (uses only obj.quaternion.set(x, y, z, w)).
//   import { makeOperatorRig } from './operator_rig_v7.mjs';
//   const rig = makeOperatorRig(gltf.scene, contract);           // once, after GLTFLoader
//   rig.apply({ joyL: { fb: 0, lr: s }, joyR: { fb: 0, lr: 0 }, travelL: t, travelR: t });  // per frame, values -1..1
//   rig.reset();                                                // neutral (pause/replay)
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qaxis = (ax, ang) => { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; };
function qpow(d, t) {  // slerp(identity, d, t), shortest arc
  let [x, y, z, w] = d; if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const a = Math.acos(Math.min(1, w)), s = Math.sin(a);
  if (s < 1e-9) return [0, 0, 0, 1];
  const k = Math.sin(a * t) / s;
  return [x * k, y * k, z * k, Math.cos(a * t)];
}
const clamp = (v) => Math.max(-1, Math.min(1, +v || 0));

export function makeOperatorRig(root, contract) {
  const find = (n) => { const o = root.getObjectByName(n); if (!o) throw new Error('missing node ' + n); return o; };
  const C = contract.controls, D = contract.hand_follow.deltas, B = contract.operator.bones;
  const nodes = {}, neutral = {};
  for (const n of [...Object.keys(B), ...Object.keys(C)]) { nodes[n] = find(n); neutral[n] = (B[n] || C[n]).rotation_xyzw; }
  const rad = Math.PI / 180;
  const set = (n, q) => nodes[n].quaternion.set(q[0], q[1], q[2], q[3]);
  function apply(s = {}) {
    for (const side of ['L', 'R']) {
      const j = s['joy' + side] || {}, fb = clamp(j.fb), lr = clamp(j.lr), t = clamp(s['travel' + side]);
      const jr = C['CAB_JOY_' + side].axes.fwd_back.range_deg * rad;
      set('CAB_JOY_' + side, qmul(qmul(neutral['CAB_JOY_' + side], qaxis([0, 0, 1], -fb * jr)), qaxis([1, 0, 0], lr * jr)));
      for (const b of ['OP_UpperArm_', 'OP_LowerArm_', 'OP_Hand_'].map((p) => p + side)) {
        let q = neutral[b];
        if (fb) q = qmul(q, qpow(D[side][fb > 0 ? 'fwd' : 'back'][b], Math.abs(fb)));
        if (lr) q = qmul(q, qpow(D[side][lr > 0 ? 'right' : 'left'][b], Math.abs(lr)));
        set(b, q);
      }
      const tr = C['CAB_TRAVEL_' + side].axis.range_deg * rad;
      set('CAB_TRAVEL_' + side, qmul(neutral['CAB_TRAVEL_' + side], qaxis([0, 0, 1], -t * tr)));
      const f = 'OP_Foot_' + side;
      set(f, t ? qmul(neutral[f], qpow(D[side][t > 0 ? 'travel_fwd' : 'travel_back'][f], Math.abs(t))) : neutral[f]);
    }
  }
  return { apply, reset: () => apply({}), nodes };
}
