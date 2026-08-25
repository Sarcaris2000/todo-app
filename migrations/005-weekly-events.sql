-- Recurring weekly commitments: clinic, teaching, standing meetings.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/005-weekly-events.sql
--
-- Distinct from a recurring task: an event is not something you complete, it
-- is time that is already spoken for. It never enters the task ranking, and it
-- reduces the hours available for everything else.

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  day_of_week  INTEGER NOT NULL,          -- 0 Sunday .. 6 Saturday
  title        TEXT NOT NULL,
  start_time   TEXT,                      -- HH:MM, 24h. Null = all day / no time
  end_time     TEXT,                      -- HH:MM
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_day ON events (day_of_week);
