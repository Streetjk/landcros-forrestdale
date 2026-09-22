"""Local-only Playwright acceptance tests. Synthetic data; no server writes.
Run: python tests/browser-public-guide.py --base-url http://127.0.0.1:50128
Requires the Python playwright package and installed Chromium.
"""
import argparse
import base64
import json
import pathlib
import time
from urllib.parse import urlsplit, parse_qs
import traceback
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:50128')
parser.add_argument('--output', default='../evidence/browser-public-guide')
args = parser.parse_args()
assert urlsplit(args.base_url).hostname in ('127.0.0.1', 'localhost', '::1'), 'Local fixture tests only'
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path(args.output).resolve()
OUT.mkdir(parents=True, exist_ok=True)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=')
PIN = {'id': '00000000-0000-4000-8000-000000000001', 'label': 'Fixture delivery', 'type': 'drop-off', 'scope': 'shared', 'notes': 'Synthetic delivery', 'position3d': {'x': 0, 'y': 0, 'z': 0}, 'latlng': [0, 0], 'contactIds': []}
features = []
for name, pos, details in [
    ('Fixture Workshop', {'x': -7.2, 'y': 2.3, 'z': -8}, {'description': 'Synthetic <script>not executable</script> text', 'visitorInfo': 'Synthetic visitors must report to reception before entry.', 'phone': '(08) 0000 0000', 'image': '/fixture/workshop.png', 'imageAlt': 'Synthetic image, not a real building'}),
    ('Fixture Empty', {'x': 7.7, 'y': 1.8, 'z': 3.3}, None),
    ('Fixture Broken Image', {'x': -2.5, 'y': 1.8, 'z': 4.4}, {'image': '/fixture/missing.png'})]:
    props = {'id': name.lower().replace(' ', '-'), 'name': name, 'pos3d': pos}
    if details is not None:
        props['details'] = details
    features.append({'type': 'Feature', 'properties': props, 'geometry': {'type': 'Polygon', 'coordinates': [[[0, 0], [0, 0], [0, 0]]]}})

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])
    for width, height in [(390, 844), (768, 1024), (1024, 768), (1440, 900)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=1)
        context.add_init_script("Object.defineProperty(navigator, 'connection', {configurable:true,value:{effectiveType:'2g',saveData:true}})")
        page = context.new_page()
        errors, writes, photos, pending, legacy_share_reads = [], [], [], [], []
        state = {'hold': False, 'outage': False}
        page.on('pageerror', lambda e: errors.append(str(e)))

        def intercept(route):
            request = route.request
            path = urlsplit(request.url).path
            def reply(data, status=200):
                route.fulfill(status=status, content_type='application/json', body=json.dumps(data))
            if request.method not in ('GET', 'HEAD'):
                writes.append(path)
                reply({'ok': True})
            elif path == '/data/config.json':
                config = json.loads((ROOT / 'sites/landcros/data/config.json').read_text())
                config['site'].pop('logo', None)
                reply(config)
            elif path == '/data/buildings.geojson':
                reply({'type': 'FeatureCollection', 'features': features})
            elif path in ('/data/points.json', '/data/contacts.json', '/api/points', '/api/contacts'):
                reply({'error': 'Synthetic outage'} if state['outage'] else [], 500 if state['outage'] else 200)
            elif path.startswith('/api/scenes/by-code/'):
                reply({'scene': {'id': 'fixture', 'kind': 'admin', 'name': 'Fixture guide', 'status': 'open'}, 'objects': [], 'pins': [PIN], 'contacts': [], 'photos': [], 'viewer': {'signedIn': False}})
            elif path.startswith('/api/share/'):
                legacy_share_reads.append(path)
                reply(PIN)
            elif path == '/api/site':
                reply({'slug': 'landcros'})
            elif path.endswith('/photos') and '/points/' in path:
                if state['hold']:
                    pending.append(route)
                else:
                    reply([])
            elif path.startswith('/api/point-photos/') or path == '/fixture/workshop.png':
                photos.append(path)
                route.fulfill(status=200, content_type='image/png', body=PNG)
            elif path == '/fixture/missing.png':
                route.fulfill(status=404, body='Synthetic missing photo')
            elif path.startswith('/api/'):
                reply({})
            else:
                route.continue_()
        page.route('**/*', intercept)
        started = time.monotonic()
        row = {'width': width, 'height': height, 'checks': [], 'errors': errors}
        try:
            page.goto(args.base_url + '/?scene=abcde12345#map', wait_until='domcontentloaded', timeout=30000)
            page.wait_for_function('window._v3d && document.querySelectorAll("#labels-wrap [role=button]").length === 3', timeout=20000)
            page.wait_for_selector('#app.scene-ready', timeout=10000)
            assert not photos, 'Building photos downloaded before label activation'
            row['checks'].append('no eager building photo fetch')
            pin_button = page.locator(f'.point-item[data-pt-id="{PIN["id"]}"]')
            assert pin_button.evaluate('(el) => el.tagName') == 'BUTTON'
            assert pin_button.get_attribute('type') == 'button'
            assert pin_button.get_attribute('aria-label') == PIN['label']
            pin_button.focus()
            assert pin_button.evaluate('(el) => getComputedStyle(el).outlineStyle') != 'none'
            pin_button.press('Enter')
            assert page.locator('#detail-label').inner_text() == PIN['label']
            assert pin_button.get_attribute('aria-current') == 'true'
            back = page.locator('.back-link')
            assert back.evaluate('(el) => el.tagName') == 'BUTTON'
            back.focus()
            back.press('Enter')
            assert page.locator('#point-list').is_visible()
            pin_button.press('Space')
            assert page.locator('#detail-label').inner_text() == PIN['label']
            page.locator('.back-link').click()
            row['checks'].append('native keyboard point/back controls with selected-state semantics')
            workshop = page.get_by_role('button', name='Fixture Workshop', exact=True)
            workshop.click(timeout=10000)
            page.wait_for_function('document.querySelector("#detail-photos img")?.complete === true', timeout=6000)
            assert page.locator('#detail-label').inner_text() == 'Fixture Workshop'
            assert page.locator('#detail-notes').inner_text() == 'Synthetic <script>not executable</script> text'
            assert page.locator('#detail-notes script').count() == 0
            assert page.locator('#detail-visitor-info').is_visible()
            assert page.locator('#detail-visitor-info .detail-visitor-heading').text_content() == 'Visitor information'
            assert page.locator('#detail-visitor-info .detail-visitor-text').inner_text() == 'Synthetic visitors must report to reception before entry.'
            assert page.locator('#detail-contacts a').get_attribute('href') == 'tel:0800000000'
            assert page.locator('#detail-photos img').get_attribute('loading') == 'lazy'
            rect = page.locator('#detail-contacts a').bounding_box()
            assert rect and rect['y'] >= 0 and rect['y'] + rect['height'] <= height, 'Phone action outside visible card'
            assert page.evaluate('window._v3d.controls.autoRotate') is False
            row['checks'].append('tap detail/photo/call/text safety/visible phone/stable camera')
            page.screenshot(path=str(OUT / f'card-{width}.png'), timeout=10000)
            page.evaluate('window.showPointList()')
            assert 'scene=abcde12345' in page.url and page.url.endswith('#map')
            empty = page.get_by_role('button', name='Fixture Empty', exact=True)
            empty.focus()
            empty.press('Enter')
            assert page.locator('#detail-label').inner_text() == 'Fixture Empty'
            assert page.locator('#detail-photos img').count() == 0
            assert page.locator('#detail-contacts a').count() == 0
            assert not page.locator('#detail-visitor-info').is_visible()
            assert page.locator('#detail-visitor-info .detail-visitor-text').inner_text() == ''
            row['checks'].append('keyboard activation and optional-field reset including visitor information')
            page.evaluate('window.showPointList()')
            page.get_by_role('button', name='Fixture Broken Image', exact=True).click()
            page.wait_for_function('!document.querySelector("#detail-photos img")', timeout=6000)
            row['checks'].append('broken photo gracefully hidden')
            page.evaluate('window.showPointList()')
            state['hold'] = False
            page.locator('.point-item[data-pt-id]').dispatch_event('click')
            page.wait_for_function('document.querySelector("#detail-label").textContent === "Fixture delivery"')
            page.wait_for_timeout(100)
            assert parse_qs(urlsplit(page.url).query).get('scene') == ['abcde12345'] and 'id' in parse_qs(urlsplit(page.url).query) and 'd' not in parse_qs(urlsplit(page.url).query), page.url
            page.reload(wait_until='domcontentloaded')
            state['hold'] = False
            # Old pending requests may have been canceled by reload; never publish them.
            pending.clear()
            page.wait_for_function('document.querySelector("#detail-label")?.textContent === "Fixture delivery"', timeout=20000)
            assert parse_qs(urlsplit(page.url).query).get('scene') == ['abcde12345'] and 'd' not in parse_qs(urlsplit(page.url).query), page.url
            row['checks'].append('scene pin survives reload without embedding private data')
            page.evaluate('window.showPointList()')
            page.wait_for_timeout(500)
            state['hold'] = True
            page.locator('.point-item[data-pt-id]').dispatch_event('click')
            page.wait_for_timeout(250)
            workshop = page.get_by_role('button', name='Fixture Workshop', exact=True)
            workshop.dispatch_event('click')
            for request in pending:
                try:
                    request.fulfill(status=200, content_type='application/json', body=json.dumps([{'id':'late-photo','originalName':'Synthetic late photo'}]))
                except Exception:
                    pass
            pending.clear()
            state['hold'] = False
            page.wait_for_timeout(250)
            assert page.locator('#detail-label').inner_text() == 'Fixture Workshop'
            assert page.locator('#detail-photos img').count() == 1
            assert '/fixture/workshop.png' in page.locator('#detail-photos img').get_attribute('src')
            row['checks'].append('late pin photo cannot overwrite building card')
            page.goto(args.base_url + '/?s=fixture1#map', wait_until='domcontentloaded')
            page.wait_for_function('document.querySelector("#detail-label")?.textContent === "Fixture delivery"', timeout=20000)
            assert parse_qs(urlsplit(page.url).query).get('s') == ['fixture1']
            page.reload(wait_until='domcontentloaded')
            page.wait_for_function('document.querySelector("#detail-label")?.textContent === "Fixture delivery"', timeout=20000)
            assert parse_qs(urlsplit(page.url).query).get('s') == ['fixture1']
            page.evaluate('window.showPointList()')
            assert 'id' not in parse_qs(urlsplit(page.url).query)
            assert parse_qs(urlsplit(page.url).query).get('s') == ['fixture1']
            row['checks'].append('short-code pin survives refresh and close')
            legacy_before = len(legacy_share_reads)
            legacy_hash = base64.b64encode(json.dumps({
                'label': 'Legacy hash payload', 'latlng': [0, 0], 'notes': 'must be ignored'
            }).encode()).decode()
            poison_url = (
                args.base_url + '/?myPin=abcde23456&id=' + PIN['id'] +
                '&s=fixture1#share=' + legacy_hash
            )
            page.goto(poison_url, wait_until='domcontentloaded')
            page.wait_for_function(
                'document.querySelector("#detail-label")?.textContent === "Fixture delivery"',
                timeout=20000,
            )
            page.wait_for_timeout(150)
            assert len(legacy_share_reads) == legacy_before, legacy_share_reads
            assert page.get_by_text('Legacy hash payload', exact=True).count() == 0
            scoped_query = parse_qs(urlsplit(page.url).query)
            assert scoped_query.get('myPin') == ['abcde23456']
            assert scoped_query.get('id') == [PIN['id']]
            assert 's' not in scoped_query and 'd' not in scoped_query
            assert not urlsplit(page.url).fragment
            row['checks'].append('My Pins capability suppresses legacy query/hash share fallbacks')
            state['outage'] = True
            page.goto(args.base_url + '/', wait_until='domcontentloaded')
            page.wait_for_selector('#app.scene-ready', timeout=20000)
            page.wait_for_function('document.querySelector("[data-public-data-notice]")', timeout=10000)
            assert page.locator('#labels-wrap [role=button]').count() == 3
            page.get_by_role('button', name='Fixture Workshop', exact=True).click()
            assert page.locator('#detail-label').inner_text() == 'Fixture Workshop'
            row['checks'].append('HTTP 500 data outage preserves map/cards and displays notice')
            row['status'] = 'passed'
        except Exception as exc:
            row['status'] = 'failed'
            row['failure'] = traceback.format_exc()[-1800:]
            try:
                page.screenshot(path=str(OUT / f'failure-{width}.png'), timeout=5000)
            except Exception:
                pass
        row['seconds'] = round(time.monotonic() - started, 2)
        row['prevented_server_writes'] = writes
        results.append(row)
        (OUT / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
        for request in pending:
            try: request.abort()
            except Exception: pass
        context.unroute_all(behavior='ignoreErrors')
        context.close()
    browser.close()
raise SystemExit(0 if all(x['status'] == 'passed' and not x['errors'] for x in results) else 1)
