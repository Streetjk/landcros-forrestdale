# SiteNav — LANDCROS Forrestdale

Mobile-first interactive 3D site guide using the existing Three.js/Gaussian-splat viewer.

The product has three faces:

1. Public site guide: tap permanent labels for approved visitor instructions, a main contact landline and an actual building photograph.
2. Staff-created guides: verified HCMA email/PIN access, account-owned pins, selected/custom contacts and optional photos, shared through scoped public URLs and QR codes.
3. Future private fault/hazard reporting: the same map interaction, with controlled evidence and reliable email/Assura integration.

These are goals, not a claim that all workflows are complete. GIS/GPS/routing-engine expansion and a renderer rewrite are out of scope.

The authoritative integration status is the [exact-head multi-lane plan](docs/SITENAV_MULTI_LANE_PLAN_20260926.md) at base `9771d453dde7c2164c8d1cc7fa2a852cc8bf4dc0`. See [MOBILE_GUIDE_PLAN.md](docs/MOBILE_GUIDE_PLAN.md) for the product boundary and historical checkpoint record. The dated [2026-09-21 review](docs/REVIEW_2026-09-21.md) remains historical evidence, not a current deployment claim. Existing deployment procedures are in [DEPLOY.md](DEPLOY.md).

## Current integration state

At this exact integration head, the public/static transport and staff/auth foundations exist in code, but the three primary journeys still require lane-specific qualification. Public guide content, account-owned My Pins lifecycle, rollout evidence and physical-device checks remain open acceptance work. No production migration, Node deploy, DNS change, publication enablement or real staff credential test is implied by local tests.

This integration candidate now wires the static chooser's staff/admin destinations to the configured Node staff/auth origin and covers that dual-origin contract in `tests/dual-origin-staff-entry.contract.test.mjs`. That is local integration evidence only: the change is not yet composed onto the durable review branch or qualified as a production deployment.

```sh
npm ci --ignore-scripts
npm test
node scripts/check-deployment.mjs https://landcros-forrestdale.onrender.com
```

Browser acceptance tests use synthetic data and loopback hosting; see the exact-head lane plan and delivery plan. Do not treat their success as proof of live authentication, uploads, delivery or physical-phone GPU performance. Approved site photographs/main numbers and deployment qualification are still required.
