// three.js adapter (not executed in this workspace -- no three.js installed; maths verified via tests/check_glb.mjs).
//   import { ExcavatorRig } from './ExcavatorRig.js';
//   const rig = new ExcavatorRig(gltf.scene, params /* params.json */, { instanceShoes: true });
//   rig.setPose({ slew: 30, boom: 20, stick: -110, bucket: 10 }); rig.drive(distanceMetresLeft, distanceMetresRight);
import * as THREE from 'three';
import { makeRig, solvePose, shoeTransform, wheelAngle } from './excavator-rig-math.mjs';

export class ExcavatorRig {
  constructor(root, params, { instanceShoes = true } = {}) {
    this.R = makeRig(params);
    this.n = (name) => { const o = root.getObjectByName(name); if (!o) throw new Error('missing node ' + name); return o; };
    for (const k of ['SLEW', 'BOOM', 'STICK', 'BUCKET', 'GUIDE_LINK', 'BUCKET_LINK', 'BOOM_CYL_L_BARREL', 'BOOM_CYL_L_ROD',
      'BOOM_CYL_R_BARREL', 'BOOM_CYL_R_ROD', 'ARM_CYL_BARREL', 'ARM_CYL_ROD', 'BUCKET_CYL_BARREL', 'BUCKET_CYL_ROD',
      'TRACK_L', 'TRACK_R', 'SPROCKET_L', 'SPROCKET_R', 'IDLER_L', 'IDLER_R']) this[k] = this.n(k);
    this.phase = { L: 0, R: 0 };
    this.instanced = {};
    if (instanceShoes) {
      for (const side of ['L', 'R']) {
        const track = this[`TRACK_${side}`];
        const shoes = [...track.children].filter((c) => c.name.includes('_Shoe_'));
        const proto = shoes[0];
        const parts = proto.isMesh ? [proto] : proto.children.filter((c) => c.isMesh); // multi-material -> group of meshes
        const ims = parts.map((m) => new THREE.InstancedMesh(m.geometry, m.material, shoes.length));
        ims.forEach((im) => track.add(im));
        shoes.forEach((s) => track.remove(s));
        this.instanced[side] = ims;
      }
    }
    this.setPose({});
    this.drive(0, 0);
  }

  setPose(pose) {
    const s = solvePose(this.R, pose);
    this.SLEW.rotation.set(0, s.slew, 0);
    this.BOOM.rotation.set(0, 0, s.boom);
    this.STICK.rotation.set(0, 0, s.stick);
    this.BUCKET.rotation.set(0, 0, s.bucket);
    for (const [node, c] of [['BOOM_CYL_L', s.boomCylL], ['BOOM_CYL_R', s.boomCylR], ['ARM_CYL', s.armCyl], ['BUCKET_CYL', s.bucketCyl]]) {
      this[node + '_BARREL'].rotation.set(0, 0, c.angle);
      this[node + '_ROD'].position.set(c.length, 0, 0);
    }
    this.GUIDE_LINK.rotation.set(0, 0, s.guideLink.angle);
    this.BUCKET_LINK.position.set(s.bucketLink.position[0], s.bucketLink.position[1], 0);
    this.BUCKET_LINK.rotation.set(0, 0, s.bucketLink.angle);
    return s;
  }

  /** advance each track by travelled ground distance (m, +forward). Chain phase moves opposite to travel. */
  drive(dL, dR) {
    this.phase.L -= dL; this.phase.R -= dR;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), z = new THREE.Vector3(0, 0, 1), one = new THREE.Vector3(1, 1, 1);
    for (const side of ['L', 'R']) {
      const ph = this.phase[side];
      this[`SPROCKET_${side}`].rotation.set(0, 0, wheelAngle(this.R, ph));
      this[`IDLER_${side}`].rotation.set(0, 0, wheelAngle(this.R, ph));
      const ims = this.instanced[side];
      for (let i = 0; i < this.R.track.n; i++) {
        const t = shoeTransform(this.R, i, ph);
        if (ims) {
          m.compose(new THREE.Vector3(t.x, t.y, 0), q.setFromAxisAngle(z, t.rz), one);
          ims.forEach((im) => im.setMatrixAt(i, m));
        } else {
          const o = this.n(`TRACK_${side}_Shoe_${String(i).padStart(2, '0')}`);
          o.position.set(t.x, t.y, 0); o.rotation.set(0, 0, t.rz);
        }
      }
      if (ims) ims.forEach((im) => { im.instanceMatrix.needsUpdate = true; });
    }
  }
}
