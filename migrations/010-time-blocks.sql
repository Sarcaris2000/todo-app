-- Real clock windows for an assignment, not just a total.
--
--   npx wrangler d1 execute todo --remote --file=./migrations/010-time-blocks.sql
--
-- PFT reading is 8-noon and again 5-7pm. Stored as "360 minutes" the app
-- cannot tell that from a single six-hour block, so it cannot answer the only
-- question that matters: is there room for a two-hour job in there.

ALTER TABLE service_hours ADD COLUMN blocks TEXT;
