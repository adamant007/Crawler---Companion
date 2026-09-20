create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null,
  provider text not null default 'stripe',
  provider_customer_id text,
  provider_subscription_id text unique,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_sub_idx on subscriptions(user_sub);

create table if not exists entitlements (
  id uuid primary key default gen_random_uuid(),
  user_sub text not null,
  entitlement_key text not null default 'premium',
  source text not null check (source in ('stripe_subscription','complimentary_group','founder','admin_grant')),
  source_reference text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists entitlements_user_sub_idx on entitlements(user_sub);
create unique index if not exists entitlements_active_source_unique
  on entitlements(user_sub, entitlement_key, source, coalesce(source_reference, ''));

create table if not exists access_codes (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  code_hash text not null unique,
  grants_entitlement_key text not null default 'premium',
  max_redemptions integer,
  redemption_count integer not null default 0,
  expires_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  check (max_redemptions is null or max_redemptions > 0),
  check (redemption_count >= 0)
);

create table if not exists access_code_redemptions (
  access_code_id uuid not null references access_codes(id) on delete restrict,
  user_sub text not null,
  redeemed_at timestamptz not null default now(),
  primary key (access_code_id, user_sub)
);
create index if not exists access_code_redemptions_user_sub_idx
  on access_code_redemptions(user_sub);
