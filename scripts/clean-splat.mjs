/**
 * Conservative, deterministic Forrestdale .splat cleanup.
 *
 * The native format has fixed 32-byte Gaussian records:
 * xyz 3x float32, scale 3x float32, colour RGBA 4x byte, rotation 4x byte.
 * Preserves the exact bytes and original sort order of every surviving record.
 * Does not alter geometry, GPS alignment, or source data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const STRIDE = 32;
const BIN_SIZE = 0.025;
const posKey = (x,y,z) => `${x},${y},${z}`;
const cellAt = v => Math.floor(v / BIN_SIZE);

export function cleanSplatBuffer(input, { maxRemovalRatio = 0.10 } = {}) {
  if (!(input instanceof Uint8Array) || !input.length || input.length % STRIDE) {
    throw new Error('Input must be nonempty Uint8Array with 32-byte Gaussian records');
  }
  const n = input.length / STRIDE;
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const positions = new Float32Array(n * 3);
  const scales = new Float32Array(n * 2);
  const valid = new Uint8Array(n);
  const occupancy = new Map();
  const bounds = [[Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity]];

  for (let i=0;i<n;i++) {
    const o=i*STRIDE, x=dv.getFloat32(o,true),y=dv.getFloat32(o+4,true),z=dv.getFloat32(o+8,true);
    const s0=dv.getFloat32(o+12,true),s1=dv.getFloat32(o+16,true),s2=dv.getFloat32(o+20,true);
    positions.set([x,y,z],i*3);
    const components=[s0,s1,s2].map(Math.abs);
    const largest=Math.max(...components),smallest=Math.min(...components);
    scales[i*2]=largest;scales[i*2+1]=largest/Math.max(smallest,0.00001);
    const healthy=[x,y,z,s0,s1,s2].every(Number.isFinite) && largest>=0 && largest<10;
    valid[i]=healthy?1:0;
    if(!healthy)continue;
    for(let k=0;k<3;k++){bounds[k][0]=Math.min(bounds[k][0],positions[i*3+k]);bounds[k][1]=Math.max(bounds[k][1],positions[i*3+k]);}
    if(input[o+27]>12){
      const key=posKey(cellAt(x),cellAt(y),cellAt(z));
      occupancy.set(key,(occupancy.get(key)||0)+1);
    }
  }
  const reasons={transparent:0,invalid:0,oversized:0,isolated:0};
  const keep=new Uint8Array(n);
  let retained=0;
  for(let i=0;i<n;i++){
    const o=i*STRIDE,alpha=input[o+27],max=scales[i*2],elongation=scales[i*2+1];
    let reject=null;
    if(!valid[i])reject='invalid';
    else if(alpha<=1)reject='transparent';
    else if ((max>0.12 && alpha<40 && elongation>10) ||
             (max>0.16 && alpha<64 && elongation>8))reject='oversized';
    else if(alpha<16 && max>0.015){
      const x=cellAt(positions[i*3]),y=cellAt(positions[i*3+1]),z=cellAt(positions[i*3+2]);
      let count=0;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){
        count+=occupancy.get(posKey(x+dx,y+dy,z+dz))||0;
      }
      if(count<3)reject='isolated';
    }
    if(reject) reasons[reject]++;
    else {keep[i]=1;retained++;}
  }
  if(!retained)throw new Error('Cleanup removed the entire scene');
  const removed=n-retained;
  if(removed/n>maxRemovalRatio) throw new Error('Cleanup exceeds safety cap of '+(maxRemovalRatio*100).toFixed(1)+'%');
  const out=Buffer.alloc(retained*STRIDE);
  for(let i=0,j=0;i<n;i++){
    if(keep[i]){out.set(input.subarray(i*STRIDE,(i+1)*STRIDE),j*STRIDE);j++;}
  }
  const center=bounds.map(([min,max])=>(min+max)/2);
  const scale=40/Math.max(...bounds.map(([min,max])=>max-min));
  const report={sourceRecords:n,outputRecords:retained,removed,removedPct:+(100*removed/n).toFixed(3),reasons,
    inputBytes:input.length,outputBytes:out.length,sourceCenter:center,sourceScale:scale,
    sourceSha256:crypto.createHash('sha256').update(input).digest('hex'),
    outputSha256:crypto.createHash('sha256').update(out).digest('hex')};
  return {buffer:out,report};
}

function main(args){
  if(args.length<2||args.length>3||args[2]&&args[2]!=='--dry-run'){
    throw new Error('Usage: node scripts/clean-splat.mjs input.splat output.splat [--dry-run]');
  }
  const [source,target,flag]=args;
  const s=path.resolve(source),d=path.resolve(target);
  if(s===d||fs.existsSync(d)&&fs.realpathSync(s)===fs.realpathSync(d)){
    throw new Error('Source and destination must differ');
  }
  const {buffer,report}=cleanSplatBuffer(fs.readFileSync(s));
  if(flag!=='--dry-run'){
    const temp=d+'.tmp-'+process.pid;
    try {fs.writeFileSync(temp,buffer);fs.renameSync(temp,d);}
    finally {try {fs.unlinkSync(temp);}catch{}}
  }
  console.log(JSON.stringify({...report,output:flag==='--dry-run'?'dry-run':d},null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}
