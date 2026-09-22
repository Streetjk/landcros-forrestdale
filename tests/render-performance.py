"""Constrained-device rendering investigation harness.

This is regression/instrumentation tooling, NOT a physical-phone GPU benchmark.
It runs the real viewer in Chromium, overrides coarse device/network hints and
optionally applies CPU/network throttling, then captures the opt-in ?perf=1
summary. It sends no telemetry and does not exercise authenticated writes.

Usage:
  python tests/render-performance.py --base-url http://127.0.0.1:50170
  python tests/render-performance.py --base-url ... --profiles low-save-data,low-4g
"""
import argparse, asyncio, json, pathlib, traceback
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--base-url',default='http://127.0.0.1:50170')
parser.add_argument('--profiles',default='low-save-data,ios-like')
parser.add_argument('--output',default='../evidence/render-performance')
parser.add_argument('--splat-asset',default=None,help='Local experiment asset path such as ./assets/experiments/site-lite-a64.splat; benchmark only')
parser.add_argument('--capture-presets',action='store_true',help='Capture canvas screenshots at configured camera presets')
parser.add_argument('--drag-dpr',type=float,default=None,help='Perf-only moving DPR experiment; does not change normal viewer defaults')
args=parser.parse_args()
origin=urlsplit(args.base_url)
assert origin.hostname in ('127.0.0.1','localhost','::1'), 'Local benchmark server only'
OUT=pathlib.Path(args.output).resolve();OUT.mkdir(parents=True,exist_ok=True)
ROOT=pathlib.Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'sites/landcros/data/config.json').read_text())

def baseline_splat_normalization():
    src=ROOT/'sites/landcros/assets/site-lite.splat'
    data=src.read_bytes(); stride=32
    import struct
    mins=[float('inf')]*3; maxs=[float('-inf')]*3
    for off in range(0,len(data),stride):
        xyz=struct.unpack_from('<fff',data,off)
        for i,v in enumerate(xyz): mins[i]=min(mins[i],v); maxs[i]=max(maxs[i],v)
    center=[(mins[i]+maxs[i])/2 for i in range(3)]
    span=max(maxs[i]-mins[i] for i in range(3))
    return {'center':center,'scale':40/span}
BASELINE_NORMALIZATION=baseline_splat_normalization()
if args.splat_asset:
    parts=pathlib.PurePosixPath(args.splat_asset).parts
    if not args.splat_asset.startswith('./assets/') or '://' in args.splat_asset or '..' in parts:
        raise SystemExit('splat override must be a local ./assets/... path')

PROFILES={
 'low-save-data':dict(mem=2,cores=2,dpr=2,etype='4g',save=True,cpu=4,latency=120,down_mbps=2,expect='low',expect_splat=False),
 'low-4g':dict(mem=2,cores=2,dpr=2,etype='4g',save=False,cpu=4,latency=80,down_mbps=8,expect='low',expect_splat=True),
 'mid-android':dict(mem=4,cores=4,dpr=2.5,etype='4g',save=False,cpu=3,latency=60,down_mbps=12,expect='medium',expect_splat=True),
 'ios-like':dict(mem=None,cores=4,dpr=3,etype='4g',save=False,cpu=3,latency=60,down_mbps=12,expect='medium',expect_splat=True),
}

def init_script(p):
    mem='undefined' if p['mem'] is None else str(p['mem'])
    return f"""
Object.defineProperty(navigator,'deviceMemory',{{configurable:true,get:()=>{mem}}});
Object.defineProperty(navigator,'hardwareConcurrency',{{configurable:true,get:()=>{p['cores']}}});
Object.defineProperty(navigator,'connection',{{configurable:true,get:()=>({{effectiveType:{json.dumps(p['etype'])},saveData:{str(p['save']).lower()}}})}});
"""

async def run_profile(browser,name,p):
    context=await browser.new_context(viewport={'width':390,'height':844},device_scale_factor=p['dpr'])
    await context.add_init_script(init_script(p))
    page=await context.new_page();errors=[];requests=[]
    async def suppress_visit_write(route):
      # Keep the local performance harness read-only: preview-server persists
      # /api/visit into fixture analytics otherwise.
      await route.fulfill(status=200,content_type='application/json',body='{"ok":true}')
    await page.route('**/api/visit',suppress_visit_write)
    if args.splat_asset:
      async def config_override(route):
        cfg=json.loads(json.dumps(CONFIG));cfg.setdefault('assets',{})['splat']=[args.splat_asset]
        if args.splat_asset.lower().endswith('.ksplat'):
          cfg.setdefault('splat',{})['normalization']=BASELINE_NORMALIZATION
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(cfg))
      await page.route('**/data/config.json',config_override)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:requests.append({'method':r.method,'url':urlsplit(r.url).path}))
    cdp=await context.new_cdp_session(page)
    await cdp.send('Emulation.setCPUThrottlingRate',{'rate':p['cpu']})
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions',{
      'offline':False,'latency':p['latency'],
      'downloadThroughput':p['down_mbps']*1024*1024/8,
      'uploadThroughput':2*1024*1024/8,
      'connectionType':'cellular4g'
    })
    row={'profile':name,'synthetic':True,'note':'Headless Chromium timings are regression signals, not phone-GPU FPS.','errors':errors,'splatOverride':args.splat_asset}
    try:
      query='/?perf=1&perfHud=0'
      if args.drag_dpr is not None: query += '&dragDpr=' + str(args.drag_dpr)
      await page.goto(args.base_url+query,wait_until='domcontentloaded',timeout=30000)
      await page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'",timeout=15000)
      await page.wait_for_selector('#app.scene-ready',timeout=65000)
      if p['expect_splat']:
        # Progressive public reveal can make the base guide usable before the
        # Gaussian splat is complete. Full-splat measurements must still wait
        # for the true splatReady perf mark.
        await page.wait_for_function(
          "window.__sitenavPerf.snapshot().events.some(e => e.name === 'splatReady')",
          timeout=65000,
        )
      await page.wait_for_timeout(1200)
      if args.capture_presets:
        asset_tag=(pathlib.PurePosixPath(args.splat_asset).name if args.splat_asset else 'baseline').replace('.ksplat','').replace('.splat','')
        for preset in CONFIG.get('camera',{}).get('presets',[]):
          pos=preset.get('position');target=preset.get('target')
          if not (isinstance(pos,list) and len(pos)==3 and isinstance(target,list) and len(target)==3): continue
          await page.evaluate("(id)=>{ window.setCameraPreset(id, 1); window._v3d.controls.autoRotate=false; }", preset.get('id'))
          await page.wait_for_timeout(300)
          await page.locator('#three-canvas').screenshot(path=str(OUT/f'{name}-{asset_tag}-{preset.get("id","preset")}.png'))
      # Real pointer motion exercises OrbitControls and dynamic DPR on the real viewer.
      canvas=page.locator('#three-canvas');box=await canvas.bounding_box()
      if box:
        x=box['x']+box['width']*.55;y=box['y']+box['height']*.45
        await page.mouse.move(x,y);await page.mouse.down()
        for step in range(1,8): await page.mouse.move(x+step*12,y+step*3,steps=2)
        await page.mouse.up();await page.wait_for_timeout(1200)
      snap=await page.evaluate('window.__sitenavPerf.snapshot()')
      resource=await page.evaluate("""performance.getEntriesByType('resource').filter(r=>/\\.(splat|ksplat|ply)(?:$|\\?)/.test(r.name)).map(r=>({name:r.name.split('/').pop().split('?')[0],durationMs:Math.round(r.duration),transferSize:r.transferSize,encodedBodySize:r.encodedBodySize}))""")
      splat_requests=[x for x in requests if x['method']=='GET' and x['url'].endswith(('.splat','.ksplat','.ply'))]
      event_by_name={e.get('name'):e for e in snap.get('events',[]) if isinstance(e,dict) and e.get('name')}
      required_readiness=('baseGuideReady','visualReady') + (('splatReady',) if p['expect_splat'] else ())
      missing_readiness=[name for name in required_readiness if not isinstance((event_by_name.get(name) or {}).get('t'),(int,float))]
      assert not missing_readiness, f'missing required readiness events: {missing_readiness}'
      readiness_ms={name:(event_by_name.get(name) or {}).get('t') for name in ('baseGuideReady','visualReady','splatReady')}
      phase_names={'fetch':'splatFetch:end','boundsScan':'splatBoundsScan:end','moduleImport':'splatModuleImport:end','addScene':'splatAddScene:end'}
      splat_timings_ms={}
      for label,event_name in phase_names.items():
        event=event_by_name.get(event_name) or {}
        extra=event.get('extra') if isinstance(event.get('extra'),dict) else {}
        splat_timings_ms[label]=extra.get('durationMs')
      if p['expect_splat']:
        required_phases=['moduleImport','addScene'] if (args.splat_asset or '').lower().endswith('.ksplat') else ['fetch','boundsScan','moduleImport','addScene']
        missing_phases=[label for label in required_phases if not isinstance(splat_timings_ms.get(label),(int,float))]
        assert not missing_phases, f'missing required splat phase durations: {missing_phases}'
      row.update(status='passed',evidenceKind='synthetic-headless-regression',fullSplatCompletionMetric=('splatReady' if p['expect_splat'] else None),readinessMs=readiness_ms,splatTimingsMs=splat_timings_ms,quality=snap['quality'],device=snap['device'],frames=snap['frames'],splatUpdate=snap['splatUpdate'],longTasks=snap['longTasks'],memory=snap['memory'],renderer=snap['renderer'],asset=snap['asset'],resources=resource,splatGetCount=len(splat_requests),resolutionSwitches=snap['resolutionSwitches'],events=snap['events'])
      assert snap['quality'].get('tier')==p['expect'],(snap['quality'],p['expect'])
      if p['expect_splat'] is False:
        assert snap['quality'].get('skipSplat') is True
        assert len(splat_requests)==0,splat_requests
      else:
        assert snap['quality'].get('skipSplat') is False
    except Exception:
      row['status']='failed';row['failure']=traceback.format_exc()[-2200:]
      try: await page.screenshot(path=str(OUT/f'failure-{name}.png'),timeout=5000)
      except Exception: pass
    (OUT/f'{name}.json').write_text(json.dumps(row,indent=2))
    await context.close();return row

async def main():
  selected=[x.strip() for x in args.profiles.split(',') if x.strip()]
  unknown=[x for x in selected if x not in PROFILES]
  if unknown: raise SystemExit('Unknown profiles: '+','.join(unknown))
  rows=[]
  async with async_playwright() as pw:
    browser=await pw.chromium.launch(headless=True,args=['--enable-unsafe-swiftshader'])
    for name in selected:
      row=await run_profile(browser,name,PROFILES[name]);rows.append(row);print(json.dumps({k:row[k] for k in ['profile','status','quality','frames','longTasks','asset','splatGetCount'] if k in row}),flush=True)
    await browser.close()
  (OUT/'results.json').write_text(json.dumps(rows,indent=2))
  return 0 if all(x.get('status')=='passed' and not x['errors'] for x in rows) else 1
raise SystemExit(asyncio.run(main()))
