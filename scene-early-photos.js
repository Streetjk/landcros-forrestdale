// Start authorised scene reads before the heavy Three.js/GSAP viewer loads.
// Private signed photo links and warm images stay in page memory only.
(() => {
  const mode = document.currentScript?.dataset?.sceneMode;
  const params = new URLSearchParams(location.search);
  const warmed = [];

  async function request(url) {
    try {
      const response = await fetch(url, {credentials:'same-origin',cache:'no-store'});
      const data = await response.json().catch(() => null);
      return {status:response.status,ok:response.ok,data};
    } catch {
      return {status:0,ok:false,data:null};
    }
  }

  function warmFirstPhotos(objects) {
    if (!Array.isArray(objects) || navigator.connection?.saveData) return;
    try {
      let fullCount=0, thumbCount=0;
      const seen=new Set();
      for (const obj of objects) {
        if (obj?.kind !== 'label') continue;
        const first=Array.isArray(obj.props?.photoItems) ? obj.props.photoItems[0] : null;
        const preview=first?.thumbUrl;
        const full=first?.url || obj.props?.photoUrl;
        for (const [url,kind] of [[preview,'thumb'],[full,'full']]) {
          if (kind==='thumb' && thumbCount>=4 || kind==='full' && fullCount>=2) continue;
          if (typeof url!=='string' || !url.startsWith('https://') || seen.has(url)) continue;
          seen.add(url);
          const image=new Image();
          image.crossOrigin='anonymous';
          image.referrerPolicy='no-referrer';
          image.decoding='async';
          image.fetchPriority=kind==='thumb' && thumbCount===0 || kind==='full' && !preview && fullCount===0
            ? 'high' : 'low';
          image.src=url;
          warmed.push(image);
          if (kind==='thumb') thumbCount++;
          else fullCount++;
        }
        if (fullCount>=2 && thumbCount>=4) break;
      }
    } catch { /* Preloading is optional; a browser image failure must not block the scene. */ }
  }

  if (mode==='viewer') {
    const code=params.get('scene');
    if (!/^[a-z0-9]{10}$/.test(code || '')) return;
    // The CDN map has no /api backend. Public share-code reads are CORS-safe
    // on the main SiteNav host; editor and other backend routes remain local.
    const base=location.hostname==='landcros-forrestdale-static.onrender.com'
      ? 'https://landcros-forrestdale.onrender.com' : '';
    const url=base+'/api/scenes/by-code/'+encodeURIComponent(code);
    const promise=request(url).then(result=>{
      if (result.ok) warmFirstPhotos(result.data?.objects);
      return result;
    });
    window.__siteNavEarlyScene={code,url,promise,warmed};
  }

  if (mode==='editor') {
    const slug=params.get('site');
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug || '')) return;
    const prefix='/api/sites/'+encodeURIComponent(slug);
    // Groups, scenes, and the initial scene's photos need not wait for the
    // model to load. No writes, persistent caches or user data fallbacks.
    const groups=request(prefix+'/scene-groups?kind=admin');
    const scenes=request(prefix+'/scenes');
    const objects=scenes.then(async result=>{
      const first=result.ok && Array.isArray(result.data) ? result.data[0] : null;
      const sceneId=first?.id;
      if (!/^[0-9a-f-]{36}$/i.test(sceneId || '')) return null;
      const reply=await request(prefix+'/objects?scene='+encodeURIComponent(sceneId));
      if (reply.ok) warmFirstPhotos(reply.data);
      return {sceneId,reply};
    });
    window.__siteNavEarlyEditor={slug,groups,scenes,objects,warmed};
  }
})();
