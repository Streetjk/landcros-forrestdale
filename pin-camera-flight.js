// SiteNav camera-flight planning, with no renderer state or side effects.
// Interpolate the orbit target and a spherical camera offset together. This
// avoids the straight-line camera fly-throughs, up-vector flips and 180°
// azimuth jumps that can happen when selecting a distant pin.
const PI = Math.PI;
const CLAMP = (v,low,high) => Math.max(low,Math.min(high,v));
const lerp = (a,b,t) => a+(b-a)*t;
const finite = v => Number.isFinite(v?.x) && Number.isFinite(v?.y) && Number.isFinite(v?.z);
const add = (a,b) => ({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const norm = v => Math.hypot(v.x,v.y,v.z);

export const PIN_VIEW_ANGLE_DEG = 45; // elevation above ground, phi 45° from vertical
export const PIN_ORBIT_SPEED = 0.42; // slow OrbitControls autoRotate (~143 sec/revolution)

// Minimum-jerk quintic easing: the first and second derivatives are zero
// at both endpoints. GSAP only drives time; this function defines the path.
export function pinCameraEase(t) {
  const s=CLAMP(Number.isFinite(t)?t:0,0,1);
  return s*s*s*(10+s*(-15+6*s));
}

export function planPinCameraFlight({camera,target,pin,viewRadius=11,
    elevationDeg=PIN_VIEW_ANGLE_DEG,orbitAzimuth=null}={}) {
  if (![camera,target,pin].every(finite)) return null;
  const rawOffset=sub(camera,target);
  const length=norm(rawOffset);
  if (!Number.isFinite(length) || length<0.001) return null;
  const horizontal=Math.hypot(rawOffset.x,rawOffset.z);
  const fallback=sub(camera,pin);
  const theta=horizontal>=1e-5
    ? Math.atan2(rawOffset.x,rawOffset.z)
    : Number.isFinite(orbitAzimuth) ? orbitAzimuth
      : Math.hypot(fallback.x,fallback.z)>=1e-5
        ? Math.atan2(fallback.x,fallback.z) : 0;
  const radius=CLAMP(Number(viewRadius)||11,4,35);
  const phi=Math.atan2(horizontal,rawOffset.y);
  const endPhi=CLAMP((90-CLAMP(elevationDeg,25,70))*PI/180,0.1,1.45);
  const endTheta=theta; // preserve visitor's bearing, no hardcoded compass heading
  const duration=CLAMP(1.45 + 0.016*pinDistance(target,pin)
    + 0.17*Math.abs(Math.log(Math.max(0.1,length)/radius)),1.45,2.85);
  return {
    camera:{...camera},target:{...target},pin:{...pin},
    from:{radius:length,phi,theta},
    to:{radius,phi:endPhi,theta:endTheta},
    duration,viewAngleDeg:90-endPhi*180/PI,
  };
}

function pinDistance(a,b) {
  return norm(sub(a,b));
}

export function samplePinCameraFlight(plan,progress) {
  if (!plan) return null;
  const t=pinCameraEase(progress);
  if (t<=0) return {camera:{...plan.camera},target:{...plan.target}};
  const target={
    x:lerp(plan.target.x,plan.pin.x,t),
    y:lerp(plan.target.y,plan.pin.y,t),
    z:lerp(plan.target.z,plan.pin.z,t),
  };
  // Geometric radius interpolation produces a smooth perceptual zoom while
  // retaining the actual initial camera distance at t=0.
  const radius=Math.exp(lerp(Math.log(plan.from.radius),Math.log(plan.to.radius),t));
  const phi=lerp(plan.from.phi,plan.to.phi,t);
  const theta=lerp(plan.from.theta,plan.to.theta,t);
  const h=Math.sin(phi)*radius;
  const offset={x:h*Math.sin(theta),y:Math.cos(phi)*radius,z:h*Math.cos(theta)};
  return {camera:add(target,offset),target};
}
