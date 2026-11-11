# SiteNav Fire Operations — 11 November 2026

## Status

Implemented on feature branch `feature/sitenav-fire-ops-20261111`, based on the current PPE SiteNav branch.

- Staff page: `/fire-ops.html?site=landcros` (accessible from the SiteNav staff navigation and `/start.html`).
- Staff-only live RSS summary for DFES Total Fire Bans, fire danger ratings and Metro South East regional incident warnings.
- Departmental hot-work submissions for individual dates, with workshop enclosure, trade, SiteNav building, exact bay, fire-watch nomination, vegetation/DBCA proximity, time, method and controls.
- Aggregation by department/job count/planned hours, date/department filters, CSV and print report. Counts exclude cancelled jobs; records are retained for audit.
- Coordinator workflow: submitted → under review → internally reviewed → DFES notification recorded → completed, with cancellation/re-review branches. These are **internal planning states**, not a permit/exemption or permission to start work.
- Employee training/competency list by department/trade, extinguisher training, optional company fire-watch induction, firefighting-vehicle operation and bushfire suppression, documented expiry/reassessment, employee active status and evidence reference.
- Extinguisher register by unique asset code, type/capacity, site building, exact location, service/inspection date and condition. Only assets with audited SiteNav `sceneX`/`sceneZ` appear as pins in `/index.html?fire=1`. Clicking an asset in the register deep-links to the corresponding 3D pin.
- Mutations of training/equipment and coordinator status decisions require SiteNav site **admin or owner**. Viewers and editors can read and submit their planned work, but cannot alter credentials, assets or recorded DFES receipts.
- Private Supabase tables with RLS enabled, no browser policies, revoked anon/authenticated/public table grants. All reads and writes pass through the existing validated SiteNav session and site-level role gate; records are scoped to the site ID.
- Audited create/update operations. No initial employee records, certificates or extinguisher locations are fabricated.

## Before live rollout

1. Verify the intended Git branch and deployment target. Do **not** overwrite SiteNav's production PPE feature work or perform an automatic production deployment just because this branch is published.
2. Back up and review the production database schema, then apply **only** `supabase/migrations/0024_fire_operations.sql` (after earlier project migrations). No production migration was run by this build.
3. Ensure the nominated WHS/safety coordinators have SiteNav `admin` or `owner` memberships; ordinary staff use their existing viewer/editor site membership. Test both authorised and unauthorised access.
4. Validate the real SiteNav building IDs and survey the exact extinguisher positions against the actual 3D map. **Do not use building-label coordinates as extinguisher locations.** Physically verify types/capacities, service dates and condition.
5. Import training records from the approved employer register. Confirm individual course certificates, training, documented expiry/reassessment and company policy. Do not assume every extinguisher qualification legally expires after 12 months. Evidence references are plain identifiers only; certificates are not uploaded in this version.
6. Review the company hot-work permit procedure, DFES conditions, extinguisher suitability, fire-watch training, emergency/evacuation escalation, and local government rules with the appointed HSE professional before authorising operational use.
7. Run `npm ci && npm test`; test with an approved staff account and a site admin account on a staging service. Exercise the notification handoff and an artificial RSS outage. The browser smoke script uses fictional fixtures and needs browser socket access; the current scratch sandbox cannot launch Chromium.
8. Only after sign-off, point the production Render service at the reviewed commit. No deployment or automatic submission to DFES has been performed as part of this feature branch.

## Operational limitations

- The three official feeds are: `https://api.emergency.wa.gov.au/v1/rss/total-fire-bans`, `https://api.emergency.wa.gov.au/v1/rss/fire-danger-ratings`, and `https://api.emergency.wa.gov.au/v1/rss/warnings?region=METRO%20SOUTH%20EAST`.
- Server caches each designated RSS feed for at least 300 seconds, including errors, respecting Emergency WA's published automation rate limit. There are no calls to undocumented Emergency WA endpoints.
- The site is at Forrestdale, in the City of Armadale; total fire bans use local-government boundaries, but fire danger ratings use different Fire Weather District boundaries. Local RSS keyword matching **cannot prove absence of a TFB**. The user interface always points to official verification. Regional incident warnings may not apply to the exact workshop address.
- DFES currently says qualifying commercial hot work during a TFB uses the **official online notification form** for both DFES and relevant local government, submitted **24 hours to 30 minutes** before work; repeat for each consecutive TFB day. The receipt's **NOT number** is a confirmation of submission, not a separate exemption or permit. A single valid notification may cover multiple jobs on the same day within a DFES region, subject to the form instructions. The local website does not send that form or contact a fire brigade automatically.
- Fully enclosed work is treated differently to work in a workshop with open doors/windows. On Catastrophic fire danger ordinary commercial hot work must not proceed. The portal **does not automatically decide** work is legally allowed; a coordinator must verify the current conditions and all prescribed fire controls.
- Outdoor/open-workshop work may be marked internally reviewed only if the risk proximity fields are assessed and the nominated fire-detection officer has recorded extinguisher training. Within 30 m of vegetation, firefighting-vehicle operation **and** bushfire suppression training are additionally required. A separate external fire-watch certificate is not imposed by these regulations. This is still a limited check: it **does not certify** that the whole hot-work site, equipment or notification is compliant. Coordinators can revise a submitted or reviewed plan, which returns it to under review; notification-recorded work cannot be silently changed.
- Harvest Vehicle Movement Bans are a separate local-government matter. The fire-warning RSS panel is not an HVMB feed.
- No notification email, SMS, government form submission, roster integration, or certificate-file storage is implemented. A PDF is not automatically generated; report print and CSV export are provided.

## Authoritative references

- DFES Total Fire Ban rules and FAQs: https://www.dfes.wa.gov.au/hazard-information/bushfire/total-fire-ban
- Official prescribed activity notification: https://forms.digital.wa.gov.au/221860790821053
- Prescribed hot-work conditions: https://publications.dfes.wa.gov.au/publications/prescribed-activity-and-conditions-hot-work
- Emergency WA feeds and terms: https://www.emergency.wa.gov.au/about
- Company site municipality and equipment locations must be confirmed by appointed staff.
