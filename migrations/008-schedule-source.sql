-- Where a schedule row came from.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/008-schedule-source.sql
--
-- The QGenda sync replaces every future row it owns. Without a source column
-- it would also delete anything entered by hand - a conference series, a
-- recurring teaching commitment - the first time it ran.

ALTER TABLE schedule_days ADD COLUMN source TEXT NOT NULL DEFAULT 'qgenda';

CREATE INDEX IF NOT EXISTS idx_schedule_source ON schedule_days (source);
