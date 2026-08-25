-- Clinical schedule synced from a QGenda-style calendar feed, plus a mapping
-- from assignment names to how many hours they actually consume.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/006-clinical-schedule.sql
--
-- The feed is the source of truth for WHAT and WHEN. It cannot know how long a
-- service day really is - an all-day "MICU Service" entry carries no hours - so
-- the mapping supplies that.

CREATE TABLE IF NOT EXISTS schedule_days (
  date         TEXT NOT NULL,
  title        TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  all_day      INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT NOT NULL,
  PRIMARY KEY (date, title, start_time)
);

CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_days (date);

-- "MICU" matching an assignment called "MICU Service - Attending" gives 10h.
-- Matching is case-insensitive substring, longest pattern wins, so a specific
-- rule can override a general one.
CREATE TABLE IF NOT EXISTS service_hours (
  pattern      TEXT PRIMARY KEY,
  minutes      INTEGER NOT NULL,
  notes        TEXT NOT NULL DEFAULT ''
);
