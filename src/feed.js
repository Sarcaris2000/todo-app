// Assembling the subscribable calendar.
//
// Everything the app knows about *when* - the clinical rota, standing
// commitments, one-off dates, and tasks pinned to an hour - collected into one
// file that Apple Calendar, Google Calendar or Fantastical can subscribe to.
//
// The point is not to replace the app. It is that a dinner typed here should
// appear on the lock screen and the watch alongside everything else, without
// anyone entering it twice.
//
// Titles and times only - deliberately no notes. This feed leaves the building:
// it is read by a calendar provider's servers and by anyone holding the link,
// and the warning shown when you create one talks about titles. Publishing the
// notes field as well would have been more than that warning describes, and
// notes are exactly where the detail collects. The feed answers "when"; the app
// still answers "what".

import { listEvents } from './events.js';
import { scheduleFrom, getMappings, matchMapping } from './schedule.js';
import { parseBlocks } from './freetime.js';
// toHHMM below, not freetime's display helper: that one renders "7am" for a
// person to read, and an iCalendar line needs "07:00". Reaching for the wrong
// one produced a feed of confident, plausible, entirely wrong midnight entries.
import { buildCalendar, vevent, utcStamp, shiftDate, toHHMM } from './ics-out.js';

// How much of the past and future to publish. A calendar subscription is
// re-fetched whole, so this is also the size of the file: a couple of months
// keeps it small enough to be re-read every hour without thinking about it.
export const PAST_DAYS = 7;
export const FUTURE_DAYS = 56;

/** A stable per-entry id, so a re-fetch updates rather than duplicates. */
const uid = (kind, key) => `${kind}-${String(key).replace(/[^\w.-]/g, '_')}@todo.local`;

/**
 * The rota, as calendar entries.
 *
 * An assignment with mapped blocks becomes one entry per block, because that
 * is the honest answer to "when are you actually occupied": QGenda pads a PFT
 * reading session to a twelve-hour coverage window, and a calendar showing
 * that is worse than no calendar. Where there is no mapping, the feed's own
 * times stand. Zero-minute cover shows as an all-day marker that does not
 * block your free/busy, since being on back-up is not being busy.
 */
function rotaEvents(entries, mappings, timeZone, stamp) {
  const lines = [];

  for (const entry of entries) {
    const mapping = matchMapping(entry.title, mappings);
    const blocks = parseBlocks(mapping?.blocks);

    if (blocks) {
      blocks.forEach((b, i) => {
        lines.push(...vevent({
          uid: uid('rota', `${entry.date}-${entry.title}-${i}`),
          title: entry.title,
          dateISO: entry.date,
          start: toHHMM(b.start),
          end: toHHMM(b.end),
          timeZone,
          stamp,
        }));
      });
      continue;
    }

    const zeroMinute = mapping && mapping.minutes === 0;
    lines.push(...vevent({
      uid: uid('rota', `${entry.date}-${entry.title}`),
      title: entry.title,
      dateISO: entry.date,
      start: zeroMinute ? null : entry.start_time,
      end: zeroMinute ? null : entry.end_time,
      timeZone,
      busy: !zeroMinute,
      stamp,
    }));
  }

  return lines;
}

/**
 * Standing commitments, expanded across the window.
 *
 * One entry per occurrence rather than a recurrence rule - see the note at the
 * top of ics-out.js for why.
 */
function weeklyEvents(events, fromISO, days, timeZone, stamp) {
  const lines = [];

  for (let i = 0; i <= days; i++) {
    const date = shiftDate(fromISO, i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

    for (const e of events) {
      if (e.day_of_week !== weekday) continue;
      lines.push(...vevent({
        uid: uid('weekly', `${e.id}-${date}`),
        title: e.title,
        dateISO: date,
        start: e.start_time,
        end: e.end_time,
        timeZone,
        // A meeting you rarely attend belongs on the calendar but must not
        // tell anyone else's scheduling tool that you are unavailable.
        busy: !e.tentative,
        stamp,
      }));
    }
  }

  return lines;
}

/**
 * Tasks that carry a time of day.
 *
 * Only these: a task with no hour is not a calendar entry, and publishing a
 * hundred undated to-dos into a calendar app is how a subscription becomes
 * something you unsubscribe from. The estimate gives it a length so it is
 * visible in a day grid; without one it takes the default half hour.
 */
function taskEvents(tasks, timeZone, stamp) {
  const lines = [];

  for (const t of tasks) {
    if (!t.start_time || !t.deadline) continue;
    const minutes = Number(t.estimate_minutes) > 0 ? Number(t.estimate_minutes) : 30;
    const [h, m] = t.start_time.split(':').map(Number);
    const endMinutes = Math.min(h * 60 + m + minutes, 23 * 60 + 59);

    lines.push(...vevent({
      uid: uid('task', t.id),
      title: t.title,
      dateISO: t.deadline,
      start: t.start_time,
      end: toHHMM(endMinutes),
      timeZone,
      // A task is something you intend to do, not somewhere you have to be.
      // Marking it busy would have the app quietly declining your meetings.
      busy: false,
      stamp,
    }));
  }

  return lines;
}

/** The whole feed, as iCalendar text. */
export async function buildFeed(env, todayISO, timeZone, name = 'To Do') {
  const from = shiftDate(todayISO, -PAST_DAYS);
  const to = shiftDate(todayISO, FUTURE_DAYS);
  const stamp = utcStamp(Date.parse(`${todayISO}T00:00:00Z`));

  const [rota, mappings, events, tasks] = await Promise.all([
    scheduleFrom(env, from, PAST_DAYS + FUTURE_DAYS).catch(() => []),
    getMappings(env).catch(() => []),
    listEvents(env).catch(() => []),
    env.DB.prepare(
      `SELECT id, title, notes, deadline, start_time, estimate_minutes
         FROM tasks
        WHERE status = 'open' AND start_time IS NOT NULL
          AND deadline IS NOT NULL AND deadline >= ? AND deadline <= ?`,
    ).bind(from, to).all().then((r) => r.results ?? []).catch(() => []),
  ]);

  const oneOffs = events.filter((e) => e.date && e.date >= from && e.date <= to);
  const weekly = events.filter((e) => !e.date);

  const lines = [
    ...rotaEvents(rota, mappings, timeZone, stamp),
    ...weeklyEvents(weekly, from, PAST_DAYS + FUTURE_DAYS, timeZone, stamp),
    ...oneOffs.flatMap((e) => vevent({
      uid: uid('once', e.id),
      title: e.title,
      dateISO: e.date,
      start: e.start_time,
      end: e.end_time,
      timeZone,
      busy: !e.tentative,
      stamp,
    })),
    ...taskEvents(tasks, timeZone, stamp),
  ];

  return buildCalendar(name, lines);
}
