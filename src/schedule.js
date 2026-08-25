// The clinical schedule: fetched from a calendar feed, interpreted with a
// local mapping of what each assignment actually costs in hours.
//
// The feed knows what you are assigned to and on which day. It does not know
// that "MICU Service" is a ten hour day and "Admin" is two - an all-day entry
// carries no duration at all. So the feed supplies the facts and the mapping
// supplies the judgement, which is the part only you can provide.

import { parseIcs, minutesBetween } from './ics.js';
import { parseBlocks, toMinutes } from './freetime.js';

const MAX_FEED_BYTES = 4 * 1024 * 1024;

/** QGenda publishes X-PUBLISHED-TTL:PT240M - it expects a check every 4 hours. */
export const REFRESH_HOURS = 4;

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The mapping that governs an assignment, or null. */
export function matchMapping(title, mappings) {
  const name = String(title ?? '').toLowerCase();

  // Longest pattern first, so "MICU nights" beats a generic "MICU".
  const sorted = [...(mappings ?? [])]
    .filter((m) => m.pattern)
    .sort((a, b) => b.pattern.length - a.pattern.length);

  return sorted.find((m) => name.includes(String(m.pattern).toLowerCase())) ?? null;
}

/** How many minutes an assignment costs, per the mapping. */
export function minutesForTitle(title, mappings) {
  const m = matchMapping(title, mappings);
  return m ? m.minutes : null;
}

/**
 * Total clinical time for one day.
 *
 * Assignments in the same concurrency group are covered at once, so the group
 * costs its longest member rather than the sum - carrying the chest tube pager
 * while running the ICU is one stretch of time. Groups then add together,
 * because clinic on top of an inpatient service really is two commitments and
 * really does make for a very long day.
 *
 * Unmapped assignments are keyed by title, so a shift split across midnight
 * into two rows counts once rather than twice.
 */
export function clinicalMinutesForDay(entries, mappings) {
  const groups = new Map();

  for (const entry of entries ?? []) {
    const mapping = matchMapping(entry.title, mappings);
    const key = mapping?.concurrency_group
      ? `group:${mapping.concurrency_group}`
      : `title:${entry.title}`;
    groups.set(key, Math.max(groups.get(key) ?? 0, entryMinutes(entry, mappings)));
  }

  return [...groups.values()].reduce((total, n) => total + n, 0);
}

/**
 * Minutes an entry occupies.
 *
 * Your mapping wins over the feed's times, which sounds backwards until you
 * look at real data: QGenda pads assignments to generic coverage windows, so
 * an afternoon clinic and a PFT reading session both arrive as ten- and
 * twelve-hour blocks. Those numbers are administratively true and practically
 * useless for working out whether you have a spare half hour.
 *
 * So: an explicit mapping first, the feed's own times as a fallback, and zero
 * rather than a guess when neither knows.
 */
export function entryMinutes(entry, mappings) {
  const mapping = matchMapping(entry.title, mappings);

  // Explicit blocks are the most precise thing available, so they win.
  const blocks = parseBlocks(mapping?.blocks);
  if (blocks) return blocks.reduce((n, b) => n + (b.end - b.start), 0);

  if (mapping) return mapping.minutes;
  return minutesBetween(entry.start_time, entry.end_time);
}

/**
 * When the day is actually occupied, as clock intervals.
 *
 * Separate from the committed total on purpose: the total answers "how much
 * work is there" and can exceed the wall clock on a day with clinic on top of
 * a service. This answers "when could I sit down for an hour", which is a
 * different question with a different answer.
 */
export function busyIntervals(clinical, events, mappings) {
  const out = [];

  for (const entry of clinical ?? []) {
    const mapping = matchMapping(entry.title, mappings);
    const blocks = parseBlocks(mapping?.blocks);
    if (blocks) { out.push(...blocks); continue; }

    // Zero-minute assignments (back-up cover) occupy no clock time.
    if (mapping && mapping.minutes === 0) continue;

    const start = toMinutes(entry.start_time);
    const end = toMinutes(entry.end_time);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }

  for (const event of events ?? []) {
    if (event.tentative) continue;
    const start = toMinutes(event.start_time);
    const end = toMinutes(event.end_time);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }

  return out;
}

export async function getMappings(env) {
  const { results } = await env.DB
    .prepare('SELECT * FROM service_hours ORDER BY LENGTH(pattern) DESC').all();
  return results ?? [];
}

export async function saveMapping(env, pattern, minutes, notes = '', group = null, blocks = null) {
  const key = String(pattern ?? '').trim().slice(0, 80);
  if (!key) throw new Error('Pattern is required');

  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 0 || mins > 24 * 60) {
    throw new Error('Minutes must be 0-1440');
  }

  await env.DB.prepare(
    `INSERT INTO service_hours (pattern, minutes, notes, concurrency_group, blocks)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pattern) DO UPDATE SET
       minutes = excluded.minutes,
       notes = excluded.notes,
       concurrency_group = excluded.concurrency_group,
       blocks = excluded.blocks`,
  ).bind(
    key, Math.round(mins), String(notes ?? '').slice(0, 200),
    group ? String(group).trim().slice(0, 40) : null,
    parseBlocks(blocks) ? JSON.stringify(blocks) : null,
  ).run();
}

export async function deleteMapping(env, pattern) {
  await env.DB.prepare('DELETE FROM service_hours WHERE pattern = ?').bind(pattern).run();
}

export async function scheduleForDate(env, isoDate) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM schedule_days WHERE date = ? ORDER BY COALESCE(start_time, \'99:99\'), title',
  ).bind(isoDate).all();
  return results ?? [];
}

/** Assignments from today forward, for the upcoming view. */
export async function scheduleFrom(env, isoDate, days = 14) {
  const end = new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000)
    .toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT * FROM schedule_days WHERE date >= ? AND date <= ?
     ORDER BY date, COALESCE(start_time, '99:99'), title`,
  ).bind(isoDate, end).all();
  return results ?? [];
}

/**
 * Pull the feed and replace the stored schedule.
 *
 * Replaces rather than merges: the feed is authoritative, and a shift that was
 * cancelled has to disappear rather than linger because nothing overwrote it.
 * Only dates from today forward are touched, so history is preserved.
 */
export async function syncSchedule(env, todayISO, timeZone, options = {}) {
  const url = env.QGENDA_ICS_URL;
  if (!url) return { ok: false, reason: 'No feed configured' };

  // webcal:// is just https:// wearing a hat.
  const fetchUrl = String(url).replace(/^webcal:\/\//i, 'https://');

  let response;
  try {
    response = await fetch(fetchUrl, {
      headers: { Accept: 'text/calendar, text/plain, */*' },
      cf: { cacheTtl: 0 },
    });
  } catch (error) {
    return { ok: false, reason: `Could not reach the feed: ${String(error).slice(0, 120)}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `Feed returned ${response.status}` };
  }

  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) {
    return { ok: false, reason: 'Feed is implausibly large; refusing to parse' };
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    // Almost always a login page rather than a calendar - a wrong or expired URL.
    return { ok: false, reason: 'That URL did not return a calendar' };
  }

  // Most refreshes find nothing changed. Comparing a hash first turns those
  // into a single HTTP request instead of deleting and rewriting hundreds of
  // rows, which is what makes a four-hourly check reasonable at all.
  const hash = await sha256(text);
  if (!options.force) {
    const previous = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schedule_feed_hash'")
      .first();
    if (previous?.value === hash) {
      return { ok: true, unchanged: true, parsed: 0, stored: 0, syncedAt: new Date().toISOString() };
    }
  }

  const events = parseIcs(text, { timeZone });
  const future = events.filter((e) => e.date >= todayISO);

  // Only the feed's own rows. Hand-entered series live in the same table and
  // would otherwise be wiped on the next refresh.
  await env.DB.prepare("DELETE FROM schedule_days WHERE date >= ? AND source = 'qgenda'")
    .bind(todayISO).run();

  const syncedAt = new Date().toISOString();
  for (const e of future) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO schedule_days (date, title, start_time, end_time, all_day, synced_at, source)
       VALUES (?, ?, ?, ?, ?, ?, 'qgenda')`,
    ).bind(
      e.date, e.title.slice(0, 200), e.start_time, e.end_time,
      e.all_day ? 1 : 0, syncedAt,
    ).run();
  }

  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('schedule_feed_hash', ?) "
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(hash).run();

  return {
    ok: true,
    unchanged: false,
    parsed: events.length,
    stored: future.length,
    firstDate: future[0]?.date ?? null,
    lastDate: future[future.length - 1]?.date ?? null,
    syncedAt,
  };
}

/**
 * The next day with nothing rostered, and the next clear weekend.
 *
 * Hard to eyeball in a scheduling app, trivial once a year of assignments is
 * sitting in a table. Back-up cover counts as clear because you said it costs
 * nothing unless activated - if that stops feeling true, give it minutes and
 * these dates will move.
 */
export async function nextFreeDays(env, todayISO, mappings, horizonDays = 120) {
  const end = new Date(Date.parse(`${todayISO}T00:00:00Z`) + horizonDays * 86400000)
    .toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    'SELECT date, title, start_time, end_time FROM schedule_days WHERE date > ? AND date <= ?',
  ).bind(todayISO, end).all();

  const byDate = new Map();
  for (const row of results ?? []) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const isClear = (iso) => clinicalMinutesForDay(byDate.get(iso) ?? [], mappings) === 0;

  let nextDay = null;
  let nextWeekend = null;

  for (let i = 1; i <= horizonDays; i++) {
    const ms = Date.parse(`${todayISO}T00:00:00Z`) + i * 86400000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    const weekday = new Date(ms).getUTCDay();

    if (!nextDay && isClear(iso)) nextDay = iso;

    // A weekend only counts if both days are clear; a free Saturday followed
    // by a call Sunday is not a weekend off.
    if (!nextWeekend && weekday === 6) {
      const sunday = new Date(ms + 86400000).toISOString().slice(0, 10);
      if (isClear(iso) && isClear(sunday)) nextWeekend = { saturday: iso, sunday };
    }

    if (nextDay && nextWeekend) break;
  }

  return { nextFreeDay: nextDay, nextFreeWeekend: nextWeekend };
}

/** One line for the morning brief. */
export function scheduleDigestLine(entries, mappings) {
  if (!entries || !entries.length) return null;

  const t12 = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const hour = ((h + 11) % 12) + 1;
    return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  };

  const pretty = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  };

  return entries.map((e) => {
    // The mapping wins here exactly as it does in the workload maths. Showing
    // the feed's 6am-6pm next to a total that counted zero would have the
    // brief contradicting itself in adjacent lines.
    const mapped = minutesForTitle(e.title, mappings);

    if (mapped !== null && mapped !== undefined) {
      // A deliberate zero means "listed, but costs nothing" - back-up cover
      // you are not expected to actually work. Naming an hour figure there
      // would misrepresent it in either direction.
      return mapped > 0 ? `${e.title} (${pretty(mapped)})` : e.title;
    }

    if (e.start_time && e.end_time) return `${e.title} ${t12(e.start_time)}-${t12(e.end_time)}`;
    return e.title;
  }).join(' · ');
}
