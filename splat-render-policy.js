/**
 * Conservative Gaussian sorting policy.
 *
 * The current splat library can report "ready" with an invisible scene when
 * GPU transform-feedback sorting is used on software WebGL implementations.
 * Prefer CPU sorting for software/unknown renderers and known incompatible
 * browsers; enable GPU sorting only for identifiable hardware WebGL2.
 */
export function inspectSplatSortSupport({ gl, userAgent = '', isBrave = false, forceCpu = false } = {}) {
  const safe = (parameter) => {
    try { return gl?.getParameter?.(parameter) || ''; } catch { return ''; }
  };
  const detail = (() => {
    try { return gl?.getExtension?.('WEBGL_debug_renderer_info') || null; } catch { return null; }
  })();
  const renderer = String(detail
    ? safe(detail.UNMASKED_RENDERER_WEBGL) : safe(gl?.RENDERER));
  const vendor = String(detail
    ? safe(detail.UNMASKED_VENDOR_WEBGL) : safe(gl?.VENDOR));
  const isWebGL2 = typeof gl?.createTransformFeedback === 'function'
    && typeof gl?.bindTransformFeedback === 'function';
  const software = /swiftshader|llvmpipe|softpipe|software|lavapipe|microsoft basic render|warp device|mesa offscreen/i
    .test(renderer + ' ' + vendor);
  const incompatibleBrowser = Boolean(isBrave) || /(?:Edg|Edge)\//.test(userAgent);
  const identifiedHardware = Boolean(detail && renderer && vendor)
    && !/^(webgl|webkit webgl|angle|generic)$/i.test(renderer.trim());
  const reason = forceCpu ? 'manual-cpu'
    : !isWebGL2 ? 'webgl2-unavailable'
    : software ? 'software-renderer'
    : incompatibleBrowser ? 'browser-incompatible'
    : !identifiedHardware ? 'unknown-renderer'
    : 'hardware-supported';
  return Object.freeze({
    gpuAcceleratedSort: reason === 'hardware-supported',
    reason, renderer, vendor,
  });
}
