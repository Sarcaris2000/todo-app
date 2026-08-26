// Writing iCalendar, so the rest of your calendar can read this one.
//
// The app already reads .ics - that is how the clinical rota gets in. This is
// the other direction: a feed your phone, Mac and watch can subscribe to, so a
// dinner you typed here shows up on the lock screen next to everything else
// without anyone re-entering it.
//
// Two decisions shape the whole file:
//
// 1. Everything is expanded into concrete dated events. No RRULE. A weekly
//    commitment could be one recurring event, but a recurrence rule anchored
//    to a UTC instant drifts by an hour across a daylight-saving boundary, and
//    the fix for that is VTIMEZONE, which is a lot of fragile text for a
//    calendar that only ever looks a couple of months ahead. Expanding is
//    duller and exactly right.
//
// 2. Every time is emitted as a UTC instant, converted per-event from the
//    wall-clock time in your timezone. Same reasoning: the conversion is done
//    once, here, by code that can be tested, rather than delegated to whatever
//    the subscribing client believes about Chicago.

const PRODID = '-//To Do//Calendar Feed//EN';

/** Text escaping per RFC 5545 s3.3.11. Order matters: backslash first. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold to 75 octets per line, per RFC 5545 s3.1.
 *
 * Counted in UTF-8 bytes rather than characters, and never split inside a
 * multi-byte character - a title with an accent or an em dash would otherwise
 * arrive as mojibake in a client that reassembles the line strictly.
 */
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off to a character boundary: continuation bytes are 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
    limit = 74; // continuation lines carry a leading space
  }
  return out.join('\r\n ');
}

/**
 * How far a timezone was from UTC at a given instant.
 *
 * Intl is the only thing in the runtime that knows the rules, and it only goes
 * the other way - instant to wall clock - so this reads a wall clock back out
 * and measures the gap.
 */
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const at = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // Some engines render midnight as hour 24; both mean the same instant.
  const asIfUtc = Date.UTC(
    Number(at.year), Number(at.month) - 1, Number(at.day),
    Number(at.hour) % 24, Number(at.minute), Number(at.second),
  );
  return asIfUtc - utcMs;
}

/**
 * A wall-clock time in a timezone, as a UTC instant.
 *
 * Two passes: the first offset is looked up at the wrong instant (we do not
 * know the right one yet), the second at the corrected one. That settles every
 * case except the hour that does not exist on a spring-forward morning, which
 * lands on the hour after - the same thing a phone alarm does.
 */
export function zonedToUtc(dateISO, hhmm, timeZone) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO));
  if (!day) throw new Error(`zonedToUtc: bad date ${dateISO}`);

  // Strict on purpose. An earlier version coerced whatever it was given and
  // let NaN fall through to midnight, so passing a display string like "7am"
  // produced a real, plausible, completely wrong 00:00 entry rather than an
  // error. Silently wrong times are the worst thing a calendar can publish.
  const clock = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '00:00'));
  if (!clock) throw new Error(`zonedToUtc: bad time ${hhmm}`);
  const hh = Number(clock[1]);
  const mi = Number(clock[2]);
  if (hh > 23 || mi > 59) throw new Error(`zonedToUtc: out of range ${hhmm}`);

  const [, y, m, d] = day.map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mi);

  const firstPass = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(firstPass, timeZone);
}

const pad = (n) => String(n).padStart(2, '0');

/** 20260827T190000Z */
export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 420 -> "07:00". The inverse of a clock time, not a display label. */
export function toHHMM(minutes) {
  const total = Math.max(0, Math.min(Math.round(minutes), 24 * 60 - 1));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 20260827, for an all-day entry. */
export const dateStamp = (iso) => String(iso).replace(/-/g, '');

const shiftDate = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * One VEVENT.
 *
 * `busy` is the free/busy hint. Anything you are not actually obliged to
 * attend - a meeting you rarely make, back-up cover - is marked transparent,
 * so other people's scheduling tools do not treat your whole week as blocked.
 */
export function vevent({ uid, title, dateISO, start, end, timeZone, notes, busy = true, stamp }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`];

  // Anything that is not a clock time is treated as absent, so a malformed
  // row becomes an honest all-day entry instead of a confident midnight one.
  const clock = (v) => (/^\d{1,2}:\d{2}$/.test(String(v ?? '')) ? String(v) : null);
  start = clock(start);
  end = clock(end);

  if (start) {
    const from = zonedToUtc(dateISO, start, timeZone);
    // An event with no stated end is given an hour, because a zero-length
    // event is invisible in most calendar grids.
    const to = end ? zonedToUtc(dateISO, end, timeZone) : from + 3600000;
    lines.push(`DTSTART:${utcStamp(from)}`, `DTEND:${utcStamp(to > from ? to : from + 3600000)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(dateISO)}`,
      `DTEND;VALUE=DATE:${dateStamp(shiftDate(dateISO, 1))}`);
  }

  lines.push(`SUMMARY:${escapeText(title)}`);
  if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
  lines.push(`TRANSP:${busy ? 'OPAQUE' : 'TRANSPARENT'}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Wrap a set of events into a calendar.
 *
 * X-WR-CALNAME is not in the standard but is what Apple and Google actually
 * read to name a subscription; without it the calendar is titled with its URL.
 */
export function buildCalendar(name, eventLines) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    // A subscribing client polls on its own schedule; this is the polite hint
    // that hourly is often enough.
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    ...eventLines,
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

export { shiftDate };
