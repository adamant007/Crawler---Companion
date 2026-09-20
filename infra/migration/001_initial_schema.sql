-- Ginger Dragon AWS migration schema
-- Cognito "sub" strings are the durable application identity keys.

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  cognito_sub text not null unique,
  email text,
  role text not null default 'user' check (role in ('user','admin')),
  active_character_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists characters (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  name text not null default '',
  ruleset text not null default 'crawler',
  system_key text not null default '',
  rules_profile_id text not null default '',
  profile_version numeric not null default 1,
  schema_version numeric not null default 1,
  legacy_profile boolean not null default false,
  character_source text not null default '',
  source_template_id text not null default '',
  ruleset_data jsonb not null default '{}'::jsonb,
  quote text not null default 'Still Standing.',
  draft boolean not null default false,
  creation_step text not null default '',
  portrait_key text not null default '',
  portrait_settings jsonb not null default '{}'::jsonb,
  customization jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  skills jsonb not null default '{}'::jsonb,
  health numeric not null default 10,
  max_health numeric not null default 10,
  mana numeric not null default 8,
  max_mana numeric not null default 8,
  ai_favor numeric not null default 0,
  status_effects text not null default '',
  defense jsonb not null default '{}'::jsonb,
  equipment jsonb not null default '{}'::jsonb,
  currency jsonb not null default '{}'::jsonb,
  attacks jsonb not null default '[]'::jsonb,
  spells jsonb not null default '[]'::jsonb,
  hotbar jsonb not null default '[]'::jsonb,
  inventory jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists characters_owner_sub_idx on characters(owner_sub);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  name text not null,
  active boolean not null default false,
  description text not null default '',
  current_floor text not null default '',
  join_code_hash text,
  last_played timestamptz,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists campaigns_owner_sub_idx on campaigns(owner_sub);

create table if not exists campaign_members (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  user_sub text not null,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, user_sub)
);
create index if not exists campaign_members_user_sub_idx on campaign_members(user_sub);

create table if not exists campaign_characters (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  character_id uuid not null references characters(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (campaign_id, character_id)
);
create unique index if not exists campaign_characters_character_unique on campaign_characters(character_id);

create table if not exists campaign_stats (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  character_id uuid not null references characters(id) on delete cascade,
  damage_dealt numeric not null default 0,
  healing_done numeric not null default 0,
  kills numeric not null default 0,
  deaths numeric not null default 0,
  crit_successes numeric not null default 0,
  crit_failures numeric not null default 0,
  sessions_played numeric not null default 0,
  primary key (campaign_id, character_id)
);

create table if not exists gm_notes (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  content text not null default '',
  scope text not null default 'personal' check (scope in ('personal','campaign')),
  campaign_id uuid references campaigns(id) on delete cascade,
  sketch_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gm_notes_owner_sub_idx on gm_notes(owner_sub);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  campaign_name text not null default '',
  session_number integer not null default 1,
  session_date text not null default '',
  floor text not null default '',
  duration_minutes integer not null default 0,
  present jsonb not null default '[]'::jsonb,
  stats jsonb not null default '[]'::jsonb,
  ai_favor_earned numeric not null default 0,
  ai_favor_spent numeric not null default 0,
  highlights text not null default '',
  gm_notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists sessions_campaign_idx on sessions(campaign_id, session_number);

create table if not exists rulebooks (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  title text not null,
  system_name text not null default '',
  edition text not null default '',
  publisher text not null default '',
  document_type text not null default 'core_rulebook',
  source_type text not null default 'uploaded',
  object_key text not null default '',
  original_filename text not null default '',
  mime_type text not null default '',
  file_size bigint,
  status text not null default 'added',
  rules_profile_id text not null default '',
  processing_version numeric,
  schema_version numeric not null default 1,
  is_private boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rulebooks_owner_sub_idx on rulebooks(owner_sub);

create table if not exists rulebook_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  rulebook_id uuid not null references rulebooks(id) on delete cascade,
  status text not null default 'queued',
  stage text not null default 'upload',
  started_at timestamptz,
  completed_at timestamptz,
  error_message text not null default '',
  processing_version numeric not null default 1,
  schema_version numeric not null default 1
);

create table if not exists rulebook_extractions (
  id uuid primary key default gen_random_uuid(),
  owner_sub text not null,
  rulebook_id uuid not null references rulebooks(id) on delete cascade,
  processing_job_id uuid references rulebook_processing_jobs(id) on delete cascade,
  page_number integer,
  section_index integer not null default 0,
  text text not null default '',
  character_count integer not null default 0,
  processing_version numeric not null default 1,
  schema_version numeric not null default 1
);
create index if not exists rulebook_extractions_lookup_idx
  on rulebook_extractions(rulebook_id, page_number, section_index);

alter table app_users
  add constraint app_users_active_character_fk
  foreign key (active_character_id) references characters(id) on delete set null;
