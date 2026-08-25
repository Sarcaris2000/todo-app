-- Some assignments overlap and some genuinely stack.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/007-concurrency-groups.sql
--
-- Covering the ICU and carrying the chest tube pager on the same weekend is
-- one block of time, not two. Doing clinic while on an inpatient service is
-- two - a long day, but a real one. A single global rule gets one of those
-- wrong, so assignments carry a group: same group counts once (the longest),
-- different groups add up.

ALTER TABLE service_hours ADD COLUMN concurrency_group TEXT;
