-- Some tasks are only actionable on the day they are due, and seeing them for
-- a week beforehand is pure noise. The weekly "send Claude this week's
-- calendar" prompt is the motivating case: there is nothing to do about it on
-- a Tuesday.
--
-- Deliberately a flag rather than a snooze date, so that a recurring task
-- carries the behaviour forward to every future occurrence.
ALTER TABLE tasks ADD COLUMN hide_until_due INTEGER NOT NULL DEFAULT 0;
