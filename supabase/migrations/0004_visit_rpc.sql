-- Atomic visit increment (replaces the read-then-write in db.mjs recordVisit).
-- Fixes two audit findings: (1) concurrent hits losing increments — now a single
-- INSERT ... ON CONFLICT DO UPDATE per row; (2) orphan visit rows — the per-point
-- row is only touched when the point genuinely belongs to the site.
-- SECURITY DEFINER + granted to service_role only: increments run server-side
-- (the visits table has no client write policy).

create or replace function increment_visit(p_site_id uuid, p_point_id uuid default null)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- site-total row (point_id IS NULL) — always
  insert into visits (site_id, point_id, count, first_visit, last_visit)
    values (p_site_id, null, 1, now(), now())
  on conflict (site_id, coalesce(point_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set count = visits.count + 1,
                last_visit = now(),
                first_visit = coalesce(visits.first_visit, now());

  -- per-point row — only if the point actually belongs to this site (no orphans)
  if p_point_id is not null
     and exists (select 1 from points where id = p_point_id and site_id = p_site_id) then
    insert into visits (site_id, point_id, count, first_visit, last_visit)
      values (p_site_id, p_point_id, 1, now(), now())
    on conflict (site_id, coalesce(point_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set count = visits.count + 1,
                  last_visit = now(),
                  first_visit = coalesce(visits.first_visit, now());
  end if;
end $$;

revoke all on function increment_visit(uuid, uuid) from public;
grant execute on function increment_visit(uuid, uuid) to service_role;
