"""Visual smoke test with fictional browser-only fixtures. Never writes live data."""
import json
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = "http://127.0.0.1:50124"
WORK = [
    {"id":"a8edfd81-01ce-4b4b-9a36-89b66a31e957", "workDate":"2026-11-12", "startTime":"08:00", "endTime":"10:00",
     "department":"Mining", "trade":"Boilermaker", "buildingRef":"bld-mining", "locationDetail":"Western bay, door 3",
     "description":"Bracket grinding", "equipment":"Angle grinder", "enclosure":"open_workshop", "controls":"Spark screens installed",
     "fireWatchEmployeeId":"83edbd98-a05a-4445-9f45-d8d5ff588e41", "status":"under_review", "notNumber":None},
    {"id":"02f682a4-be87-4ceb-9653-5eb1f9716a36", "workDate":"2026-11-13", "startTime":"09:00", "endTime":"11:30",
     "department":"Workshop", "trade":"Fitter", "buildingRef":"bld-module", "locationDetail":"Main repair bay",
     "description":"Welding bucket lugs", "equipment":"MIG welder", "enclosure":"fully_enclosed", "controls":"Fire watch assigned",
     "fireWatchEmployeeId":None, "status":"submitted", "notNumber":None},
]
STAFF = [{"id":"83edbd98-a05a-4445-9f45-d8d5ff588e41", "fullName":"Demo Staff Member", "employeeNumber":"DEMO-001",
          "department":"Mining", "trade":"Boilermaker", "active":True, "extinguisherTrainedOn":"2026-01-01",
          "extinguisherExpiresOn":"2027-01-01", "fireWatchTrainedOn":"2026-02-01", "fireWatchExpiresOn":"2027-02-01",
          "bushfireTrainedOn":None, "bushfireExpiresOn":None, "evidenceReference":"DEMO-TRAINING-REF"}]
ASSETS = [{"id":"b074098c-207d-4fe1-9562-1221e84aa0b2", "assetCode":"DEMO-FE-001", "type":"ABE Dry Powder",
           "capacity":"9.00", "unit":"kg", "buildingRef":"bld-mining", "locationDetail":"South west wall by door 3",
           "sceneX":"-8.1", "sceneZ":"-7.8", "condition":"in_service", "inspectedOn":"2026-10-01", "inspectionDueOn":"2027-04-01"}]
FEED = {"bans":{"state":"ok", "checkedAt":"2026-11-11T09:00:00.000Z", "items":[]}, "armadaleMatches":[],
        "danger":{"state":"ok","items":[]}, "warnings":{"state":"ok","items":[]}}

with sync_playwright() as playwright:
    browser=playwright.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    page=browser.new_page(viewport={"width":1440,"height":1000},device_scale_factor=1)
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    def api(route):
        url=route.request.url
        if url.endswith('/api/auth/me'):
            response={"email":"demo@hcma.com.au","role":"admin","hasPin":True}
        elif url.endswith('/fire-ops/feed'):
            response=FEED
        elif url.endswith('/fire-ops'):
            response={"work":WORK,"staff":STAFF,"extinguishers":ASSETS}
        else:
            route.continue_()
            return
        route.fulfill(status=200,content_type='application/json',body=json.dumps(response))
    page.route('**/api/auth/me',api)
    page.route('**/api/sites/landcros/fire-ops*',api)
    page.goto(ROOT+'/fire-ops.html',wait_until='domcontentloaded')
    expect(page.locator('#fire-app')).to_be_visible(timeout=15000)
    expect(page.locator('#stat-work')).to_have_text('2')
    expect(page.locator('#stat-assets')).to_have_text('1')
    page.screenshot(path='/tmp/sitenav-fire-ops-desktop.png',full_page=True)
    page.get_by_role('tab',name='Hot-work schedule').click()
    expect(page.locator('#work-rows tr')).to_have_count(2)
    page.get_by_role('tab',name='Trained personnel').click()
    expect(page.get_by_text('Demo Staff Member',exact=True)).to_be_visible()
    page.get_by_role('tab',name='Extinguishers').click()
    expect(page.get_by_text('DEMO-FE-001',exact=True)).to_be_visible()
    page.get_by_role('button',name='+ Add extinguisher').click()
    expect(page.get_by_role('dialog',name='')).to_be_visible()
    page.locator('#asset-dialog .close-dialog').first.click()
    page.set_viewport_size({"width":390,"height":844})
    page.get_by_role('tab',name='Overview').click()
    page.screenshot(path='/tmp/sitenav-fire-ops-mobile.png',full_page=True)
    assert not errors,errors
    print('PASS: desktop and mobile Fire Operations, roles, tabs, forms, report rows, no JS errors')
    browser.close()
