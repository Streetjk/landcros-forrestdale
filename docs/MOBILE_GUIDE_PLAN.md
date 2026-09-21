# Mobile-first SiteNav delivery plan

## Product boundary

Keep the current public front page, 3D assets, label positions, staff dropdown and Three.js renderer. One viewer supports three thin workflows: public information, staff-owned shareable pins and future private reports. No GIS, GPS, road routing, BIM conversion, generic visual-programming expansion or engine replacement in this plan.

## Ordered milestones and acceptance gates

| Milestone | Work | Gate | Current state |
| --- | --- | --- | --- |
| A. Public-guide hardening | Optional building cards, safe photos/calls, stable scene/short links, visible degraded-data state | Unit and four-viewport fixture checks | Implemented and locally tested |
| B. Reconcile deployment | Establish active host, diagnose live 500s from authorized logs, compare schema/runtime/assets and rollback plan | Public data routes healthy; expected build fingerprint; no privacy regression | Blocked on environment access, not guessed |
| C. Own pins end to end | Connect staff authoring to existing owned scenes + scene-scoped points; server-enforced ownership; private drafts | User A cannot read/edit/delete user B's private draft; own pins survive browser/device change | Planned, not implemented in this checkpoint |
| D. Scoped sharing/media | Database-backed share capability, stable public URL/QR, exactly selected contacts/photos; disable/expire link | Anonymous recipient sees intended guide and media only; revoked link fails uniformly | Planned; existing routes need reconciliation |
| E. Operational field qualification | Approved public content; upload/reader UX; iPhone/Android tests; runtime and memory checks | Core guide usable during model/data delays; actual camera/gallery photos and QR tested | Approved content + physical device checks pending |
| F. Reporting adapter | Private report draft, category/description/photos/reference, reliable email queue/status; Assura adapter contract | Retry does not duplicate; failed delivery visible; evidence never public by default | Existing backend to reuse; integration not qualified |

## Ownership-hardening checkpoint

The current development slice adds server-side creator/platform-admin checks for scene edits and scene-object CRUD, while preserving ownerless legacy scenes for site editors. Scene subscriptions remain read/list only. This hardening is a prerequisite, not completion of My Pins: browser-local personal pins, scene-scoped point CRUD and point-photo authorization are still later work.

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
