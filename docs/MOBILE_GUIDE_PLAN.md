# Mobile-first SiteNav delivery plan

## Product boundary

Keep the current public front page, 3D assets, label positions, staff dropdown and Three.js renderer. One viewer supports three thin workflows: public information, staff-owned shareable pins and future private reports. No GIS, GPS, road routing, BIM conversion, generic visual-programming expansion or engine replacement in this plan.

## Authoritative current state

The [2026-09-26 multi-lane plan](SITENAV_MULTI_LANE_PLAN_20260926.md) was established from durable review-branch base `9771d453dde7c2164c8d1cc7fa2a852cc8bf4dc0` and is the planning authority for A–F status, lane ownership, holds and acceptance order. Individual lane and integration commits may advance independently after that base, so fresh Git/CI evidence—not this paragraph—determines the current source head. The checkpoint sections below are historical records retained for traceability; they are not claims that the related end-to-end workflows are complete today.

## Ordered milestones and acceptance gates

| Milestone | Work | Gate | Current state |
| --- | --- | --- | --- |
| A. Public-guide hardening | Optional building cards, safe photos/calls, stable scene/short links, visible degraded-data state | Unit and four-viewport fixture checks | Implementation foundation is complete enough; reopen only for demonstrated defects |
| B. Reconcile deployment | Establish active host, diagnose live 500s from authorized logs, compare schema/runtime/assets and rollback plan | Public data routes healthy; expected build fingerprint; no privacy regression | Static/Node split is understood; rollout qualification is incomplete and 0019/0020 remain unapplied |
| C. Own pins end to end | Connect staff authoring to existing owned scenes + scene-scoped points; server-enforced ownership; private drafts | User A cannot read/edit/delete user B's private draft; own pins survive browser/device change | Substantially implemented; remaining work is lifecycle/UX qualification rather than another persistence foundation |
| D. Scoped sharing/media | Database-backed share capability, stable public URL/QR, exactly selected contacts/photos; disable/expire link | Anonymous recipient sees intended guide and media only; revoked link fails uniformly | Substantially implemented; link lifecycle needs correction and capability expiry remains explicit follow-up work |
| E. Operational field qualification | Approved public content; upload/reader UX; iPhone/Android tests; runtime and memory checks | Core guide usable during model/data delays; actual camera/gallery photos and QR tested | Largest visitor-facing shortfall: approved content and physical-device evidence remain absent |
| F. Reporting adapter | Private report draft, category/description/photos/reference, reliable email queue/status; Assura adapter contract | Retry does not duplicate; failed delivery visible; evidence never public by default | Legacy foundation exists; report-specific authorization and durable delivery contract are not qualified |

## Historical checkpoint — ownership hardening

That development slice added server-side creator/platform-admin checks for scene edits and scene-object CRUD, while preserving ownerless legacy scenes for site editors. Scene subscriptions remained read/list only. This hardening was a prerequisite, not completion of My Pins: browser-local personal pins, scene-scoped point CRUD and point-photo authorization were still later work.

## Staff workflow architecture

Reuse existing `scenes.created_by`, `points.scene_id` and `scene_subscriptions` rather than introduce a competing guide database. A simple single-pin guide can use this model without forcing users to understand scene editing. Optional grouped guides can follow later.

Staff UX: verify work-email ownership during enrolment; set PIN; sign in with email + PIN; open My pins; place/edit pin; select staff contact or set a pin-local custom phone; attach optional photo; save draft; preview as recipient; publish a link/QR. Public recipients do not log in. Hazard recipients remain authenticated according to an explicit report access policy.

Implement in bounded slices:

1. Define draft/unlisted/base-public/report visibility explicitly. Keep public base content site-admin-only. Use the session profile as owner; never trust a request-body owner ID.
2. Add owner-aware point CRUD through existing owned scenes. Check scene/site/point relationships for every read and mutation, including photo upload/delete and share creation. Site membership alone is insufficient.
3. Migrate browser pins with user confirmation: show count, associate with the current account, validate/idempotently import, preserve the original local copy until server persistence is verified. Do not silently import one employee's browser storage into a different employee's account.
4. Add the server-backed My pins UI and visible save/failure/conflict states. Keep the staff dropdown authenticated. Store custom phone per pin, not as a mutation of the selected staff directory record.
5. Connect existing compressed-photo uploads to draft pins. Publishing must be a separate deliberate action; taking a photograph must not publish a pin.
6. Use one canonical share URL with a random server-generated capability, publication/revocation state and minimal public payload. Resolve media against that capability and its actual owned pin, not an arbitrary client-supplied UUID or uploaded snapshot. Preserve existing legacy links only through a documented compatibility path.
7. Test two accounts, two scenes, private/shared/base-public pins, direct UUID requests, revoked links, expired images, another browser/device and database restarts.

Email plus a memorized PIN is not automatically multi-factor authentication. The one-time mailbox verification proves enrolment; the normal PIN login still needs server-side throttling, secure sessions, reset and revocation. Reuse the existing implementation after qualification rather than replace it with a globally unique bare PIN.

## Public content contract

In `sites/landcros/data/buildings.geojson`, each existing feature may have optional `properties.details`:

```json
{
  "description": "Approved visitor instruction",
  "phone": "<approved main landline>",
  "image": "./assets/locations/<approved-real-photo>.webp",
  "imageAlt": "Description of the actual entrance or building"
}
```

The bracketed values are placeholders, not production content. Use real, approved site photographs. Keep public photos small (proposed long edge around 1600 px) and optimized; maintain an update/version naming convention. Missing fields are hidden. Actual location labels/positions remain unchanged. Avoid the entire staff-directory payload on the public map.

## Mobile improvements after the first slice

Keep the existing lite splat, pixel-ratio tuning and shared-memory work. Benchmark before changing renderer or introducing streaming infrastructure. Prioritize useful information before expensive rendering, an explicit data-saver mode, reduced-motion support, pausing work when hidden and not fetching an original multi-megabyte photo for a small card. Existing uploads send compressed plus original files, so a small thumbnail does not imply a small upload.

Record device/browser, network profile, cold/warm cache, usable-guide time, full-model time, sustained frame time, memory and failure behavior. Set performance budgets from physical-device evidence; do not convert headless desktop viewport results into a phone-FPS claim. Keep the public interface quiet; editing/status/reporting controls appear only where relevant.

## Reporting integration

Reuse scene/photo/report/email modules and the existing event infrastructure. Define a persisted report payload and a delivery outbox with idempotency key, attempts, next retry, provider response/reference and terminal failure. Distinguish saved from delivered. Email is the first adapter; do not use a mailto link as reliable submission. Assura is a subsequent adapter after the HCMA tenant API, credentials, permissions, categories and attachment contract are documented and approved. No external sends from automated tests.

## Validation commands

```sh
npm ci --ignore-scripts
npm test
node scripts/check-deployment.mjs https://landcros-forrestdale.onrender.com
# In a clean checkout without .env; server binds only to loopback:
PORT=50128 node tests/preview-server.cjs
# Separate terminal, Python Playwright + Chromium installed:
python3 tests/browser-public-guide.py --base-url http://127.0.0.1:50128
# Optional, in an already-authorized shell with SUPABASE_DB_URL set:
node scripts/check-schema.cjs
```

The schema command is read-only and checks presence only. It is not a migration tool. Current manifests permit Node 18 while locked Supabase dependencies require Node 22; qualify/pin the deployment runtime before releasing PR #1. CI tests on Node 22. No provider changes or migrations were applied in this review.

### Historical checkpoint — My Pins client foundation

At that checkpoint, the browser had a tested `my-pins-client.js` foundation for discovering/creating the signed-in user's tagged My Pins workspace scene, reading/writing scene-owned pins, and preparing legacy `sn_user_pins` for an explicit confirmation-only import. It did not mutate legacy storage, auto-publish content, enable scene photos, or replace the existing `admin3d.js` UI. The next slice was wiring this client into My Pins with a visible migration confirmation and preserving the local copy until server persistence was verified.

### Historical checkpoint — scene-owned point backend

The continuation slice implemented authenticated scene-scoped point CRUD, immutable tenant/scene binding, session-derived authors, personal/shared capability filtering, and legacy point/photo bypass isolation. Points with attached photos then required explicit photo removal before deletion. The staff My Pins UI and scene-photo workflow remained to be connected. See `PIN_OWNERSHIP_CHECKPOINT.md` for exact scope, test limitations and the isolated-branch reconciliation requirement.

### Historical checkpoint — staff My Pins interface

That checkpoint connected the staff interface to the scene-owned My Pins client: read-only account discovery, explicit save/read-back verification, account delete, confirmed legacy import with unchanged browser copies and database-atomic create-only import protection. Staff contacts were read through an editor-only site endpoint. Account media, phone overrides and scoped/revocable publication/QR remained the next slice; they did not use legacy public fallbacks. See `MY_PINS_UI_CHECKPOINT.md` for the exact implementation and test limits.

### Historical checkpoint — rendering-performance lane

At that checkpoint, mobile/low-end rendering was a measured development lane. `?perf=1` provided zero-telemetry on-device measurements and `tests/render-performance.py` supplied constrained-browser regression profiles. The first measured optimization replaced LANDCROS's 3.29 MB satellite PNG transfer with a same-resolution 239 KB WebP while retaining the source PNG; synthetic low-end/Save-Data visual readiness fell from ~14.4 s to ~2.85 s. Full-3D startup was dominated by the 8.74 MB lite splat and scene construction, not its ~24 ms bounds scan. A `dragDpr=0.75` perf-only A/B improved synthetic moving p95 materially, but remained experimental pending physical-phone confirmation. See `RENDERING_PERFORMANCE.md`; do not infer phone FPS from headless Chromium or rewrite the renderer without evidence.

#### Historical checkpoint — reduced-splat experiment

A deterministic alpha-filter generator and benchmark override made the next mobile optimization reproducible without changing the configured model. Three constrained runs put the 4.55 MB alpha-96 candidate at ~8.14 s median visual-ready versus ~13.32 s for the 8.74 MB baseline, with moving p95 ~39.2 ms versus ~48.1 ms; fixed visitor-preset captures were nearly identical in the headless comparison. The candidate binary was deliberately **not** committed or selected by default. Real Android/iPhone visual + `?perf=1` qualification remains required before any asset switch. See `RENDERING_PERFORMANCE.md`.

#### Historical checkpoint — KSplat qualification

The rendering lane then had safe optional normalization support and `.ksplat` benchmark coverage without changing the configured LANDCROS model. Against the 8.74 MB `site-lite.splat` at that checkpoint, the leading candidate for physical-device qualification was alpha ≥80 plus GaussianSplats3D v0.4.7 KSplat compression level 1 at **3.77 MB** (56.9% smaller). Three synthetic low-4G runs reduced median full-model `splatReady` from ~12.02 s to ~5.21 s while fixed-camera headless comparisons showed no gross holes or alignment drift. This remains synthetic evidence only: the binary/config switch is withheld until low-end Android and iPhone/Safari visual/performance qualification.
