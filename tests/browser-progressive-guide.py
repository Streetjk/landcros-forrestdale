"""Local-only browser qualification for progressive public guide loading.

Headless Chromium is regression evidence only, not physical-phone performance.
The fixture holds the local splat request to prove the vanilla guide and an
exact valid My Pins recipient route become usable first while malformed or
other scoped routes retain blocking behaviour.
"""
import argparse
import json
import pathlib
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:50191')
parser.add_argument('--output', default='../evidence/browser-progressive-guide')
args = parser.parse_args()
assert urlsplit(args.base_url).hostname in ('127.0.0.1', 'localhost', '::1')
OUT = pathlib.Path(args.output).resolve()
OUT.mkdir(parents=True, exist_ok=True)

SCENE = {
    'scene': {'id': 'fixture-scene', 'kind': 'admin', 'name': 'Fixture guide', 'status': 'open'},
    'objects': [], 'pins': [], 'contacts': [], 'photos': [], 'viewer': {'signedIn': False},
}
MY_PIN_ID = '00000000-0000-4000-8000-000000000003'
MY_PIN_TOKEN = 'A' * 43

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1)
    context.add_init_script("""
Object.defineProperty(navigator,'deviceMemory',{configurable:true,get:()=>4});
Object.defineProperty(navigator,'hardwareConcurrency',{configurable:true,get:()=>4});
Object.defineProperty(navigator,'connection',{configurable:true,get:()=>({effectiveType:'4g',saveData:false})});
""")
    page = context.new_page()
    state = {'mode': 'hold'}
    held = []
    capability_requests = []
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    def reply(route, data, status=200):
        route.fulfill(status=status, content_type='application/json', body=json.dumps(data))

    def intercept(route):
        request = route.request
        path = urlsplit(request.url).path
        if path.endswith('/assets/site-lite.splat') and request.method == 'GET':
            if state['mode'] == 'hold':
                held.append(route)
                return
            if state['mode'] == 'fail':
                route.fulfill(status=503, body='fixture splat unavailable')
                return
        if path.endswith('/data/public-runtime.json'):
            # Keep qualification local-only. An invalid runtime config forces
            # the historical local API transport instead of production Supabase
            # reads or a scoped-route redirect to the configured Render origin.
            reply(route, {})
            return
        if path.startswith('/api/my-pins/points/') and request.method == 'GET':
            capability_requests.append({
                'path': path,
                'authorization': request.headers.get('authorization'),
            })
            reply(route, SCENE)
            return
        if path.startswith('/api/scenes/by-code/'):
            reply(route, SCENE)
            return
        if path in ('/api/points', '/api/contacts'):
            reply(route, [])
            return
        if path == '/api/auth/me':
            reply(route, {'error': 'Unauthorized'}, 401)
            return
        if path == '/api/visit':
            # Keep local qualification read-only: preview-server's visit route
            # persists fixture analytics into sites/landcros/data/visits.json.
            reply(route, {'ok': True})
            return
        route.continue_()

    page.route('**/*', intercept)

    def release_held():
        pending = list(held)
        held.clear()
        for route in pending:
            try:
                route.continue_()
            except Exception:
                pass

    def perf_events():
        return page.evaluate("window.__sitenavPerf?.snapshot().events.map(e => e.name) || []")

    try:
        # Vanilla route: base guide must become usable while the splat GET is held.
        state['mode'] = 'hold'
        page.goto(args.base_url + '/?perf=1&perfHud=0', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'", timeout=15000)
        page.wait_for_selector('#app.scene-ready', timeout=10000)
        assert held, 'splat request was not held during progressive reveal'
        events = perf_events()
        assert 'baseGuideReady' in events, events
        assert 'visualReady' in events, events
        assert 'splatReady' not in events, events
        assert page.locator('#splat-progress').is_visible()
        assert page.locator('#splat-msg').inner_text().startswith('Loading 3D model')
        assert page.evaluate('window._v3d.controls.enabled') is True
        release_held()
        page.wait_for_function("window.__sitenavPerf.snapshot().events.some(e => e.name === 'splatReady')", timeout=30000)
        page.wait_for_function("document.getElementById('splat-msg').textContent === '3D model ready'", timeout=5000)
        assert page.evaluate('window._v3d.controls.enabled') is True
        assert page.evaluate('window._v3d.controls.autoRotate') is False
        results.append({'case': 'vanilla-progressive-success', 'status': 'passed', 'synthetic': True})

        # Vanilla failure: usable guide stays up and raw fetch errors are not exposed.
        state['mode'] = 'fail'
        page.goto(args.base_url + '/?perf=1&perfHud=0', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_selector('#app.scene-ready', timeout=10000)
        page.wait_for_function("document.getElementById('splat-msg').textContent === '3D model unavailable'", timeout=6000)
        events = perf_events()
        assert 'baseGuideReady' in events and 'visualReady' in events
        assert 'splatReady' not in events
        assert 'fixture splat unavailable' not in page.locator('#splat-msg').inner_text()
        assert page.locator('#labels-wrap [role=button]').count() > 0
        results.append({'case': 'vanilla-progressive-failure', 'status': 'passed', 'synthetic': True})

        # Exact valid My Pins recipient route: the public base guide may become
        # usable while the splat is still held, but the bearer is sent only to
        # the point-qualified capability endpoint.
        state['mode'] = 'hold'
        before_capability_requests = len(capability_requests)
        page.goto(
            args.base_url + f'/?id={MY_PIN_ID}&perf=1&perfHud=0#myPin={MY_PIN_TOKEN}',
            wait_until='domcontentloaded',
            timeout=30000,
        )
        page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'", timeout=15000)
        page.wait_for_selector('#app.scene-ready', timeout=10000)
        assert held, 'valid My Pins route did not hold the splat request'
        deadline = time.monotonic() + 5
        while len(capability_requests) == before_capability_requests and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        assert len(capability_requests) == before_capability_requests + 1, capability_requests
        request = capability_requests[-1]
        assert request['path'] == f'/api/my-pins/points/{MY_PIN_ID}', request
        assert request['authorization'] == f'Bearer {MY_PIN_TOKEN}', request
        events = perf_events()
        assert 'baseGuideReady' in events and 'visualReady' in events
        assert 'splatReady' not in events
        release_held()
        page.wait_for_function("window.__sitenavPerf.snapshot().events.some(e => e.name === 'splatReady')", timeout=30000)
        results.append({'case': 'my-pins-progressive-success', 'status': 'passed', 'synthetic': True})

        # Malformed bearer: remain blocking and fail closed without making a
        # capability request. The ordinary public guide appears only after the
        # held splat settles, with scoped-unavailable messaging handled by UI.
        state['mode'] = 'hold'
        before_capability_requests = len(capability_requests)
        malformed_token = MY_PIN_TOKEN[:-1]
        page.goto(
            args.base_url + f'/?id={MY_PIN_ID}&perf=1&perfHud=0#myPin={malformed_token}',
            wait_until='domcontentloaded',
            timeout=30000,
        )
        page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'", timeout=15000)
        deadline = time.monotonic() + 5
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        assert held, 'malformed My Pins route did not hold the splat request'
        page.wait_for_timeout(1600)
        assert page.locator('#app.scene-ready').count() == 0, 'malformed My Pins route revealed before splat settled'
        assert len(capability_requests) == before_capability_requests, capability_requests
        release_held()
        page.wait_for_selector('#app.scene-ready', timeout=30000)
        assert len(capability_requests) == before_capability_requests, capability_requests
        results.append({'case': 'my-pins-malformed-remains-blocking', 'status': 'passed', 'synthetic': True})

        # Deep scene route: still blocks scene-ready until the real splat settles.
        state['mode'] = 'hold'
        page.goto(args.base_url + '/?scene=abcde12345&perf=1&perfHud=0', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function("window.__sitenavPerf && typeof window.__sitenavPerf.snapshot==='function'", timeout=15000)
        deadline = time.monotonic() + 5
        while not held and time.monotonic() < deadline:
            page.wait_for_timeout(100)
        assert held, 'deep-route splat request was not held'
        page.wait_for_timeout(1600)
        assert page.locator('#app.scene-ready').count() == 0, 'deep route revealed before splat settled'
        release_held()
        page.wait_for_selector('#app.scene-ready', timeout=30000)
        page.wait_for_function("window.__sitenavPerf.snapshot().events.some(e => e.name === 'splatReady')", timeout=30000)
        results.append({'case': 'deep-route-remains-blocking', 'status': 'passed', 'synthetic': True})
    except Exception as exc:
        results.append({'case': 'qualification', 'status': 'failed', 'error': repr(exc), 'synthetic': True})
        try:
            page.screenshot(path=str(OUT / 'failure.png'), timeout=5000)
        except Exception:
            pass
    finally:
        release_held()
        (OUT / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps({'results': results, 'pageErrors': errors}, indent=2), flush=True)
        context.unroute_all(behavior='ignoreErrors')
        context.close()
        browser.close()
raise SystemExit(0 if results and all(r.get('status') == 'passed' for r in results) and not errors else 1)
