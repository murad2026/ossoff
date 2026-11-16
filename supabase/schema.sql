-- Draft Ossoff 2028 — database schema for Supabase (Postgres)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Row Level Security is ON with no public policies: only the API worker
-- (service_role key) can read or write. The browser never talks to the DB directly.

create extension if not exists pgcrypto;

-- Step 1: one-click "Do you support…?" answers (no personal data)
create table if not exists pledges (
  ip_hash    text primary key,
  answer     text not null check (answer in ('yes','unsure')),
  state      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Supporter stories shown on the wall
create table if not exists stories (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  first_name   text not null,
  state        text not null,
  text         text not null,
  headline     text,
  tags         text[] not null default '{}',
  status       text not null default 'pending' check (status in ('pending','approved','rejected','hidden')),
  ai_verdict   text,
  ai_reason    text,
  ai_category  text,
  signals      text[] not null default '{}',
  appeal       boolean not null default false,
  ref_code     text not null unique,
  referred_by  text,
  text_hash    text not null,
  email_hash   text not null,
  ip_hash      text not null,
  reviewed_at  timestamptz,
  reviewed_by  text
);
create index if not exists stories_status_created on stories (status, created_at desc);
create index if not exists stories_text_hash on stories (text_hash);
create index if not exists stories_email_hash on stories (email_hash);

-- Email list (private). Owned by the movement, not by any social network.
create table if not exists signups (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  email       text not null unique,
  first_name  text,
  state       text,
  ref_code    text,
  referred_by text,
  consent     boolean not null default false
);
create index if not exists signups_referred_by on signups (referred_by);

-- Moderation team: personal tokens are stored only as hashes
create table if not exists moderators (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  role       text not null check (role in ('admin','moderator')),
  token_hash text not null unique,
  active     boolean not null default true
);

-- Audit log: who approved / rejected / hid what, and team changes
create table if not exists mod_actions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  story_id       uuid references stories(id) on delete set null,
  moderator_id   uuid references moderators(id) on delete set null,
  moderator_name text,
  action         text not null,
  note           text
);

-- Rate-limit events (old rows can be deleted any time)
create table if not exists rate_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ip_hash    text not null,
  kind       text not null
);
create index if not exists rate_events_lookup on rate_events (ip_hash, kind, created_at);

-- Tally board: approved stories per state
create or replace view state_counts with (security_invoker = true) as
  select state, count(*)::int as n from stories where status = 'approved' group by state;

alter table pledges     enable row level security;
alter table stories     enable row level security;
alter table signups     enable row level security;
alter table moderators  enable row level security;
alter table mod_actions enable row level security;
alter table rate_events enable row level security;
