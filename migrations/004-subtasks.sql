-- Checklists inside a task, and a daily capacity setting for the workload
-- warning. Run once:
--
--   npx wrangler d1 execute todo --remote --file=./migrations/004-subtasks.sql
--
-- Re-running fails harmlessly with "duplicate column name".

-- A JSON array of {text, done}. Stored as a column rather than its own table:
-- subtasks are never queried across tasks, only ever read and written with
-- their parent, so a join would buy nothing.
ALTER TABLE tasks ADD COLUMN subtasks TEXT NOT NULL DEFAULT '[]';
