-- Adds the personal/work folder to existing databases.
--
-- schema.sql uses CREATE TABLE IF NOT EXISTS, so it cannot add a column to a
-- table that already exists. Run this once against an existing deployment:
--
--   npx wrangler d1 execute todo --remote --file=./migrations/001-add-task-category.sql
--
-- Fresh installs get the column from schema.sql and can skip this. Running it
-- twice is harmless - it fails with "duplicate column name", which changes
-- nothing.

ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT 'personal';

CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks (category);
