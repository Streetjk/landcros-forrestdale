# SiteNav — LANDCROS Forrestdale

Mobile-first interactive 3D site guide using the existing Three.js/Gaussian-splat viewer.

The product has three faces:

1. Public site guide: tap permanent labels for approved visitor instructions, a main contact landline and an actual building photograph.
2. Staff-created guides: verified HCMA email/PIN access, account-owned pins, selected/custom contacts and optional photos, shared through scoped public URLs and QR codes.
3. Future private fault/hazard reporting: the same map interaction, with controlled evidence and reliable email/Assura integration.

These are goals, not a claim that all workflows are complete. GIS/GPS/routing-engine expansion and a renderer rewrite are out of scope.

See [the current review](docs/REVIEW_2026-09-21.md) for verified gaps and deployment evidence, and [the delivery plan](docs/MOBILE_GUIDE_PLAN.md) for ordered implementation and acceptance gates. Existing deployment procedures are in [DEPLOY.md](DEPLOY.md).

## Current checkpoint

The bounded public-viewer change adds optional building detail cards, safer scene/short-code navigation, stale-photo cancellation and visible fallback during public-data failure. It preserves the current map/assets and does not change production or account authorization. The newer PR branch already contains PIN/photo/reporting work; personal admin pins still need server-backed ownership.

```sh
npm ci --ignore-scripts
npm test
node scripts/check-deployment.mjs https://landcros-forrestdale.onrender.com
```

Browser acceptance tests use synthetic data and loopback hosting; see the delivery plan. Do not treat their success as proof of live authentication, uploads, delivery or physical-phone GPU performance. Approved site photographs/main numbers and deployment qualification are still required.
