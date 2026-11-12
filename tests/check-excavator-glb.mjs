// Independent GLB inspection + rig verification in three.js (Y-up) axes, no dependencies.
//   node tests/check_glb.mjs output/EX2000_7_SiteNav_v2.glb params.json
import fs from 'node:fs';
import { makeRig, solvePose, shoeTransform } from '../excavator-rig-math.mjs';

const [glbPath, paramsPath] = process.argv.slice(2);
const buf = fs.readFileSync(glbPath);
const jsonLen = buf.readUInt32LE(12);
const gl = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
const R = makeRig(params);
const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// ---------- accessors ----------
const NC = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function readAcc(i) {
  const a = gl.accessors[i], bv = gl.bufferViews[a.bufferView];
  const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0), n = a.count * NC[a.type];
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = buf.readFloatLE(off + 4 * k);
  return out;
}

// ---------- mat4 (column-major) ----------
function compose(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const qz = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const qy = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------- node tree ----------
const nodes = gl.nodes.map((n) => ({ ...n, t: n.translation || [0, 0, 0], q: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1] }));
const byName = Object.fromEntries(nodes.map((n, i) => [n.name, i]));
const parent = {};
nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
const world = (i) => { let m = compose(nodes[i].t, nodes[i].q, nodes[i].s); for (let p = parent[i]; p !== undefined; p = parent[p]) m = mul(compose(nodes[p].t, nodes[p].q, nodes[p].s), m); return m; };
const W = (name, local = [0, 0, 0]) => apply(world(byName[name]), local);
const pathOf = (name) => { const out = []; for (let i = byName[name]; i !== undefined; i = parent[i]) out.unshift(nodes[i].name); return out.join('>'); };

// ---------- structure ----------
const required = ['ROOT', 'UNDERCARRIAGE', 'SLEW', 'UPPER', 'BOOM', 'STICK', 'BUCKET', 'TRACK_L', 'TRACK_R', 'GUIDE_LINK', 'BUCKET_LINK',
  'BOOM_CYL_L_BARREL', 'BOOM_CYL_L_ROD', 'BOOM_CYL_R_BARREL', 'BOOM_CYL_R_ROD', 'ARM_CYL_BARREL', 'ARM_CYL_ROD', 'BUCKET_CYL_BARREL', 'BUCKET_CYL_ROD'];
for (const r of required) ok(r in byName, 'missing node ' + r);
const paths = Object.fromEntries(['UPPER', 'BUCKET', 'BUCKET_CYL_ROD', 'TRACK_L_Shoe_00', 'BOOM_CYL_L_ROD'].map((n) => [n, pathOf(n)]));
ok(paths.BUCKET === 'ROOT>SLEW>BOOM>STICK>BUCKET', 'bad BUCKET path ' + paths.BUCKET);
ok(paths.TRACK_L_Shoe_00 === 'ROOT>UNDERCARRIAGE>TRACK_L>TRACK_L_Shoe_00', 'bad shoe path');

let tris = 0, draws = 0, meshNodes = 0;
const meshUse = {};
for (const n of nodes) if (n.mesh !== undefined) {
  meshNodes++; meshUse[n.mesh] = (meshUse[n.mesh] || 0) + 1;
  for (const p of gl.meshes[n.mesh].primitives) { draws++; tris += gl.accessors[p.indices].count / 3; }
}
const shoeMesh = nodes[byName.TRACK_L_Shoe_00].mesh;

// ---------- rig: rest pose and random poses ----------
function setPose(pose) {
  const s = solvePose(R, pose);
  const set = (name, t, q) => { const n = nodes[byName[name]]; if (t) n.t = t; if (q) n.q = q; };
  set('SLEW', null, qy(s.slew)); set('BOOM', null, qz(s.boom)); set('STICK', null, qz(s.stick)); set('BUCKET', null, qz(s.bucket));
  for (const [nm, c] of [['BOOM_CYL_L', s.boomCylL], ['BOOM_CYL_R', s.boomCylR], ['ARM_CYL', s.armCyl], ['BUCKET_CYL', s.bucketCyl]]) {
    set(nm + '_BARREL', null, qz(c.angle)); set(nm + '_ROD', [c.length, 0, 0], null);
  }
  set('GUIDE_LINK', null, qz(s.guideLink.angle));
  set('BUCKET_LINK', [s.bucketLink.position[0], s.bucketLink.position[1], 0], qz(s.bucketLink.angle));
}
function pinErrors() {
  return Math.max(
    dist(W('BOOM_CYL_L_ROD'), W('PIN_boom_cyl_rod_L')), dist(W('BOOM_CYL_R_ROD'), W('PIN_boom_cyl_rod_R')),
    dist(W('ARM_CYL_ROD'), W('PIN_arm_cyl_rod')), dist(W('BUCKET_CYL_ROD'), W('BUCKET_LINK')),
    dist(W('GUIDE_LINK', [R.lg, 0, 0]), W('BUCKET_LINK')), dist(W('BUCKET_LINK', [R.lb, 0, 0]), W('PIN_bucket_link_pin')));
}
const restErr = pinErrors(); // exported node TRS as-is
let maxErr = 0, rng = 12345;
const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const J = params.joints;
for (let k = 0; k < 500; k++) {
  setPose({ slew: -180 + 360 * rand(), boom: J.boom.min + (J.boom.max - J.boom.min) * rand(), stick: J.stick.min + (J.stick.max - J.stick.min) * rand(), bucket: J.bucket.min + (J.bucket.max - J.bucket.min) * rand() });
  maxErr = Math.max(maxErr, pinErrors());
}
// rod stays inside barrel: overlap at full extension
const strokes = {};
for (const [nm, key] of [['boom', 'boomCylL'], ['arm', 'armCyl'], ['bucket', 'bucketCyl']]) {
  const ds = [];
  for (let i = 0; i <= 100; i++) {
    const p = { boom: J.boom.rest, stick: J.stick.rest, bucket: J.bucket.rest };
    const jn = nm === 'boom' ? 'boom' : nm === 'arm' ? 'stick' : 'bucket';
    p[jn] = J[jn].min + (J[jn].max - J[jn].min) * i / 100;
    ds.push(solvePose(R, p)[key].length);
  }
  strokes[nm] = { min: +Math.min(...ds).toFixed(3), max: +Math.max(...ds).toFixed(3) };
}

// ---------- track shoes at rest vs formula ----------
let shoeErr = 0;
for (const side of ['L', 'R']) for (let i = 0; i < R.track.n; i++) {
  const n = nodes[byName[`TRACK_${side}_Shoe_${String(i).padStart(2, '0')}`]], t = shoeTransform(R, i, 0);
  const q = qz(t.rz), dq = Math.abs(q[2] * n.q[2] + q[3] * n.q[3]);
  shoeErr = Math.max(shoeErr, Math.hypot(n.t[0] - t.x, n.t[1] - t.y, n.t[2]), 1 - dq);
}

// ---------- animations: apply sampled clip values, verify pins and motion range ----------
const anims = {};
for (const a of gl.animations || []) {
  const chans = a.channels.map((c) => ({ node: c.target.node, path: c.target.path, inp: readAcc(a.samplers[c.sampler].input), out: readAcc(a.samplers[c.sampler].output) }));
  const dur = Math.max(...chans.map((c) => c.inp[c.inp.length - 1]));
  let clipErr = 0, motion = 0;
  const base = nodes.map((n) => ({ t: n.t, q: n.q }));
  for (let f = 0; f <= 20; f++) {
    const time = dur * f / 20;
    for (const c of chans) {
      let k = 0; while (k < c.inp.length - 1 && c.inp[k + 1] <= time + 1e-6) k++;
      const w = c.path === 'rotation' ? 4 : 3, v = Array.from(c.out.slice(k * w, k * w + w));
      if (c.path === 'rotation') nodes[c.node].q = v; else if (c.path === 'translation') nodes[c.node].t = v;
    }
    if (a.name === 'Dig' || a.name === 'Slew') clipErr = Math.max(clipErr, pinErrors());
    if (a.name === 'Dig') motion = Math.max(motion, dist(W('BUCKET'), apply(world(byName.BUCKET), [0, 0, 0])) || 0, dist(W('BUCKET'), [9.23, 3.55, 0]));
    if (a.name === 'TrackDrive_OnePitch') motion = Math.max(motion, dist(W('TRACK_L_Shoe_00'), [-R.track.c, 0.14, -params.undercarriage.track_center_y]));
    if (a.name === 'Slew') motion = Math.max(motion, Math.abs(2 * Math.asin(nodes[byName.SLEW].q[1])) * 180 / Math.PI);
  }
  nodes.forEach((n, i) => { n.t = base[i].t; n.q = base[i].q; });
  anims[a.name] = { channels: chans.length, duration_s: +dur.toFixed(3), samples_checked: 21, max_pin_error_m: +clipErr.toExponential(2), motion_metric: +motion.toFixed(3) };
}

const report = {
  glb: glbPath, bytes: buf.length, nodes: nodes.length, mesh_nodes: meshNodes, unique_meshes: gl.meshes.length,
  materials: gl.materials.map((m) => m.name), draw_calls_naive: draws, triangles_rendered: tris,
  shoe_mesh_shared_by_nodes: meshUse[shoeMesh], shoe_mesh_name: gl.meshes[shoeMesh].name, paths,
  rig: { rest_pose_max_pin_error_m: +restErr.toExponential(2), random_500_poses_max_pin_error_m: +maxErr.toExponential(2), shoe_rest_vs_formula_max_err: +shoeErr.toExponential(2), cylinder_length_ranges_m: strokes },
  animations: anims, failures: fail,
};
if (restErr > 1e-3) fail.push('rest pin error ' + restErr);
if (maxErr > 1e-3) fail.push('pose pin error ' + maxErr);
if (shoeErr > 1e-3) fail.push('shoe error ' + shoeErr);
for (const [k, v] of Object.entries(anims)) if (v.max_pin_error_m > 2e-3) fail.push(`clip ${k} pin error ${v.max_pin_error_m}`);
console.log(JSON.stringify(report, null, 1));
process.exit(fail.length ? 1 : 0);
