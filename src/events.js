// Recurring weekly commitments.
//
// An event is not a task. You do not complete clinic; you attend it, and the
// four hours are gone whether or not anything on your list gets done. So these
// never enter the ranking - they subtract from the time available for the
// things that do.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** HH:MM in 24-hour form, or null. */
export function cleanTime(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** YYYY-MM-DD, or null for a weekly commitment. */
export function cleanEventDate(value) {
  const s = String(value ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : s;
}

export function cleanEvent(input) {
  const title = String(input.title ?? '').trim().slice(0, 120);
  if (!title) throw new Error('Event needs a name');

  // A dated event is a one-off; a dateless one recurs weekly. day_of_week is
  // still stored for a one-off (the column is NOT NULL) but is derived from the
  // date rather than supplied, so the two cannot disagree.
  const date = cleanEventDate(input.date);

  const day = date
    ? new Date(`${date}T00:00:00Z`).getUTCDay()
    : Number(input.day_of_week);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('day_of_week must be 0-6');

  const start = cleanTime(input.start_time);
  let end = cleanTime(input.end_time);

  // An end before its start is almost always a typo rather than an overnight
  // shift; dropping it beats recording a negative duration.
  if (start && end && end <= start) end = null;

  return {
    date,
    day_of_week: day,
    title,
    start_time: start,
    end_time: end,
    notes: String(input.notes ?? '').trim().slice(0, 300),
    tentative: input.tentative ? 1 : 0,
  };
}

/** Minutes an event occupies. Untimed events count as zero, not as all day. */
export function eventMinutes(event) {
  // A meeting you keep on the calendar but rarely attend still appears in the
  // brief - it is useful to know it is there - but it must not consume time
  // you will actually spend elsewhere.
  if (event.tentative) return 0;
  if (!event.start_time || !event.end_time) return 0;
  const [sh, sm] = event.start_time.split(':').map(Number);
  const [eh, em] = event.end_time.split(':').map(Number);
  const minutes = (eh * 60 + em) - (sh * 60 + sm);
  return minutes > 0 ? minutes : 0;
}

const to12h = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = ((h + 11) % 12) + 1;
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`;
};

/** "Clinic 8am-12pm" or "Journal club 5pm" or just "Admin". */
export function eventLabel(event) {
  const maybe = event.tentative ? '?' : '';
  if (!event.start_time) return `${event.title}${maybe}`;
  const start = to12h(event.start_time);
  const end = event.end_time ? to12h(event.end_time) : null;
  return `${event.title} ${start}${end ? `-${end}` : ''}${maybe}`;
}

/**
 * Everything on the calendar, for the management list in Settings.
 *
 * Two orderings in one query, because the list holds two different kinds of
 * thing: weekly commitments belong in weekday order, one-offs belong in date
 * order. Sorting one-offs by their derived weekday - which is what happened
 * before - scattered them through the weekly pattern with nothing to mark them
 * apart, so a dinner on the 12th read as "every Saturday".
 *
 * Passing todayISO also drops one-offs that have already happened. The daily
 * purge is what actually removes them; this keeps the list honest in between.
 */
export async function listEvents(env, todayISO = null) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events
      WHERE date IS NULL OR ? IS NULL OR date >= ?
      ORDER BY (date IS NOT NULL),
               CASE WHEN date IS NULL THEN day_of_week END,
               date,
               COALESCE(start_time, '99:99'), title`,
  ).bind(todayISO, todayISO).all();
  return results ?? [];
}

/**
 * Forget one-off events once they are past.
 *
 * A weekly commitment is a standing fact and stays until you remove it. A
 * one-off is spent the moment its day is over, and left alone it would sit in
 * the calendar list forever - so a year of dinners and appointments would bury
 * the handful of commitments the list exists to show. Nothing is completed
 * here in the way a task is; the day simply passed.
 */
export async function purgePastEvents(env, todayISO) {
  const { meta } = await env.DB.prepare(
    'DELETE FROM events WHERE date IS NOT NULL AND date < ?',
  ).bind(todayISO).run();
  return meta?.changes ?? 0;
}

/**
 * One-off events between two dates, for the Upcoming view.
 *
 * Weekly commitments are deliberately excluded: they are already visible as a
 * standing pattern, and repeating each of them on every future day would bury
 * the handful of things that are actually one-offs.
 */
export async function upcomingEvents(env, fromISO, days = 21) {
  const to = new Date(Date.parse(`${fromISO}T00:00:00Z`) + days * 86400000)
    .toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT * FROM events
      WHERE date IS NOT NULL AND date > ? AND date <= ?
      ORDER BY date, COALESCE(start_time, '99:99'), title`,
  ).bind(fromISO, to).all();
  return results ?? [];
}

export async function eventsForDay(env, dayOfWeek, dateISO = null) {
  // Two kinds in one list: the weekly commitment for this weekday, and any
  // one-off falling on this exact date. A weekly row must be excluded when it
  // has a date, or a one-off would also fire every week from then on.
  const { results } = await env.DB.prepare(
    `SELECT * FROM events
      WHERE (date IS NULL AND day_of_week = ?)
         OR (date IS NOT NULL AND date = ?)
      ORDER BY COALESCE(start_time, '99:99'), title`,
  ).bind(dayOfWeek, dateISO).all();
  return results ?? [];
}

export async function createEvent(env, input) {
  const e = cleanEvent(input);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO events (id, date, day_of_week, title, start_time, end_time, notes, tentative, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, e.date, e.day_of_week, e.title, e.start_time, e.end_time, e.notes,
    e.tentative, new Date().toISOString(),
  ).run();
  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function updateEvent(env, id, input) {
  const existing = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!existing) return null;

  const e = cleanEvent({ ...existing, ...input });
  // date belongs in the SET list like anything else. Leaving it out did not
  // corrupt a one-off - the column simply kept its old value, and cleanEvent
  // re-derived a matching weekday - but it made the date the one field on an
  // event that could never be changed. Moving a dinner was impossible.
  await env.DB.prepare(
    `UPDATE events SET date = ?, day_of_week = ?, title = ?, start_time = ?, end_time = ?,
                       notes = ?, tentative = ? WHERE id = ?`,
  ).bind(e.date, e.day_of_week, e.title, e.start_time, e.end_time, e.notes, e.tentative, id).run();

  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function deleteEvent(env, id) {
  await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
}

/** One line for the morning notification, or null if the day is clear. */
export function eventsDigestLine(events) {
  if (!events || !events.length) return null;
  return events.map(eventLabel).join(' · ');
}

export { DAY_NAMES };
