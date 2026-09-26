# SiteNav multi-lane development plan — 2026-09-26

Base: `9771d453dde7c2164c8d1cc7fa2a852cc8bf4dc0`

Astra-high strategic verdict: **PARTIAL DRIFT**.

The architecture is still correct: one mobile-first Three.js/Gaussian-splat guide,
one `scenes / scene_id / created_by` authority model, Node-mediated staff/private
operations, narrow browser projections, and separate public / staff / future private
report workflows. The drift is sequencing: recent work has become too security/release
heavy relative to completing the visitor and staff-to-recipient journeys.

## Portfolio rule

Keep no more than four genuine product-development lanes. For the current phase:

1. Visitor Guide & Product Integration — ACTIVE
2. Staff Guide Lifecycle — ACTIVE
3. Mobile Rendering Qualification — HOLD-FOR-DEVICE; activate immediately when a physical phone is available
4. Private Report Lifecycle — HOLD

Release rehearsal and serialized integration/review are support functions, not extra
product lanes. They must not grow into independent product programmes.

Effort target for the next six weeks:
- 50% UX / approved content / end-to-end integration
- 25% backend/data work tied directly to those journeys
- 15% rendering + physical-device qualification
- 10% release/ops + bounded security maintenance

Concrete security defects may interrupt this allocation. Generic hardening without a
named journey blocker should not.

## Lane 1 — Visitor Guide & Product Integration — ACTIVE

Worktree:
`/home/user/src/landcros-review-20260921/lanes/public-field-guide-20260926`

Branch:
`lane/sitenav-public-field-guide-20260926`

Mission:
Complete the anonymous visitor and scoped-recipient experience using the existing
viewer before adding more infrastructure.

Primary ownership:
- `index.html`, `viewer3d.html`
- public/recipient boot and interaction portions of `viewer3d.js`
- `location-details.js`, `detail-card.js`
- `public-site.js`, `public-data.js`, `public-transport.js`
- public panel/navigation modules
- approved LANDCROS visitor content and public browser tests
- product/docs reconciliation through the serialized integration owner

Current bounded work:
- public-content readiness/preview fixture
- prove the existing 12-building content dependency without fabricating production data
- ensure useful detail content can render independently of full splat readiness

Next deliverables:
1. Current truth matrix: implemented vs integration-qualified vs operationally qualified.
2. Approved visitor-content path consistent across static Supabase and Node metadata.
3. Canonical static -> Node staff entry/navigation contract.
4. Scoped recipient information available before full model completion.
5. Recipient preview contract coordinated with Lane 2.

Acceptance gate:
A fresh anonymous mobile browser can open a location or valid shared QR, read intended
instructions, see the intended approved photograph/contact, navigate/back safely, and
remain usable during slow model/data loading. Revoked/unavailable states are explicit.

Must not:
- invent site content, staff details or photos
- alter auth ownership, SQL grants or migrations
- replace renderer architecture
- add GIS/GPS/routing/BIM

Dependencies:
Can run now. Recipient publication semantics must be agreed with Lane 2. Shared
`viewer3d.js` changes serialize with Lane 3 through integration.

## Lane 2 — Staff Guide Lifecycle — ACTIVE

Worktree:
`/home/user/src/landcros-review-20260921/lanes/my-pins-lifecycle-20260926`

Branch:
`lane/sitenav-my-pins-lifecycle-20260926`

Mission:
Complete the account-owned staff workflow from draft to durable recipient sharing.

Primary ownership:
- `admin3d.html`, `admin3d.js`
- `my-pins-client.js`, `my-pins-session.js`
- scene-owned point routes/data access
- `scenes-db.js`, `point-photos-db.js`, `my-pin-capabilities-db.js`
- My Pins validation/projection tests
- staff browser acceptance tests
- sole product owner for publication/capability state semantics

Current bounded work:
- stop ordinary share/QR reopening from silently rotating an already-issued capability
- add reload/second-browser durability regression
- preserve explicit replace/revoke behavior

Next deliverables:
1. Stable printed QR/link lifecycle across reload/device changes.
2. Authoritative recoverable publication state for partial issue/revoke/save failures.
3. Deliberate recipient preview before publication.
4. Integrated draft -> photo/contact -> preview -> publish -> recipient -> edit -> revoke test.

Acceptance gate:
Two accounts and two browser contexts complete the full lifecycle. Reopening share
controls does not invalidate a previously distributed QR. Wrong account/site/point,
revoked capability and private media remain denied.

Must not:
- create another ownership model or guide database
- broaden direct browser DB grants
- own public visitor boot/rendering
- expand private reporting
- change production

Dependencies:
Can run now. Coordinate recipient payload and preview semantics with Lane 1 before
changing shared contracts. Shared `server.js` or migration changes serialize through
integration.

## Lane 3 — Mobile Rendering Qualification — HOLD-FOR-DEVICE, BOUNDED

Worktree:
`/home/user/src/landcros-review-20260921/lanes/mobile-rendering-20260926`

Branch:
`lane/sitenav-mobile-rendering-20260926`

Mission:
Qualify the existing renderer and already-created candidate assets on real phones.
Do not generate another optimization programme.

Primary ownership:
- `viewer-perf.js`
- `splat-normalization.js`
- performance/qualification scripts and evidence
- candidate asset qualification manifests
- renderer-loop changes only as proposals for serialized integration

Near-term deliverable:
Physical Android and iPhone evidence comparing current baseline and the existing
leading reduced/KSplat candidate where available.

Acceptance gate:
Record device/browser/network, cold/warm cache, usable-guide time, full-model time,
moving/resume frame timing, memory where available, visual recognizability/labels,
asset/build identity and rollback candidate. No duplicate load or interaction regression.

Rules:
- If physical devices are unavailable, mark this lane HOLD; do not substitute more
  headless candidate generation.
- No new DPR/KSplat/LOD experiment unless a measured phone failure motivates it.
- No renderer replacement.

Dependencies:
Baseline qualification can run independently. Any `viewer3d.js` or default asset
switch is serialized with Lane 1/integration.

## Lane 4 — Private Report Lifecycle — HOLD

No active writer and no new product worktree is required while HOLD.

Mission when activated:
Deliver a private report from map placement through visible, retry-safe delivery using
the existing editor/hazard/email/event infrastructure.

Future ownership:
- report-specific sections of `editor.html` / `scene-editor.js`
- `hazard-db.js`, `hazard-status-workflow.js`
- report delivery/outbox state and tests
- reuse `mailer.js` and event infrastructure; do not create a second mail system

Activation gates:
- visitor and staff sharing checkpoints are stable
- explicit report access policy is decided: author/recipient/site-role semantics
- shared backend auth contracts are stable

First future deliverable:
Explicit report audience + persisted queued/sent/failed lifecycle with idempotent retry.

Assura remains HOLD until the real HCMA tenant/API/credential/attachment contract is
documented and approved.

## Support track — Rollout Rehearsal — BOUNDED, THEN PARK

Existing worktree:
`/home/user/src/landcros-review-20260921/lanes/rollout-rehearsal-20260926`

Branch:
`lane/sitenav-rollout-rehearsal-20260926`

This is not a product lane. Preserve the legitimate in-progress disposable
`0019 -> 0020` rehearsal work, qualify it once, integrate it if useful, then park it.

It may own only:
- disposable migration replay
- post-migration ACL/default-privilege assertions
- backend/schema-preflight compatibility checks
- rollback/abort criteria
- operator evidence

It must not:
- apply production migrations
- deploy Node production
- become recurring generic release tooling
- displace visitor/staff/mobile work

## Serialized Integration / Review support

Existing worktree:
`/home/user/src/landcros-review-20260921/lanes/integration-review-20260926`

Branch:
`lane/sitenav-integration-review-20260926`

This is the only integration owner for:
- shared `server.js`, auth/resource-ownership surfaces
- migrations and DB privilege authority
- deployment/runtime manifests
- shared `style.css`, static build boundary and canonical staff entry
- durable README/master-plan/current-state documentation
- composition onto `review/mobile-guide-20260921`

Serialization points:
1. Public payload authority: Lane 2/database enforcement, Lane 1 consumer contract.
2. Publication lifecycle: settle retrieve/replace/expiry/revoke/preview semantics before
   parallel UI/backend implementation.
3. Shared viewer: Lane 1 owns boot/interaction; Lane 3 proposes rendering changes; merge
   `viewer3d.js` one slice at a time.
4. Backend/migrations: Lane 2 may propose but integration owns shared server/migration
   composition and numbering.
5. Release: future rollout order remains
   verify -> 0019 -> verify -> 0020 -> verify -> compatible Node -> verify.
   This is a release constraint, not the product roadmap.
6. No lane merges itself directly into the durable branch.

## Explicit holds

Do not spend active capacity on:
- GIS/GPS/routing/BIM
- renderer replacement
- generic visual-programming/editor expansion
- grouped-guide expansion
- new hosting platforms
- more generic security/release evidence passes without a concrete finding
- new splat-format/LOD candidate generation before phone evidence
- Assura implementation
- production migration/deploy/publication/DNS changes

## Next three checkpoints

### Checkpoint 1 — Current truth and contracts
- integrate corrected current-state docs
- finish public-content readiness path
- define canonical static/staff origins
- lock stable sharing/publication semantics
- finish and park rollout rehearsal support work

### Checkpoint 2 — One complete staff-to-visitor journey
- draft
- photo/contact
- preview
- publish
- QR from second browser/device
- edit
- revoke
- scoped recipient sees useful content before full model completion
- failure recovery covered

### Checkpoint 3 — Physical mobile qualification
- Android + iPhone visitor and recipient journeys
- staff authoring where practical
- baseline vs existing candidate measurement
- fix only measured failures
- assemble compatibility/release evidence
- decide whether reporting can leave HOLD

No production migration, Node deployment, publication change or DNS change is part of
these checkpoints.
