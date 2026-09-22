"""Actual staff HTML/modules with synthetic HTTP and renderer fixtures.
No real data, server writes, storage uploads, mail or production authentication.
Usage: python tests/browser-my-pins.py --base-url http://127.0.0.1:50157
"""
import argparse
import asyncio
import base64
import copy
import json
import pathlib
import re
import traceback
from urllib.parse import parse_qs, urlsplit
from playwright.async_api import async_playwright, expect

parser=argparse.ArgumentParser()
parser.add_argument('--base-url',default='http://127.0.0.1:50157')
parser.add_argument('--output',default='../evidence/browser-my-pins')
args=parser.parse_args()
assert urlsplit(args.base_url).hostname in ('127.0.0.1','localhost','::1'), 'Fixtures must run locally'
OUT=pathlib.Path(args.output).resolve();OUT.mkdir(parents=True,exist_ok=True)
def uid(n):return f'00000000-0000-4000-8000-{n:012d}'
SCENE=uid(10);P1=uid(21);P2=uid(22);BASEPIN=uid(23);LOCAL1=uid(31);LOCAL2=uid(32);CONTACT=uid(41);PHOTO1=uid(51)
EMAIL='synthetic-a@example.test'
CAP_TOKEN='A'*43
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=')
JPEG=base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooAKKKKACiiigAooooA/9k=')
def pin(id,label,scope='personal',scene=SCENE):
    return {'id':id,'sceneId':scene,'label':label,'type':'meet-point','scope':scope,'position3d':{'x':3,'y':2.75,'z':-4},'latlng':[0,0],'notes':'Fixture notes','contactIds':[],'routeWaypoints':[],'routeWaypoints3d':[],'cameraPreset3d':None,'buildingRef':''}
LEGACY=[pin(LOCAL1,'Browser A'),pin(LOCAL2,'Browser B')]
RAW_LEGACY=json.dumps(LEGACY)
RENDERER="""
setTimeout(() => {
 const wrap=document.getElementById('canvas-wrap');const canvas=document.getElementById('three-canvas') || document.createElement('canvas');
 canvas.style.cssText='position:absolute;inset:0;width:100%;height:100%';wrap.appendChild(canvas);
 window.__fixturePins={};window.__conversions=0;
 const api={renderer:{domElement:canvas},camera:{},controls:{target:{x:0,y:0,z:0}},_pickGround:{},
 _raycaster:{setFromCamera(){},intersectObject(){return [{point:{x:8,y:0,z:9}}]},intersectObjects(){return []}},pins:{},
 renderPins(items){window.__fixturePins={};api.pins={};for(const p of items)api.upsertPin(p)},
 upsertPin(p){window.__fixturePins[p.id]=structuredClone(p);api.pins[p.id]={pt:structuredClone(p),sphere:{}}},
 removePin(id){delete window.__fixturePins[id];delete api.pins[id]},updatePinHighlight(id){window.__fixtureHighlight=id},
 async latlngToScene(){window.__conversions++;return {x:0,y:0,z:0}}};
 window._v3d=api;document.getElementById('loading').style.display='none';
 document.getElementById('app').classList.add('scene-ready');window.dispatchEvent(new CustomEvent('viewer3d:ready'));
}, DELAY);
"""
class Fixture:
    def __init__(self,workspace=True):
        self.workspace=workspace;self.identity=EMAIL;self.auth_status=200;self.auth_delay=0
        self.viewer_delay=0;self.fail_load=False;self.fail_save=False;self.fail_import=False;self.fail_delete=False
        self.pins={P1:pin(P1,'Account A'),P2:pin(P2,'Account shared','shared')} if workspace else {}
        self.contact={'id':CONTACT,'name':'Synthetic staff','role':'Fixture role','phone':'0000','active':True}
        self.photos={P1:[],P2:[]};self.capabilities={}
        self.requests=[];self.hold=None;self.confirmations=[]
    async def route(self,route):
        req=route.request;url=urlsplit(req.url);path=url.path;method=req.method
        async def reply(data,status=200):await route.fulfill(status=status,content_type='application/json',body=json.dumps(data))
        if url.hostname not in ('127.0.0.1','localhost'):
            if 'qrcode' in url.path:await route.fulfill(content_type='application/javascript',body="window.QRCode=class{static CorrectLevel={H:1};constructor(el,opts){window.__qrCalls=(window.__qrCalls||0)+1;(window.__qrTexts||(window.__qrTexts=[])).push(opts&&opts.text||'')}};")
            elif path.endswith('.js'):await route.fulfill(content_type='application/javascript',body='')
            else:await route.fulfill(content_type='text/css',body='')
            return
        if path=='/viewer3d.js':await route.fulfill(content_type='application/javascript',body=RENDERER.replace('DELAY',str(self.viewer_delay)));return
        if path=='/coi-serviceworker.js':await route.fulfill(content_type='application/javascript',body='');return
        if not path.startswith('/api/'):
            await route.continue_();return
        self.requests.append({'method':method,'path':path,'createOnly':req.headers.get('if-none-match')=='*'})
        if path=='/api/auth/me':
            await asyncio.sleep(self.auth_delay)
            await reply({'email':self.identity,'role':'editor','hasPin':True} if self.auth_status==200 else {'error':'Unauthorized'},self.auth_status);return
        if path=='/api/site':await reply({'slug':'landcros'});return
        if path=='/api/sites/landcros/contacts':await reply([copy.deepcopy(self.contact)]);return
        if path=='/api/contacts':await reply([]);return
        if path=='/api/visits':await reply({'total':0,'points':{}});return
        if path=='/api/points':
            if method=='GET':await reply([pin(BASEPIN,'Base public','shared',None)])
            else:await reply({'error':'Unexpected base write'},500)
            return
        photo_match=re.fullmatch(r'/api/sites/landcros/scenes/'+SCENE+r'/points/([^/]+)/photos(?:/([^/]+))?',path)
        if photo_match:
            point_id,photo_id=photo_match.groups();bucket=self.photos.setdefault(point_id,[])
            if method=='GET' and photo_id:
                if not any(x['id']==photo_id for x in bucket):await reply({'error':'PHOTO_NOT_FOUND'},404)
                else:await route.fulfill(status=200,content_type='image/png',body=PNG)
                return
            if method=='GET':await reply(copy.deepcopy(bucket));return
            if method=='POST':
                saved={'id':PHOTO1,'pointId':point_id,'originalName':'synthetic.jpg','contentType':'image/jpeg','bytes':len(JPEG),'expiresAt':'2026-10-22T00:00:00Z'}
                bucket[:] = [x for x in bucket if x['id']!=PHOTO1];bucket.append(saved);await reply(copy.deepcopy(saved),201);return
            if method=='DELETE' and photo_id:
                bucket[:] = [x for x in bucket if x['id']!=photo_id];await reply({'ok':True});return
            await reply({'error':'Unexpected photo method'},405);return
        if path=='/api/sites/landcros/scenes':
            if method=='GET':
                if self.fail_load:await reply({'error':'Synthetic unavailable'},500)
                else:await reply([{'id':SCENE,'name':'My pins','shareCode':'abcde23456','isMine':True,'camera':{'purpose':'my-pins-v1'},'createdAt':'2026-01-01T00:00:00Z'}] if self.workspace else [])
            elif method=='POST':
                self.workspace=True
                await reply({'id':SCENE,'name':'My pins','shareCode':'abcde23456','isMine':None,'camera':{'purpose':'my-pins-v1'}})
            return
        cap_match=re.fullmatch(r'/api/sites/landcros/scenes/'+SCENE+r'/points/([^/]+)/share-capability',path)
        if cap_match:
            point_id=cap_match.group(1)
            if method=='DELETE':
                revoked=point_id in self.capabilities;self.capabilities.pop(point_id,None);await reply({'ok':True,'revoked':revoked});return
            if method=='POST':
                if point_id not in self.pins or self.pins[point_id].get('scope')!='shared':await reply({'error':'MY_PIN_NOT_SHARED'},409);return
                self.capabilities[point_id]=CAP_TOKEN
                await reply({'pointId':point_id,'sceneId':SCENE,'purpose':'my-pins-v1','token':CAP_TOKEN,'capabilityId':uid(61),'issuedAt':'2026-09-23T00:00:00Z'});return
            await reply({'error':'METHOD_NOT_ALLOWED'},405);return
        match=re.fullmatch(r'/api/sites/landcros/scenes/'+SCENE+r'/points(?:/([^/]+))?',path)
        if match:
            if method=='GET':await reply(copy.deepcopy(list(self.pins.values())));return
            if method=='POST':
                body=req.post_data_json
                if req.headers.get('if-none-match')=='*' and body['id'] in self.pins:
                    await reply({'error':'POINT_CONFLICT'},409);return
                if self.hold:await self.hold.wait()
                if self.fail_save or (self.fail_import and body['id']==LOCAL2):await reply({'error':'Synthetic failure'},500);return
                saved={**body,'sceneId':SCENE,'createdBy':uid(80)};self.pins[body['id']]=copy.deepcopy(saved);await reply(saved);return
            if method=='DELETE':
                if self.fail_delete:await reply({'error':'POINT_HAS_PHOTOS'},409);return
                self.pins.pop(match[1],None);await reply({'ok':True});return
        if path=='/api/auth/logout':self.auth_status=401;await reply({'ok':True});return
        await reply({'error':'Unexpected fixture endpoint'},404)

async def boot(browser,fixture,width=390,height=844,legacy=True):
    ctx=await browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1)
    # Seed only fixture data, once. Later reloads must not reset storage.
    await ctx.add_init_script("if(!localStorage.getItem('fixture_seeded')) {localStorage.setItem('fixture_seeded','1');localStorage.setItem('sn_user_pins',"+json.dumps(RAW_LEGACY if legacy else '[]')+");localStorage.setItem('sn_pin_history','keep-original-history');}")
    # Keep image compression deterministic in headless CI. This browser test is
    # about ownership/routing/UI behavior, not codec quality.
    await ctx.add_init_script("""
      window.createImageBitmap = async () => ({width:32,height:32,close(){}});
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        if (kind === '2d') return {drawImage(){}};
        return originalGetContext.call(this, kind, ...args);
      };
      HTMLCanvasElement.prototype.toBlob = function(cb) {
        cb(new Blob([new Uint8Array([1,2,3,4])], {type:'image/jpeg'}));
      };
    """)
    await ctx.route('**/*',fixture.route);page=await ctx.new_page();errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(args.base_url+'/admin3d.html',wait_until='domcontentloaded')
    return ctx,page,errors
async def ready(page):await expect(page.locator('#place-btn')).to_be_enabled(timeout=10000)
async def openpin(page,id):
    await page.locator(f'#point-list [data-pt-id="{id}"]').dispatch_event('click')
    await expect(page.locator('#field-label')).to_be_visible()
async def confirm(page,accept,fixture):
    async def handle(dialog):
        fixture.confirmations.append(dialog.message)
        if accept:await dialog.accept()
        else:await dialog.dismiss()
    page.once('dialog',handle)
async def settle_save(page):await expect(page.locator('#pin-save-button')).to_be_enabled(timeout=10000)

async def main():
    results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        for width,height in [(390,844),(768,1024),(1440,900)]:
            f=Fixture();f.auth_delay=.15 if width==768 else 0;f.viewer_delay=150 if width==390 else 0
            ctx,page,errors=await boot(browser,f,width,height);checks=[]
            row={'width':width,'height':height,'checks':checks,'errors':errors}
            try:
                await ready(page)
                assert not [r for r in f.requests if r['method']=='POST'], 'Boot performed a write'
                assert await page.evaluate('window.__conversions')==0
                assert await page.evaluate('window.__fixturePins['+json.dumps(P1)+'].position3d.y')==2.75
                assert await page.locator('#point-list [data-pin-source="legacy"]').count()==2
                assert await page.locator('#point-list').get_by_text('Pins on this device').count()==1
                # Device-only pins remain inspectable before import but are read-only.
                await page.locator('#point-list [data-pt-id="'+LOCAL1+'"]').dispatch_event('click')
                await expect(page.locator('#drawer-body')).to_contain_text('Saved on this device only')
                await expect(page.locator('#drawer-body')).to_contain_text('Browser A')
                await page.evaluate('window.closeEditor()')
                checks.append('auth/viewer ordering, GET-only boot, preserved XYZ and visible device backups')
                scoped_prefix=f'/api/sites/landcros/scenes/{SCENE}/points/{P1}/photos'
                photo_list_before=len(f.requests)
                await openpin(page,P1)
                for _ in range(50):
                    if any(r['method']=='GET' and r['path']==scoped_prefix for r in f.requests[photo_list_before:]): break
                    await asyncio.sleep(.01)
                assert any(r['method']=='GET' and r['path']==scoped_prefix for r in f.requests[photo_list_before:])
                await page.locator('#field-label').fill('Draft label')
                await page.locator('#field-notes').fill('Draft notes preserved')
                await page.evaluate('window._adminAddContact('+json.dumps(CONTACT)+')')
                assert await page.locator('#field-label').input_value()=='Draft label'
                assert await page.locator('#field-notes').input_value()=='Draft notes preserved'
                f.fail_save=True
                await page.locator('#pin-save-button').click();await settle_save(page)
                assert f.pins[P1]['label']=='Account A'
                assert await page.locator('#field-label').input_value()=='Draft label'
                assert await page.evaluate('window.__fixturePins['+json.dumps(P1)+'].label')=='Account A'
                checks.append('failed save preserves draft, saved list and renderer')
                f.fail_save=False;f.hold=asyncio.Event()
                await page.locator('#pin-save-button').click()
                await expect(page.locator('#pin-save-button')).to_be_disabled()
                await page.evaluate('window.closeEditor();window._adminOpenEditor('+json.dumps(P2)+')')
                assert await page.locator('#field-label').input_value()=='Draft label'
                f.hold.set();f.hold=None;await settle_save(page)
                assert f.pins[P1]['label']=='Draft label'
                assert f.pins[P1]['scope']=='personal'
                assert await page.evaluate('window.__fixturePins['+json.dumps(P1)+'].label')=='Draft label'
                checks.append('save/read-back verified and edit-switch blocked while saving')
                before=len(f.requests)
                await page.evaluate('window._adminShowShareLink();window._adminToggleQR();window._adminDownloadQR();window._adminPromoteToShared()')
                await page.wait_for_timeout(30)
                assert len(f.requests)==before
                assert await page.locator('#pin-photo-input').count()==1
                checks.append('private account share/QR blocked while account photo UI stays available')

                await page.locator('#field-phone-override').fill('+61 400 000 001')
                await page.locator('#pin-save-button').click();await settle_save(page)
                assert f.pins[P1]['phoneOverride']=='+61 400 000 001'
                assert f.contact['phone']=='0000'
                checks.append('phone override persists on the scene point without mutating staff contact')

                photo_before=len(f.requests)
                await page.locator('#pin-photo-input').set_input_files({'name':'synthetic.jpg','mimeType':'image/jpeg','buffer':JPEG})
                await expect(page.locator('#pin-photo-status')).to_contain_text('1 photo',timeout=10000)
                await expect(page.locator('#pin-photos img')).to_have_count(1)
                await page.wait_for_function('document.querySelector("#pin-photos img")?.complete === true',timeout=6000)
                photo_paths=[(r['method'],r['path']) for r in f.requests[photo_before:]]
                assert ('POST',scoped_prefix) in photo_paths
                assert any(m=='GET' and p==scoped_prefix+'/'+PHOTO1 for m,p in photo_paths)
                photo_requests=[(m,p) for m,p in photo_paths if '/photos' in p or '/point-photos/' in p]
                assert photo_requests
                assert all(p==scoped_prefix or p.startswith(scoped_prefix+'/') for _,p in photo_requests), photo_requests
                await page.locator('#pin-photos button[title="Remove photo"]').click()
                await expect(page.locator('#pin-photos img')).to_have_count(0)
                assert any(r['method']=='DELETE' and r['path']==scoped_prefix+'/'+PHOTO1 for r in f.requests)
                assert not f.photos[P1]
                checks.append('account photos list/upload/view/delete stay on scene-qualified routes')

                await page.evaluate('window._adminSetAccountPublished(true)');await settle_save(page)
                assert f.pins[P1]['scope']=='shared'
                await expect(page.locator('.pin-action-row')).to_contain_text('Stop sharing')
                await page.evaluate('window._adminShowShareLink()')
                await expect(page.locator('#share-link-row')).to_be_visible()
                share_url=await page.locator('#share-url-input').input_value();parts=urlsplit(share_url);query=parse_qs(parts.query);fragment=parse_qs(parts.fragment)
                assert set(query)=={'id'}, query
                assert query.get('id')==[P1]
                assert fragment=={'myPin':[CAP_TOKEN]}, fragment
                assert 'myPin=' not in parts.query and 'abcde23456' not in share_url
                assert f.capabilities.get(P1)==CAP_TOKEN
                await page.evaluate('window._adminToggleQR()')
                await page.wait_for_function('window.__qrTexts?.length > 0')
                assert await page.evaluate('window.__qrTexts.at(-1)')==share_url
                cap_path=f'/api/sites/landcros/scenes/{SCENE}/points/{P1}/share-capability'
                assert any(r['method']=='POST' and r['path']==cap_path for r in f.requests)
                checks.append('explicit publish emits bearer-fragment point link and QR without workspace share code')

                await page.evaluate('window._adminSetAccountPublished(false)');await settle_save(page)
                assert P1 not in f.capabilities
                assert any(r['method']=='DELETE' and r['path']==cap_path for r in f.requests)
                assert f.pins[P1]['scope']=='personal'
                await expect(page.locator('.pin-action-row')).to_contain_text('Publish guide')
                assert await page.locator('.pin-action-row').get_by_text('Share link',exact=True).count()==0
                assert await page.locator('.pin-action-row').get_by_text('QR',exact=True).count()==0
                assert await page.locator('#qr-section').evaluate('(el)=>el.style.display')=='none'
                checks.append('stop sharing revokes account share controls and restores private scope')
                await page.evaluate('window.closeEditor()');await openpin(page,P2)
                await page.locator('#field-label').fill('Shared account update')
                await page.locator('#pin-save-button').click();await settle_save(page)
                assert f.pins[P2]['scope']=='shared'
                assert not [r for r in f.requests if r['method']=='POST' and r['path']=='/api/points']
                checks.append('account provenance remains scene-bound even with shared scope')
                await page.evaluate('window.closeEditor()')
                await confirm(page,False,f);before=len([r for r in f.requests if r['method']=='POST'])
                await page.locator('#legacy-import-button').click()
                await expect(page.locator('#my-pins-status')).to_contain_text('cancelled')
                assert len([r for r in f.requests if r['method']=='POST'])==before
                f.fail_import=True;await confirm(page,True,f);await page.locator('#legacy-import-button').click()
                await expect(page.locator('#my-pins-status')).to_contain_text('1 failed',timeout=10000)
                assert LOCAL1 in f.pins and LOCAL2 not in f.pins
                f.pins[LOCAL1]['label']='Server edit retained';f.fail_import=False
                await confirm(page,True,f);await page.locator('#legacy-import-button').click()
                await expect(page.locator('#my-pins-status')).to_contain_text('0 failed',timeout=10000)
                assert f.pins[LOCAL1]['label']=='Server edit retained' and LOCAL2 in f.pins
                assert len([r for r in f.requests if r['method']=='POST' and r['createOnly']])==3
                assert EMAIL in f.confirmations[-1] and 'another employee' in f.confirmations[-1]
                assert await page.evaluate('localStorage.getItem("sn_user_pins")')==RAW_LEGACY
                assert await page.evaluate('localStorage.getItem("sn_pin_history")')=='keep-original-history'
                checks.append('confirmation-only import, partial retry without overwrite, browser copies retained')
                await openpin(page,P1);f.fail_delete=True;await confirm(page,True,f)
                await page.evaluate('window._adminDelete()');await settle_save(page)
                assert P1 in f.pins;await expect(page.locator('.toast').last).to_contain_text('photos')
                f.fail_delete=False;await confirm(page,False,f);await page.evaluate('window._adminDelete()')
                assert P1 in f.pins
                await confirm(page,True,f);await page.evaluate('window._adminDelete()')
                await expect(page.locator('#point-list [data-pt-id="'+P1+'"]').first).to_have_count(0)
                assert P1 not in f.pins
                checks.append('delete confirmation and photo-conflict fail closed')
                # A new browser has no account cache; records must come from server fixtures.
                fresh,freshpage,fresherrors=await boot(browser,f,width,height,legacy=False)
                await ready(freshpage)
                assert await freshpage.locator('#point-list [data-pt-id="'+LOCAL1+'"]').count()==1
                assert await freshpage.evaluate('localStorage.getItem("sn_user_pins")')=='[]'
                await fresh.close();assert not fresherrors
                checks.append('fresh browser loads account data without local pin cache')
                await openpin(page,P2);await page.wait_for_timeout(350)
                await page.locator('.toast').evaluate_all('(nodes)=>nodes.forEach(n=>n.remove())')
                if width<=1024:
                    panel=await page.locator('#side-panel').bounding_box();assert panel['height']>=height*.78
                    label=await page.locator('#field-label').bounding_box();assert label['y']>=panel['y'] and label['y']+label['height']<=height
                await page.screenshot(path=str(OUT/f'account-{width}.png'),full_page=True)
                f.identity='synthetic-b@example.test';before=len([r for r in f.requests if r['method']=='POST'])
                await page.locator('#pin-save-button').click()
                await expect(page.locator('#place-btn')).to_be_disabled()
                await expect(page.locator('#drawer-body')).to_be_empty()
                assert len([r for r in f.requests if r['method']=='POST'])==before
                assert P2 not in await page.evaluate('Object.keys(window.__fixturePins)')
                checks.append('changed account clears private UI and blocks mutation')
                row['status']='passed'
            except Exception:
                row['status']='failed';row['failure']=traceback.format_exc()[-2200:]
                row['diagnostic']=await page.evaluate('({viewer:!!window._v3d,ready:typeof window.togglePlacement,status:document.querySelector("#my-pins-status")?.textContent,identity:!!window._snAdminIdentity})')
                row['requests']=f.requests[-30:]
                try:await page.screenshot(path=str(OUT/f'failure-{width}.png'),full_page=True,timeout=4000)
                except Exception:pass
            finally:
                if f.hold:f.hold.set()
                await ctx.unroute_all(behavior='ignoreErrors');await ctx.close()
            results.append(row);print(json.dumps(row),flush=True);(OUT/'results.json').write_text(json.dumps(results,indent=2))
        for mode in ['anonymous','load-failure','empty-account']:
            f=Fixture(workspace=mode!='empty-account')
            if mode=='anonymous':f.auth_status=401
            if mode=='load-failure':f.fail_load=True
            ctx,page,errors=await boot(browser,f,390,844,legacy=False);row={'case':mode,'errors':errors}
            try:
                if mode=='anonymous':
                    await page.wait_for_function('Boolean(window._v3d) && typeof window.togglePlacement === "function"',polling=100,timeout=6000);await page.wait_for_timeout(80)
                    await expect(page.locator('#place-btn')).to_be_disabled()
                    assert not [r for r in f.requests if '/scenes' in r['path'] or r['method']=='POST']
                elif mode=='load-failure':
                    await expect(page.locator('#my-pins-retry')).to_be_visible()
                    await expect(page.locator('#place-btn')).to_be_disabled()
                    f.fail_load=False;await page.locator('#my-pins-retry').click();await ready(page)
                    assert not [r for r in f.requests if r['method']=='POST']
                else:
                    await ready(page);assert not f.workspace
                    assert not [r for r in f.requests if r['method']=='POST']
                    await page.locator('#place-btn').click()
                    await page.locator('#canvas-wrap canvas').dispatch_event('pointerup',{'button':0,'clientX':50,'clientY':100})
                    await expect(page.locator('#field-label')).to_be_visible();await page.locator('#field-label').fill('First account pin')
                    await page.locator('#pin-save-button').click();await settle_save(page)
                    assert f.workspace and len(f.pins)==1
                    assert next(iter(f.pins.values()))['scope']=='personal'
                    assert [r['path'] for r in f.requests if r['method']=='POST']==['/api/sites/landcros/scenes',f'/api/sites/landcros/scenes/{SCENE}/points']
                row['status']='passed'
            except Exception:
                row['status']='failed';row['failure']=traceback.format_exc()[-2000:]
                row['diagnostic']=await page.evaluate('({viewer:!!window._v3d,ready:typeof window.togglePlacement,status:document.querySelector("#my-pins-status")?.textContent,identity:!!window._snAdminIdentity})')
            await ctx.unroute_all(behavior='ignoreErrors');await ctx.close();results.append(row);print(json.dumps(row),flush=True)
        (OUT/'results.json').write_text(json.dumps(results,indent=2));await browser.close()
    return 0 if all(r['status']=='passed' and not r['errors'] for r in results) else 1
raise SystemExit(asyncio.run(main()))
