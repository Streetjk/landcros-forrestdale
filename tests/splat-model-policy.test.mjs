import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSplatSortSupport } from '../splat-render-policy.js';
import { resolveSplatQuality, resolveSplatCandidates } from '../splat-quality.js';

function mockGl(renderer, webgl2=true, debug=true) {
  const ext = { UNMASKED_RENDERER_WEBGL: 10, UNMASKED_VENDOR_WEBGL: 11 };
  return {
    RENDERER: 1, VENDOR: 2,
    getExtension: () => debug ? ext : null,
    getParameter: (p) => p === 10 ? renderer : p === 11 ? 'Google' : 'WebKit WebGL',
    ...(webgl2 ? { createTransformFeedback(){}, bindTransformFeedback(){} } : {}),
  };
}
test('software SwiftShader reports CPU sorting even when WebGL2 is present', () => {
  const r = inspectSplatSortSupport({gl: mockGl('ANGLE (Google, Vulkan SwiftShader Device)')});
  assert.equal(r.reason, 'software-renderer');
  assert.equal(r.gpuAcceleratedSort, false);
});
test('software renderers, unknown GPU and WebGL1 fail toward safe CPU sorting', () => {
  for (const gl of [mockGl('llvmpipe'), mockGl('Microsoft Basic Render Driver'), mockGl('NVIDIA RTX A2000', false), mockGl('WebKit WebGL', true, false), null]) {
    assert.equal(inspectSplatSortSupport({gl}).gpuAcceleratedSort, false);
  }
});
test('known hardware WebGL2 can use accelerated sorting; forced CPU and browsers remain safe', () => {
  const gl = mockGl('NVIDIA GeForce RTX 3070');
  assert.equal(inspectSplatSortSupport({gl}).gpuAcceleratedSort, true);
  assert.equal(inspectSplatSortSupport({gl,forceCpu:true}).gpuAcceleratedSort, false);
  assert.equal(inspectSplatSortSupport({gl,isBrave:true}).gpuAcceleratedSort, false);
  assert.equal(inspectSplatSortSupport({gl,userAgent:'Edg/132.0'}).gpuAcceleratedSort, false);
});
test('full quality on high-tier, lite on medium and low; invalid URL values cannot select paths', () => {
  assert.equal(resolveSplatQuality(undefined,'high'), 'full');
  assert.equal(resolveSplatQuality(undefined,'medium'), 'lite');
  assert.equal(resolveSplatQuality('lite','high'), 'lite');
  assert.equal(resolveSplatQuality('full','low'), 'full');
  assert.equal(resolveSplatQuality('https://malicious.example/splat','high'), 'full');
});
test('model fallback order permits a cleaned full model with immutable originals', () => {
  const assets = {splat: ['./assets/site-lite.splat','./assets/site.splat','./assets/site.ply'],
    splatModels: {lite:'./assets/site-lite.splat',full:'./assets/site-clean.splat',original:'./assets/site.splat'}};
  assert.deepEqual(resolveSplatCandidates(assets,'full'), ['./assets/site-clean.splat','./assets/site.splat','./assets/site-lite.splat','./assets/site.ply']);
  assert.deepEqual(resolveSplatCandidates(assets,'lite'), ['./assets/site-lite.splat','./assets/site-clean.splat','./assets/site.splat','./assets/site.ply']);
  assert.deepEqual(resolveSplatCandidates({splat:'./assets/existing.splat'},'full'), ['./assets/existing.splat']);
});
