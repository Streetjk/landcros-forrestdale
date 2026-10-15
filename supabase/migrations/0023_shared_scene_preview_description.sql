-- SiteNav: share-code-scoped first-tap description hydration for public admin
-- scenes. The full by-code API already exposes these descriptions to holders
-- of the same share code. This adds only bounded plain-text description to
-- the existing title+coordinates preview; no photos, scripts, or contacts.
-- Preserve the prior SQL security boundary, grants and RLS.
--
-- Only general/admin scenes are eligible. Hazard report links require staff
-- login, and the account-owned My Pins workspace requires a point capability.
create or replace function public.sitenav_shared_scene_pin_preview(p_code text, p_site_slug text)
returns jsonb
language sql
stable
strict
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'objects',
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', o.id::text,
          'kind', 'label',
          'transform', pg_catalog.jsonb_build_object('position', o.transform -> 'position'),
          'props', pg_catalog.jsonb_build_object(
            'text', pg_catalog.left(coalesce(o.props ->> 'text', ''), 160),
            'description', pg_catalog.left(coalesce(o.props ->> 'description', ''), 4000)
          )
        ) order by o.z_index, o.created_at
      )
      from (
        select obj.id, obj.kind, obj.transform, obj.props, obj.z_index, obj.created_at
        from public.scene_objects obj
        where obj.scene_id = s.id
          and obj.site_id = s.site_id
          and obj.kind = 'label'
          and pg_catalog.jsonb_typeof(obj.transform -> 'position') = 'array'
        order by obj.z_index, obj.created_at
        limit 25
      ) o
    ), '[]'::jsonb)
  )
  from public.scenes s
  join public.sites site on site.id = s.site_id and site.slug = p_site_slug
  where p_code ~ '^[a-z0-9]{10}$'
    and s.share_code = p_code
    and s.kind = 'admin'
    and coalesce(s.camera ->> 'purpose', '') <> 'my-pins-v1'
  limit 1;
$$;

revoke all on function public.sitenav_shared_scene_pin_preview(text, text)
  from public, anon, authenticated;
grant execute on function public.sitenav_shared_scene_pin_preview(text, text)
  to anon;
