# Account My Pins — staff interface checkpoint

Source: `a1264d118793aca0f9aa2028c51844dc61ce2de7` on the durable `review/mobile-guide-20260921` branch. Work was implemented in a uniquely named per-run worktree; previous shared-checkout changes were not reset or overwritten.

## Implemented

The existing staff `admin3d.html`/`admin3d.js` interface now uses the scene-backed My Pins client instead of using localStorage as its account database. The public front page, Three.js renderer, model assets and map positions are unchanged.

- Initialization requires both a verified editing account and renderer readiness, in either order. Loading an empty account performs reads only; it does not create a workspace.
- An explicit Save creates the tagged account workspace only if needed, saves through the authenticated scene-point endpoint and verifies the record by reading it back before reporting success.
- Existing point coordinates are preserved. Base-site pins and account pins remain distinct by origin, even when an account pin already has shared scope.
- Editing uses draft copies. Save failure retains the form and previous saved marker; switching, closing, importing and deleting are blocked during an in-flight write.
- Account changes or expired authentication block mutations and clear private pins, editor fields and staff contacts from the interface. Loading data is committed only after the final asynchronous identity check.
- Deletion requires confirmation. A photo-bearing pin remains intact and explains that attached photos must be removed first. Browser-local copies are not deleted.
- Legacy browser-pin import is opt-in. Confirmation names the signed-in account, gives the pin count and warns about shared browsers. Existing account IDs are skipped; partial failures can be retried; original local pin/history storage remains unchanged.
- Imports also send `If-None-Match: *`. The existing PostgreSQL upsert atomically refuses an update when that create-only flag is set. A concurrent tab cannot insert the same ID between the client's read and write and then have its record overwritten by the import. A conflict is re-read within the authenticated scene: an ID now present there is counted as already present; an ID not present there remains failed/retryable. Neither is reported as a newly verified import.
- Staff contact selection uses a new editor-authorized, site-scoped, no-store read endpoint. The existing public contact projection is not broadened.
- The mobile staff panel now provides sufficient height for the account list and an expanded editing sheet. Camera controls do not cover the editing form. These styles affect the staff page only.

## Deliberate remaining boundaries

Account-photo uploads, per-pin custom phone overrides, publication/revocation controls and account share/QR are not completed in this slice. Their controls are disabled with an explanation; account pins cannot fall back into the legacy public/base-photo or embedded-data sharing paths. Existing base-site sharing and photo controls remain separate.

A single My Pins workspace can contain multiple records. Do not expose its scene share code as a per-pin public link without defining the exact recipient-visible selection. Next work is scene/owner-bound media and scoped publishing, followed by the optional contact override and private reporting flow. No competing GIS or mapping architecture is introduced.

## Validation

The full local test suite passed **94 tests, zero failures and zero skips**, including the actual Node HTTP application against a disposable PostgreSQL 16 database. New backend coverage verifies authenticated staff-contact reads, cross-site denial, tagged My Pins workspace creation/rediscovery and a two-request create-only import race (one success, one conflict, no overwrite).

Session/client tests cover read-only boot, lazy creation, failed saves, mandatory read-back verification, missing/wrong scene identifiers, busy-state exclusion, cancelled/partial imports, retries, immutable copies and changed-account rejection.

The staff browser suite exercises the actual staff HTML and JavaScript with synthetic API responses and a deterministic renderer fixture. Nine workflow groups passed at 390x844, 768x1024 and 1440x900, plus separate anonymous, failed-load/retry and first-save/empty-account cases. It verifies source separation, exact positions, state preservation, blocked legacy sharing/media, confirmation text, unchanged localStorage, fresh-browser loading and identity changes. Screenshots were inspected and the mobile editing surface was expanded after a visual check exposed the legacy compact-sheet limitation.

The existing public-guide browser regression also passed all four viewport configurations, eight workflow groups each, with zero page JavaScript errors. Those tests use the established data-saver/fallback fixtures. Neither suite certifies physical-phone GPU performance, production authentication, real Storage uploads or email delivery.

AGY Gemini 3.8 Flash generated the new session orchestration module and its initial tests. Luna provided the plan and independent source review, including the import race that was repaired with database-enforced create-only writes. Controller validation tightened response checks, verified persistence, handled auth races and integrated the UI. No worker received production or git-rewrite authority.

## Reproduction and deployment status

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
# Full DB suite: an explicitly isolated loopback fixture named/user sitenav_test.
SITENAV_TEST_DATABASE_URL='<fixture URL>' npm test
# Clean checkout without .env; binds loopback only.
PORT=50157 node tests/preview-server.cjs
python3 tests/browser-my-pins.py --base-url http://127.0.0.1:50157
```

No workflow permissions were changed. Existing CI runs unit/syntax checks and explicitly skips the database group when no fixture URL is supplied; the 94-test result is local full-suite evidence, not a claim of database coverage in CI.

Production is not modified. The accessible Render deployment still needs authorized investigation of its points/contacts HTTP 500 responses. No production migrations, provider settings, real emails/webhooks/reports, staff-data exports or photo uploads were performed. Approved public building information and real-phone qualification remain release dependencies.
