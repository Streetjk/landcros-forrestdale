/**
 * Reversible, conservative SiteNav Gaussian ground smoothing.
 *
 * Use the scene transform to identify near-ground splats, leave cohesive
 * elevated structures intact, and lower ONLY ground points protruding above
 * the existing satellite-textured flat plane.
 *
 * Records not selected are copied byte-for-byte. The source files are never
 * overwritten and no external dependencies are required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STRIDE = 32;
const CELL = 0.5;
const MIN_Y = 0.12;
const MAX_Y = 0.42;
const key = (x,z) => `${x},${z}`;
const cell = v => Math.floor(v/CELL);
const quantile = (sorted, fraction) => sorted[Math.min(sorted.length-1,Math.floor(fraction*(sorted.length-1)))];
const sha = buf => createHash('sha256').update(buf).digest('hex');

export function smoothGroundSplat(input, settings) {
  if (!(input instanceof Uint8Array) || input.length===0 || input.length%STRIDE) {
    throw new Error('Input must be a nonempty, 32-byte-aligned Gaussian .splat buffer');
  }
  const rot=settings?.splat?.rotation, offset=settings?.splat?.centerOffset, norm=settings?.splat?.normalization;
  if (!Array.isArray(rot)||rot.length!==3||!rot.every(Number.isFinite)||
      !Array.isArray(offset)||offset.length!==3||!offset.every(Number.isFinite)||
      !norm||!Array.isArray(norm.center)||norm.center.length!==3||
      !norm.center.every(Number.isFinite)||!Number.isFinite(norm.scale)||norm.scale<=0) {
    throw new Error('Valid splat rotation, centerOffset and fixed normalization required');
  }
  const [a,b,c]=rot, [cx,,cz]=norm.center, [ox,oy,oz]=offset, S=norm.scale;
  const sa=Math.sin(a), ca=Math.cos(a), sb=Math.sin(b), cb=Math.cos(b), sc=Math.sin(c), cc=Math.cos(c);
  const rX=[cb*cc,-cb*sc,sb];
  const rY=[ca*sc+sa*sb*cc,ca*cc-sa*sb*sc,-sa*cb];
  const rZ=[sa*sc-ca*sb*cc,sa*cc+ca*sb*sc,ca*cb];
  if (Math.abs(rY[1])<0.5) throw new Error('Vertical model axis is insufficiently aligned to world-up for safe smoothing');

  const n=input.length/STRIDE, dat=new DataView(input.buffer,input.byteOffset,input.byteLength);
  const pts=new Array(n), bins=new Map();
  for(let i=0;i<n;i++){
    const o=i*STRIDE;
    const x=dat.getFloat32(o,true),y=dat.getFloat32(o+4,true),z=dat.getFloat32(o+8,true);
    const sx=dat.getFloat32(o+12,true),sy=dat.getFloat32(o+16,true),sz=dat.getFloat32(o+20,true);
    if(![x,y,z,sx,sy,sz].every(Number.isFinite)) throw new Error('Nonfinite Gaussian at '+i);
    const X=S*(rX[0]*x+rX[1]*y+rX[2]*z)-cx*S+ox;
    const Y=S*(rY[0]*x+rY[1]*y+rY[2]*z)+oy;
    const Z=S*(rZ[0]*x+rZ[1]*y+rZ[2]*z)+cz*S+oz;
    const ix=cell(X),iz=cell(Z),opacity=input[o+27];
    pts[i]={ix,iz,x,y,z,sx,sy,sz,Y,opacity};
    if(opacity>=24){
      const k=key(ix,iz);if(!bins.has(k)) bins.set(k,[]);
      bins.get(k).push(Y);
    }
  }

  // Each coherent elevated region (roof, wall, equipment stockpile) and one
  // neighbouring cell is excluded. This guards against flattening facades.
  const structure=new Set();
  for(const [k,heights] of bins){
    if(heights.length<8)continue;
    heights.sort((x,y)=>x-y);
    if (quantile(heights,.5)>.50 ||
       (quantile(heights,.60)>.33&&quantile(heights,.85)>.47&&heights.length>16)) {
      structure.add(k);
    }
  }
  const protectedCells=new Set();
  for(const k of structure){
    const [ix,iz]=k.split(',').map(Number);
    for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)protectedCells.add(key(ix+dx,iz+dz));
  }

  const out=Buffer.from(input);
  const dst=new DataView(out.buffer,out.byteOffset,out.byteLength);
  let moved=0,clamped=0,displacement=0,protectedCount=0;
  for(let i=0;i<n;i++){
    const p=pts[i],o=i*STRIDE;
    if(protectedCells.has(key(p.ix,p.iz))) { protectedCount++;continue; }
    // Never raise a previously hidden/below-ground Gaussian into view.
    // Never alter roof, tall machinery, or other points beyond the low layer.
    if(p.opacity<=1||p.Y<MIN_Y||p.Y>MAX_Y)continue;
    const newY=Math.min(p.Y,.048+Math.min(.018,(p.Y-MIN_Y)*.09));
    if(newY<p.Y-.025){
      const newLocalY=((newY-oy)/S-rY[0]*p.x-rY[2]*p.z)/rY[1];
      dst.setFloat32(o+4,newLocalY,true);
      moved++;
      displacement+=p.Y-newY;
    }
    // An elongated floor Gaussian can still protrude above the plane even
    // with a flattened centre. Conservatively bound its vertical sigma.
    let [qr,qx,qy,qz]=Array.from(input.subarray(o+28,o+32),u=>(u-128)/128);
    const qn=Math.hypot(qr,qx,qy,qz)||1;
    qr/=qn;qx/=qn;qy/=qn;qz/=qn;
    const v0=(1-2*qy*qy-2*qz*qz)*rY[0]+(2*qx*qy+2*qr*qz)*rY[1]+(2*qx*qz-2*qr*qy)*rY[2];
    const v1=(2*qx*qy-2*qr*qz)*rY[0]+(1-2*qx*qx-2*qz*qz)*rY[1]+(2*qy*qz+2*qr*qx)*rY[2];
    const v2=(2*qx*qz+2*qr*qy)*rY[0]+(2*qy*qz-2*qr*qx)*rY[1]+(1-2*qx*qx-2*qy*qy)*rY[2];
    const sigma=S*Math.hypot(p.sx*v0,p.sy*v1,p.sz*v2);
    if(sigma>.070){
      const factor=Math.max(.25,.070/sigma);
      dst.setFloat32(o+12,p.sx*factor,true);
      dst.setFloat32(o+16,p.sy*factor,true);
      dst.setFloat32(o+20,p.sz*factor,true);
      clamped++;
    }
  }
  if(moved/n>.30) throw new Error('Safety cap exceeded: would move over 30% of the scene');
  return { buffer:out, report:{inputRecords:n,outputRecords:n,moved,clamped,
    protectedCount,averageDownShift:moved? +(displacement/moved).toFixed(5):0,
    inputBytes:input.length,outputBytes:out.length,sourceSha256:sha(input),outputSha256:sha(out)} };
}

function run(args){
  if(args.length!==3)throw new Error('Usage: node scripts/smooth-ground-splat.mjs <source.splat> <new-output.splat> <site-config.json>');
  const [source,dest,configPath]=args.map(f=>path.resolve(f));
  if(source===dest||fs.existsSync(dest)&&fs.realpathSync(source)===fs.realpathSync(dest))
    throw new Error('Source and output cannot be the same file');
  const data=fs.readFileSync(source),cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const {buffer,report}=smoothGroundSplat(data,cfg);
  const tmp=dest+'.tmp-'+process.pid;
  try{fs.writeFileSync(tmp,buffer);fs.renameSync(tmp,dest)}
  finally{try{fs.unlinkSync(tmp)}catch{}}
  console.log(JSON.stringify({...report,source:path.basename(source),output:path.basename(dest)},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{run(process.argv.slice(2));}catch(e){console.error(e.message);process.exitCode=1}
}
