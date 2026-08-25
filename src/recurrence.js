// Repeating tasks and snooze.
//
// Recurrence fires on completion rather than on a clock. If you finish the
// weekly invoice reconciliation on Wednesday, the next one is due a week from
// Wednesday - not a week from whenever the schedule thought it should be. It
// also means missing a week produces one task to catch up on, not seven.

const DAY_MS = 24 * 60 * 60 * 1000;

export const RECUR_OPTIONS = ['daily', 'weekdays', 'weekly', 'monthly'];

export const RECUR_LABELS = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
  monthly: 'Every month',
};

export function cleanRecur(value) {
  const r = String(value ?? '').toLowerCase().trim();
  return RECUR_OPTIONS.includes(r) ? r : null;
}

/** Accept only YYYY-MM-DD, or null. */
export function cleanDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : s;
}

const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The next due date for a repeating task.
 *
 * Counts forward from whichever is later: the task's own deadline, or today.
 * Without that, completing a task that was three weeks overdue would schedule
 * the next one in the past, and it would arrive already late.
 */
export function nextOccurrence(recur, fromISO, todayISO) {
  const rule = cleanRecur(recur);
  if (!rule) return null;

  const base = cleanDate(fromISO) && Date.parse(`${fromISO}T00:00:00Z`) > Date.parse(`${todayISO}T00:00:00Z`)
    ? fromISO
    : todayISO;

  const baseMs = Date.parse(`${base}T00:00:00Z`);
  if (Number.isNaN(baseMs)) return null;

  if (rule === 'daily') return toISO(baseMs + DAY_MS);

  if (rule === 'weekdays') {
    // Skip forward to the next Monday-to-Friday day.
    let cursor = baseMs + DAY_MS;
    for (let i = 0; i < 7; i++) {
      const day = new Date(cursor).getUTCDay();
      if (day !== 0 && day !== 6) return toISO(cursor);
      cursor += DAY_MS;
    }
    return toISO(cursor);
  }

  if (rule === 'weekly') return toISO(baseMs + 7 * DAY_MS);

  if (rule === 'monthly') {
    // Calendar month, clamped: the 31st becomes the 30th, or the 28th/29th in
    // February, rather than spilling into the following month.
    const d = new Date(baseMs);
    const targetDay = d.getUTCDate();
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDay));
    return toISO(next.getTime());
  }

  return null;
}

/** Is this task hidden right now? */
export function isSnoozed(task, todayISO) {
  const until = deferredUntil(task);
  if (!until) return false;
  return Date.parse(`${until}T00:00:00Z`) > Date.parse(`${todayISO}T00:00:00Z`);
}

/**
 * The date a task comes back into view, or null if it is already visible.
 *
 * Two ways to be out of sight, and every list treats them identically: an
 * explicit snooze, or `hide_until_due` on a task there is nothing to do about
 * before its deadline. The flag rather than a snooze date is what lets a
 * recurring task carry the behaviour into its next occurrence.
 */
export function deferredUntil(task) {
  const snoozed = cleanDate(task.snoozed_until);
  if (snoozed) return snoozed;
  return Number(task.hide_until_due) ? cleanDate(task.deadline) : null;
}

/** Snooze shortcuts, resolved against today. */
export function snoozeDate(preset, todayISO) {
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  if (Number.isNaN(todayMs)) return null;

  if (preset === 'tomorrow') return toISO(todayMs + DAY_MS);
  if (preset === 'weekend') {
    // The coming Saturday.
    let cursor = todayMs + DAY_MS;
    for (let i = 0; i < 7; i++) {
      if (new Date(cursor).getUTCDay() === 6) return toISO(cursor);
      cursor += DAY_MS;
    }
  }
  if (preset === 'nextweek') {
    // The coming Monday.
    let cursor = todayMs + DAY_MS;
    for (let i = 0; i < 8; i++) {
      if (new Date(cursor).getUTCDay() === 1) return toISO(cursor);
      cursor += DAY_MS;
    }
  }
  return cleanDate(preset);
}

/** Human label for a snooze, relative to today. */
export function snoozeLabel(until, todayISO) {
  const date = cleanDate(until);
  if (!date) return null;
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / DAY_MS,
  );
  if (days <= 0) return null;
  if (days === 1) return 'hidden until tomorrow';
  if (days <= 6) return `hidden ${days} more days`;
  return `hidden until ${date}`;
}
