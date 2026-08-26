-- Events could only ever be weekly commitments: an event row carries a
-- day_of_week, so "Dinner on the 12th at 7pm" had nowhere to live and had to
-- be filed as a task with a deadline, which is not the same thing.
--
-- A date makes the row a one-off on that day. day_of_week stays populated (it
-- is NOT NULL, and SQLite cannot drop that without rebuilding the table) but is
-- ignored whenever date is set - it is derived from the date, so the two can
-- never disagree.
ALTER TABLE events ADD COLUMN date TEXT;

CREATE INDEX IF NOT EXISTS idx_events_date ON events (date);
