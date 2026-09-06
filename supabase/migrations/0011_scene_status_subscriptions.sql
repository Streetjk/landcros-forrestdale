-- SiteNav — per-user scene lists, status workflow, archive
--
-- Applies to BOTH scene kinds (admin map and hazard report map):
--   * scenes.status: open → escalated → resolved (and back to open). Any
--     signed-in @hcma.com.au user who holds the share link may change it;
--     anonymous viewers of an admin link can only look.
--   * scene_subscriptions: opening a share link while signed in adds the
--     scene to that person's own list ("menu"). Deleting from that list only
--     drops the subscription — the scene itself is deleted only by its
--     creator (or a platform admin). Resolved scenes show under a folded
--     "Archived" section in each list.

alter table scenes
  add column status            text not null default 'open'
                               check (status in ('open', 'escalated', 'resolved')),
  add column status_changed_at timestamptz,
  add column status_changed_by uuid references profiles(id) on delete set null;

create table scene_subscriptions (
  scene_id    uuid not null references scenes(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (scene_id, profile_id)
);
create index on scene_subscriptions (profile_id);

-- Service role only (server-mediated), same as the other per-user tables.
alter table scene_subscriptions enable row level security;
