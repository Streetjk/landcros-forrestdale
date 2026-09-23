-- Align direct anonymous contact reads with the SiteNav public API boundary.
--
-- The server uses a service/pool connection that bypasses RLS, so its public
-- /api/contacts query enforces this predicate separately in supabase-db.js.
-- Direct Supabase anon reads must enforce the same rule: a contact is public
-- only when it is active, the site is published (policy 0008), and an
-- explicitly shared BASE point references it. Personal base pins must never
-- make staff contact details anonymous.

create or replace function public.contact_is_base_visible(cid uuid, sid uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.points p
     where p.site_id = sid
       and p.scene_id is null
       and p.scope = 'shared'
       and cid = any(p.contact_ids)
  );
$$;

revoke all on function public.contact_is_base_visible(uuid, uuid) from public;
grant execute on function public.contact_is_base_visible(uuid, uuid) to authenticated, anon;
