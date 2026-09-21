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
parser.add_argument('--drag-dpr',type=float,default=None,help='Perf-only moving DPR experiment; does not change normal viewer defaults')
args=parser.parse_args()
origin=urlsplit(args.base_url)
assert origin.hostname in ('127.0.0.1','localhost','::1'), 'Local benchmark server only'
OUT=pathlib.Path(args.output).resolve();OUT.mkdir(parents=True,exist_ok=True)

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
    row={'profile':name,'synthetic':True,'note':'Headless Chromium timings are regression signals, not phone-GPU FPS.','errors':errors}
    try:
      query='/?perf=1&perfHud=0'
      if args.drag_dpr is not None: query += '&dragDpr=' + str(args.drag_dpr)
      await page.goto(args.base_url+query,wait_until='domcontentloaded',timeout=30000)
      await page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'",timeout=15000)
      await page.wait_for_selector('#app.scene-ready',timeout=65000)
      await page.wait_for_timeout(1200)
      # Real pointer motion exercises OrbitControls and dynamic DPR on the real viewer.
      canvas=page.locator('#three-canvas');box=await canvas.bounding_box()
      if box:
        x=box['x']+box['width']*.55;y=box['y']+box['height']*.45
        await page.mouse.move(x,y);await page.mouse.down()
        for step in range(1,8): await page.mouse.move(x+step*12,y+step*3,steps=2)
        await page.mouse.up();await page.wait_for_timeout(1200)
      snap=await page.evaluate('window.__sitenavPerf.snapshot()')
      resource=await page.evaluate("""performance.getEntriesByType('resource').filter(r=>/\\.(splat|ply)(?:$|\\?)/.test(r.name)).map(r=>({name:r.name.split('/').pop().split('?')[0],durationMs:Math.round(r.duration),transferSize:r.transferSize,encodedBodySize:r.encodedBodySize}))""")
      splat_requests=[x for x in requests if x['method']=='GET' and x['url'].endswith(('.splat','.ply'))]
      row.update(status='passed',quality=snap['quality'],device=snap['device'],frames=snap['frames'],splatUpdate=snap['splatUpdate'],longTasks=snap['longTasks'],memory=snap['memory'],renderer=snap['renderer'],asset=snap['asset'],resources=resource,splatGetCount=len(splat_requests),resolutionSwitches=snap['resolutionSwitches'],events=snap['events'])
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
