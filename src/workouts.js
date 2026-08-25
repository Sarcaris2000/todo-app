// The daily workout routine: a fixed weekly template, plus a log of what you
// actually did. Kept separate from tasks because a recurring commitment is a
// different thing from a to-do - it should not compete with real deadlines for
// a place in the ranking, and completing it should not leave 365 rows a year
// in your task history.

const DAY_MS = 24 * 60 * 60 * 1000;

export const MODALITIES = ['bike', 'run', 'strength', 'yoga', 'walk', 'rest'];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Day of week (0 = Sunday) in a given timezone. */
export function localDayOfWeek(timeZone, date = new Date()) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return WEEKDAY_INDEX[short] ?? 0;
}

/** Day of week for a plain YYYY-MM-DD, timezone-independent. */
export function dayOfWeekForISO(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : new Date(ms).getUTCDay();
}

export function cleanModality(value) {
  const m = String(value ?? '').toLowerCase().trim();
  return MODALITIES.includes(m) ? m : 'strength';
}

/** A single day's entry, sanitised. */
export function cleanPlanEntry(input) {
  const title = String(input.title ?? '').trim().slice(0, 120) || 'Rest day';
  const modality = cleanModality(input.modality);
  const raw = Number(input.duration_minutes);
  const duration = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), 600) : null;

  return {
    title,
    modality,
    // A rest day with a duration is a contradiction; normalise it away.
    duration_minutes: modality === 'rest' ? null : duration,
    instructor: String(input.instructor ?? '').trim().slice(0, 60),
    notes: String(input.notes ?? '').trim().slice(0, 500),
  };
}

export async function getPlan(env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM workout_plan ORDER BY day_of_week').all();
  return results ?? [];
}

export async function getPlanForDay(env, dayOfWeek) {
  return env.DB.prepare('SELECT * FROM workout_plan WHERE day_of_week = ?')
    .bind(dayOfWeek).first();
}

export async function savePlanEntry(env, dayOfWeek, input) {
  const entry = cleanPlanEntry(input);
  await env.DB.prepare(
    `INSERT INTO workout_plan (day_of_week, title, modality, duration_minutes, instructor, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day_of_week) DO UPDATE SET
       title = excluded.title,
       modality = excluded.modality,
       duration_minutes = excluded.duration_minutes,
       instructor = excluded.instructor,
       notes = excluded.notes`,
  ).bind(
    dayOfWeek, entry.title, entry.modality,
    entry.duration_minutes, entry.instructor, entry.notes,
  ).run();
  return getPlanForDay(env, dayOfWeek);
}

export async function getLog(env, isoDate) {
  return env.DB.prepare('SELECT * FROM workout_log WHERE date = ?').bind(isoDate).first();
}

export async function logWorkout(env, isoDate, status, title) {
  if (status === 'clear') {
    await env.DB.prepare('DELETE FROM workout_log WHERE date = ?').bind(isoDate).run();
    return null;
  }

  const value = status === 'skipped' ? 'skipped' : 'done';
  await env.DB.prepare(
    `INSERT INTO workout_log (date, status, title, logged_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET status = excluded.status, logged_at = excluded.logged_at`,
  ).bind(isoDate, value, String(title ?? '').slice(0, 120), new Date().toISOString()).run();

  return getLog(env, isoDate);
}

/**
 * Consecutive days ending today, counting a scheduled rest day as maintaining
 * the streak rather than breaking it - otherwise the plan would punish you for
 * following it. Today not being logged yet is also not a break; the streak
 * simply hasn't extended.
 */
export async function currentStreak(env, todayISO) {
  const plan = await getPlan(env);
  const restDays = new Set(plan.filter((p) => p.modality === 'rest').map((p) => p.day_of_week));

  const { results } = await env.DB
    .prepare("SELECT date, status FROM workout_log WHERE status = 'done'").all();
  const doneDates = new Set((results ?? []).map((r) => r.date));

  let streak = 0;
  let cursor = Date.parse(`${todayISO}T00:00:00Z`);
  if (Number.isNaN(cursor)) return 0;

  // Today counts only if already logged; yesterday backwards must be complete.
  for (let i = 0; i < 400; i++) {
    const iso = new Date(cursor).toISOString().slice(0, 10);
    const isRest = restDays.has(new Date(cursor).getUTCDay());

    if (doneDates.has(iso)) streak++;
    else if (isRest) { /* rest days pass through without adding */ }
    else if (i === 0) { /* today simply isn't done yet */ }
    else break;

    cursor -= DAY_MS;
  }

  return streak;
}

/** Everything the UI and the digest need about today. */
export async function todayWorkout(env, todayISO, timeZone) {
  const dayOfWeek = localDayOfWeek(timeZone);
  const entry = await getPlanForDay(env, dayOfWeek);
  const log = await getLog(env, todayISO);

  return {
    day_of_week: dayOfWeek,
    day_name: DAY_NAMES[dayOfWeek],
    workout: entry ?? null,
    status: log?.status ?? null,
    streak: await currentStreak(env, todayISO),
  };
}

/**
 * Days where a high-impact session sits directly after another one.
 *
 * Running loads bone and tendon far more than riding does, and those tissues
 * adapt slower than the cardiovascular system that makes you feel ready. Two
 * run days in a row is the classic way a comeback turns into a stress
 * reaction. Advisory only - it warns, it does not stop you.
 */
export const HIGH_IMPACT = ['run'];

export function backToBackImpactDays(plan) {
  const byDay = new Map(plan.map((p) => [p.day_of_week, p]));
  const clashes = [];

  for (let day = 0; day < 7; day++) {
    const today = byDay.get(day);
    const next = byDay.get((day + 1) % 7);
    if (!today || !next) continue;
    if (HIGH_IMPACT.includes(today.modality) && HIGH_IMPACT.includes(next.modality)) {
      clashes.push({ day, nextDay: (day + 1) % 7, name: DAY_NAMES[day], nextName: DAY_NAMES[(day + 1) % 7] });
    }
  }

  return clashes;
}

/** One-line summary for the morning notification. */
export function workoutDigestLine(entry) {
  if (!entry || entry.modality === 'rest') return 'Rest day - nothing scheduled.';

  const bits = [entry.title];
  if (entry.duration_minutes) bits.push(`${entry.duration_minutes} min`);
  if (entry.instructor) bits.push(entry.instructor);
  return bits.join(' · ');
}
