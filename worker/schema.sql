-- Draft Ossoff 2028 — database schema for Cloudflare D1 (SQLite).
-- Applied automatically by the "Deploy API" GitHub workflow. Safe to run again.
-- Arrays (tags, signals, roles) are stored as JSON text; booleans as 0/1; times as ISO-8601 text.

CREATE TABLE IF NOT EXISTS pledges (
  ip_hash    TEXT PRIMARY KEY,
  answer     TEXT NOT NULL CHECK (answer IN ('yes','unsure')),
  state      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stories (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  first_name   TEXT NOT NULL,
  state        TEXT NOT NULL,
  text         TEXT NOT NULL,
  headline     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','hidden')),
  ai_verdict   TEXT,
  ai_reason    TEXT,
  ai_category  TEXT,
  signals      TEXT NOT NULL DEFAULT '[]',
  appeal       INTEGER NOT NULL DEFAULT 0,
  ref_code     TEXT NOT NULL UNIQUE,
  referred_by  TEXT,
  text_hash    TEXT NOT NULL,
  email_hash   TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  reviewed_at  TEXT,
  reviewed_by  TEXT
);
CREATE INDEX IF NOT EXISTS stories_status_created ON stories (status, created_at);
CREATE INDEX IF NOT EXISTS stories_text_hash ON stories (text_hash);
CREATE INDEX IF NOT EXISTS stories_email_hash ON stories (email_hash);

CREATE TABLE IF NOT EXISTS signups (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  first_name  TEXT,
  state       TEXT,
  ref_code    TEXT,
  referred_by TEXT,
  consent     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS signups_referred_by ON signups (referred_by);

CREATE TABLE IF NOT EXISTS moderators (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','moderator')),
  token_hash TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mod_actions (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  story_id       TEXT,
  moderator_id   TEXT,
  moderator_name TEXT,
  action         TEXT NOT NULL,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS volunteers (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  state      TEXT NOT NULL,
  roles      TEXT NOT NULL DEFAULT '[]',
  hours      TEXT,
  about      TEXT,
  links      TEXT,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','active','declined')),
  ip_hash    TEXT
);

CREATE TABLE IF NOT EXISTS rate_events (
  created_at TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  kind       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_lookup ON rate_events (ip_hash, kind, created_at);

-- Supporters by state: "yes" votes that named a state, plus published stories.
DROP VIEW IF EXISTS state_counts;
CREATE VIEW state_counts AS
  SELECT state, COUNT(*) AS n FROM (
    SELECT state FROM pledges WHERE answer = 'yes' AND state IS NOT NULL
    UNION ALL
    SELECT state FROM stories WHERE status = 'approved'
  ) GROUP BY state;
