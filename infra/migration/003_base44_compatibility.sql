alter table app_users
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table characters
  add column if not exists portrait_url text not null default '',
  add column if not exists visible_to jsonb not null default '[]'::jsonb,
  add column if not exists campaign_id text not null default '';

alter table campaigns
  add column if not exists party jsonb not null default '[]'::jsonb,
  add column if not exists members jsonb not null default '[]'::jsonb,
  add column if not exists join_code text not null default '';

alter table gm_notes
  add column if not exists sketch_url text not null default '';
