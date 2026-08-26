-- Task list shared by every device.
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  notes             TEXT NOT NULL DEFAULT '',   -- "what it needs" / context
  category          TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'work'
  deadline          TEXT,                       -- YYYY-MM-DD, null = no deadline
  start_time        TEXT,                       -- HH:MM, optional time of day
  priority          INTEGER NOT NULL DEFAULT 2, -- 1 high, 2 normal, 3 low
  estimate_minutes  INTEGER,                    -- rough effort, optional
  status            TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
  snoozed_until     TEXT,                       -- hidden until this date
  recur             TEXT,                       -- null|daily|weekdays|weekly|monthly
  subtasks          TEXT NOT NULL DEFAULT '[]', -- JSON array of {text, done}
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks (deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks (category);
CREATE INDEX IF NOT EXISTS idx_tasks_snoozed  ON tasks (snoozed_until);

-- One row per device that has granted notification permission.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  device_label  TEXT NOT NULL DEFAULT 'device',
  created_at    TEXT NOT NULL,
  last_success  TEXT,
  last_error    TEXT
);

-- Small key/value store for settings and cron bookkeeping.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per signed-in device. Only a SHA-256 hash of the token is kept, so
-- reading this table gives an attacker nothing they can present back.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  device_label  TEXT NOT NULL DEFAULT 'device',
  created_at    TEXT NOT NULL,
  last_seen     TEXT,
  expires_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions (token_hash);

-- Failed passphrase attempts per IP, used to slow down guessing.
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip             TEXT PRIMARY KEY,
  failures       INTEGER NOT NULL DEFAULT 0,
  first_failure  TEXT,
  last_failure   TEXT,
  locked_until   TEXT,
  alerted_at     TEXT
);

-- Weekly workout template: one row per day of the week (0 = Sunday).
CREATE TABLE IF NOT EXISTS workout_plan (
  day_of_week       INTEGER PRIMARY KEY,   -- 0 Sun .. 6 Sat
  title             TEXT NOT NULL,
  modality          TEXT NOT NULL DEFAULT 'strength', -- bike|run|strength|yoga|walk|rest
  duration_minutes  INTEGER,
  instructor        TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT ''
);

-- One row per day actually trained, so streaks are real rather than guessed.
CREATE TABLE IF NOT EXISTS workout_log (
  date        TEXT PRIMARY KEY,            -- YYYY-MM-DD in the user's timezone
  status      TEXT NOT NULL,               -- 'done' | 'skipped'
  title       TEXT NOT NULL DEFAULT '',
  logged_at   TEXT NOT NULL
);

-- Recurring weekly commitments (clinic, teaching, standing meetings). These
-- are not tasks: they are never completed, only attended, and the time they
-- occupy is subtracted from what is available for actual work.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  day_of_week  INTEGER NOT NULL,
  title        TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  notes        TEXT NOT NULL DEFAULT '',
  -- Shown in the brief, but costs no time: an invite you keep rather than attend.
  tentative    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_day ON events (day_of_week);

-- Clinical schedule synced from a calendar feed (see migrations/006).
CREATE TABLE IF NOT EXISTS schedule_days (
  date         TEXT NOT NULL,
  title        TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  all_day      INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT NOT NULL,
  -- 'qgenda' rows are owned by the feed and replaced on each sync; anything
  -- else was entered by hand and must survive it.
  source       TEXT NOT NULL DEFAULT 'qgenda',
  PRIMARY KEY (date, title, start_time)
);

CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_days (date);

-- How long each named assignment actually takes.
CREATE TABLE IF NOT EXISTS service_hours (
  pattern            TEXT PRIMARY KEY,
  minutes            INTEGER NOT NULL,
  notes              TEXT NOT NULL DEFAULT '',
  -- Assignments sharing a group are covered concurrently and count once;
  -- different groups add. Null means the assignment stands alone.
  concurrency_group  TEXT,
  -- JSON [["08:00","12:00"],["17:00","19:00"]] when the assignment is split
  -- across the day. Null means treat `minutes` as one contiguous block.
  blocks             TEXT
);
