// Begin share-code-scoped photo loading while the 3D viewer's modules boot.
// Signed photo URLs and warmed images remain in this page's memory only.
(() => {
  const params = new URLSearchParams(location.search);
  const code = params.get('scene');
  // My Pins uses a different capability boundary; never preload a separate
  // scene when the URL also carries a point ID or a My Pins bearer fragment.
  if (params.has('id') || new URLSearchParams(location.hash?.replace(/^#/, '')).has('myPin')
      || !/^[a-z0-9]{10}$/.test(code || '')) return;

  const base = location.hostname === 'landcros-forrestdale-static.onrender.com'
    ? 'https://landcros-forrestdale.onrender.com' : '';
  const url = base + '/api/scenes/by-code/' + encodeURIComponent(code);
  const warmed = [];

  function warmFirstPhotos(objects) {
    if (!Array.isArray(objects) || navigator.connection?.saveData) return;
    try {
      const seen = new Set();
      let fullCount = 0;
      let thumbCount = 0;
      for (const object of objects) {
        if (object?.kind !== 'label') continue;
        const first = Array.isArray(object.props?.photoItems) ? object.props.photoItems[0] : null;
        const thumb = first?.thumbUrl;
        const full = first?.url || object.props?.photoUrl;
        for (const [candidate,kind] of [[thumb,'thumb'],[full,'full']]) {
          if ((kind === 'thumb' && thumbCount >= 4) || (kind === 'full' && fullCount >= 2)) continue;
          if (typeof candidate !== 'string' || !candidate.startsWith('https://') || seen.has(candidate)) continue;
          seen.add(candidate);
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.referrerPolicy = 'no-referrer';
          image.decoding = 'async';
          image.fetchPriority = (kind === 'thumb' && thumbCount === 0)
            || (kind === 'full' && !thumb && fullCount === 0) ? 'high' : 'low';
          image.src = candidate;
          warmed.push(image);
          if (kind === 'thumb') thumbCount++;
          else fullCount++;
        }
        if (fullCount >= 2 && thumbCount >= 4) break;
      }
    } catch { /* Optional warmup must never interfere with scene resolution. */ }
  }

  const promise = (async () => {
    try {
      const response = await fetch(url, {credentials:'same-origin',cache:'no-store'});
      const data = await response.json().catch(() => null);
      if (response.ok) warmFirstPhotos(data?.objects);
      return {status:response.status,ok:response.ok,data};
    } catch {
      return {status:0,ok:false,data:null};
    }
  })();
  window.__siteNavEarlyScene = {code,url,promise,warmed};
})();
