-- Adds repeating tasks and snooze to an existing deployment. Run once:
--
--   npx wrangler d1 execute todo --remote --file=./migrations/003-recurring-and-snooze.sql
--
-- Re-running fails harmlessly with "duplicate column name".

-- Hide a task until this date. Null means it is live now.
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;

-- null | daily | weekdays | weekly | monthly. When a repeating task is
-- completed, the next occurrence is created immediately - the schedule follows
-- what you actually did rather than piling up missed copies.
ALTER TABLE tasks ADD COLUMN recur TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_snoozed ON tasks (snoozed_until);
