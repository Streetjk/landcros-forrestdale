# Scene-owned pins — continuation checkpoint

## Scope and source

Input: `6100bd47a39e8917c91032e156938df25ccd1911` on `review/mobile-guide-20260921`.
Work was moved to `review/pins-isolated-20260921` in `/home/user/src/landcros-review-20260921/pins-isolated` after a concurrent supervisor changed the shared checkout during validation. The shared checkout was not reset, rebased, or overwritten. The isolated worktree contains a frozen, reviewed combination of the point implementation and the concurrent privacy/delete-safety corrections.

This is the backend foundation for account-owned My Pins, not a claim that the current staff browser UI has migrated. There is no GIS expansion or renderer rewrite.

## Implemented contract

- `GET /api/sites/:slug/scenes/:sceneId/points` lists only that scene's pins for an authorized manager.
- `POST` on the same path upserts one point. The route requires a signed-in site editor and scene-manager authorization; platform-admin and legacy-ownerless policies remain as previously defined.
- `DELETE /api/sites/:slug/scenes/:sceneId/points/:pointId` deletes only the bound site/scene/point.
- Scene pins default to `scope: personal`. Only explicit `scope: shared` pins and their linked contacts are included in the public scene-capability bundle. A signed-in owner can still list personal pins through the authenticated management endpoint.
- Request-body owner/site values are not trusted. `created_by` comes from the signed session on insert and is immutable on update. Tenant and scene bindings remain immutable even on a colliding point UUID.
- UUIDs, label length, point type, scope, finite/bounded coordinates, route/camera structures and contact references are validated. Linked contacts must belong to the same site.
- The old `/api/points` path remains base-only. Supplying or omitting `sceneId` cannot use it to modify a scene-bound row.
- Legacy photo list/upload/bytes/retention/delete operations remain restricted to base points. They must not become a public-media bypass for newly stored personal scene pins. Scene-aware media support is deliberately not enabled yet.
- Pin deletion locks the exact row and refuses a pin with attached photos using HTTP 409 / `POINT_HAS_PHOTOS`. There is no pre-commit destructive Storage cleanup. Explicit authorized photo removal must precede deletion. This restriction also applies to base pins; the current base-photo editor already exposes individual photo removal controls.
- Point writes and their audit records commit or roll back together. Public scene metadata does not expose creator/status email addresses to anonymous visitors.

## Validation and agent review

AGY Gemini 3.8 Flash supplied the initial new DAL/route/validation code and a bounded route correction. Luna supplied the implementation plan and independent reviews. Actual server tests caught and corrected a promise/callback mismatch and error-constructor argument order. No agent was given git rewrite or production authority.

The isolated suite passed **66 tests** with zero failures or skips. This includes 16 integration subtests plus their parent using a disposable local PostgreSQL 16 database and the actual Node HTTP application. Synthetic signed sessions exercise owner, other editor, viewer, non-member, anonymous and platform-admin cases. Coverage includes cross-site/cross-scene/base UUID collisions, same-site contacts, malformed payloads, personal/shared capability visibility and withdrawal, legacy-photo isolation, photo-bearing deletion refusal, audit rollback and persistence from a fresh connection.

The synthetic database schema matches the application columns and constraints exercised here. These tests do **not** certify the production database's RLS policies, live PIN enrolment, external Storage operations, email delivery or physical-phone performance. No actual staff records, credentials, messages or photos are used. The proposed PostgreSQL CI-service change could not be pushed because the installed Git credential lacks GitHub workflow scope. That workflow change is preserved separately in the local evidence directory and is NOT included in this checkpoint. The existing CI workflow is unchanged: it runs unit tests and explicitly skips the database integration group without its fixture URL. The 66-test result above is a verified local full-suite run, not a CI integration claim.

Final Luna source-review verdict: **PASS**, with no concrete P0/P1 findings in the frozen candidate. A separate browser regression run passed all four viewport configurations (390x844, 768x1024, 1024x768, 1440x900), eight workflow groups each, and zero page JavaScript errors. These remain synthetic fallback-mode tests, not physical-phone GPU measurements or production backend tests.

## Remaining work

1. Reconcile the isolated branch with the latest development head without overwriting concurrent changes. Do not merge to main or deploy automatically.
2. Wire staff My Pins to these authenticated routes, with explicit confirmation before importing browser-local records into an employee's account. Keep the original local copy until persistence is confirmed.
3. Implement scene/owner-bound media and pin-local contact overrides, followed by capability-authorized anonymous images, publishing controls and revocation. Do not reopen the legacy public photo routes for private scene records.
4. Qualify deployment/database connectivity and existing migration state. No new production migration was introduced or applied; required existing scene and point-photo tables still need verification on the deployment.
5. Keep reporting private; email first, Assura only against the authorized tenant contract.

## Reproduce locally

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Pure unit tests; database integration is explicitly skipped without a fixture URL.
npm test
# Full suite against an explicitly isolated loopback fixture DB named sitenav_test,
# with user sitenav_test. Never use SUPABASE_DB_URL or production credentials here.
SITENAV_TEST_DATABASE_URL='<isolated loopback fixture URL>' npm test
```

The fixture helper rejects non-loopback hosts, non-fixture database/user names, and a checkout containing `.env`. It disables unrelated outbound mail/webhook workers and uses only synthetic session configuration.

## Publishing authorization

The initial push was rejected for a change to `.github/workflows/test.yml` without workflow permission. No credential permissions were altered. The workflow delta was excluded from this unpublished checkpoint before retrying the code-only development-branch push. The proposed workflow patch remains at `../evidence/pins-isolated/postgres-ci-service.patch` relative to the isolated worktree.
