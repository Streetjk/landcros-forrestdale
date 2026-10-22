// Early, bounded shared-scene lookup for public viewers.
// Render's sleeping backend can return several temporary 503/504 responses
// before it wakes. The previous three attempts (~2 seconds of backoff)
// permanently left the first public visit without its custom scene pin.
// Retry for roughly one cold-start window, but NEVER retry 401/403/404,
// infer a different scene, or fall back to another user's pins.
export const SHARED_SCENE_RETRY_DELAYS_MS = Object.freeze([
  650, 1500, 3500, 7000, 11000, 18000, 26000,
]);

export async function loadSharedSceneBundle(url,{
  fetchFn=globalThis.fetch,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  delays=SHARED_SCENE_RETRY_DELAYS_MS,
}={}){
  if(typeof fetchFn!=='function' || typeof url!=='string' || !url) return {data:null,status:0};
  for(let i=0;i<=delays.length;i++){
    let status=0;
    try {
      const response=await fetchFn(url,{credentials:'same-origin',cache:'no-store'});
      status=response?.status||0;
      if(response?.ok){
        const data=await response.json();
        if(data && typeof data==='object' && !Array.isArray(data)) return {data,status};
        return {data:null,status:502};
      }
      if(status===401){
        // Preserve the original explicit hazard-login response without
        // retrying or exposing any unauthorised scene content.
        const details=await response.json?.().catch(()=>null);
        return {data:null,status,details};
      }
      if(![408,429,500,502,503,504].includes(status))return {data:null,status};
    } catch {
      // DNS, connection interruptions or bad JSON may be transient.
    }
    if(i<delays.length) await wait(delays[i]);
  }
  return {data:null,status:503};
}

// The head script may have already completed the first public request while
// Three.js was loading. Reuse only an exact-code, exact-URL response; a denied
// scene cannot be bypassed with fallback requests or another cached code.
export async function loadSharedSceneBundleWithEarlyResult(url,code,early,options={}) {
  if (early?.code !== code || early?.url !== url || typeof early?.promise?.then !== 'function') {
    return loadSharedSceneBundle(url,options);
  }
  let result;
  try { result = await early.promise; } catch { return loadSharedSceneBundle(url,options); }
  if (result?.ok && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    return {data:result.data,status:result.status || 200};
  }
  if (result?.status && ![408,429,500,502,503,504].includes(result.status)) {
    return {data:null,status:result.status,details:result.status===401 ? result.data : undefined};
  }
  return loadSharedSceneBundle(url,options);
}
