-- Adds the daily workout routine to an existing deployment, and seeds a
-- starting week. Run once:
--
--   npx wrangler d1 execute todo --remote --file=./migrations/002-add-workouts.sql
--
-- Safe to re-run: the tables use IF NOT EXISTS and the seed uses OR IGNORE, so
-- it will not overwrite a plan you have since edited.

CREATE TABLE IF NOT EXISTS workout_plan (
  day_of_week       INTEGER PRIMARY KEY,
  title             TEXT NOT NULL,
  modality          TEXT NOT NULL DEFAULT 'strength',
  duration_minutes  INTEGER,
  instructor        TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS workout_log (
  date        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  logged_at   TEXT NOT NULL
);

-- A returning-to-training week: five training days, one mobility day, one rest.
-- Weekdays are 30 minutes, Saturday is the longer session.
INSERT OR IGNORE INTO workout_plan (day_of_week, title, modality, duration_minutes, instructor, notes) VALUES
  (0, 'Rest day',                  'rest',     0,  '', 'Nothing scheduled. A walk if you feel like it.'),
  (1, 'Full Body Strength',        'strength', 30, '', 'Compound movements. Leave a rep or two in reserve while you rebuild.'),
  (2, 'Power Zone Endurance Ride', 'bike',     30, '', 'Zones 2-3. Conversational the whole way.'),
  (3, 'Yoga Flow or Full Body Stretch', 'yoga', 30, '', 'Mobility, not a workout. This is the day people skip and then get hurt.'),
  (4, 'Upper Body + Core',         'strength', 30, '', '20 min upper body, 10 min core.'),
  (5, 'Endurance Run or Walk+Run', 'run',      30, '', 'Easy pace. Walk intervals are fine and are not cheating.'),
  (6, 'Long Endurance Ride',       'bike',     60, '', '45 min ride plus a 15 min stretch. The one real aerobic block of the week.');
