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

export function cleanEvent(input) {
  const title = String(input.title ?? '').trim().slice(0, 120);
  if (!title) throw new Error('Event needs a name');

  const day = Number(input.day_of_week);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error('day_of_week must be 0-6');

  const start = cleanTime(input.start_time);
  let end = cleanTime(input.end_time);

  // An end before its start is almost always a typo rather than an overnight
  // shift; dropping it beats recording a negative duration.
  if (start && end && end <= start) end = null;

  return {
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

export async function listEvents(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM events ORDER BY day_of_week, COALESCE(start_time, \'99:99\'), title',
  ).all();
  return results ?? [];
}

export async function eventsForDay(env, dayOfWeek) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM events WHERE day_of_week = ? ORDER BY COALESCE(start_time, \'99:99\'), title',
  ).bind(dayOfWeek).all();
  return results ?? [];
}

export async function createEvent(env, input) {
  const e = cleanEvent(input);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO events (id, day_of_week, title, start_time, end_time, notes, tentative, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, e.day_of_week, e.title, e.start_time, e.end_time, e.notes,
    e.tentative, new Date().toISOString(),
  ).run();
  return env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
}

export async function updateEvent(env, id, input) {
  const existing = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
  if (!existing) return null;

  const e = cleanEvent({ ...existing, ...input });
  await env.DB.prepare(
    `UPDATE events SET day_of_week = ?, title = ?, start_time = ?, end_time = ?,
                       notes = ?, tentative = ? WHERE id = ?`,
  ).bind(e.day_of_week, e.title, e.start_time, e.end_time, e.notes, e.tentative, id).run();

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
