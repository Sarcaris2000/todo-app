-- Meetings you keep on the calendar but rarely attend.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/009-tentative-events.sql
--
-- Without this they would book time you do not actually spend, and the free
-- time left in your day would read low every single week.

ALTER TABLE events ADD COLUMN tentative INTEGER NOT NULL DEFAULT 0;
