// A deliberately small iCalendar reader.
//
// Only what a QGenda-style assignment feed actually contains: VEVENT blocks
// with SUMMARY, DTSTART and DTEND. No RRULE expansion, no VTIMEZONE database,
// no alarms. Feeds like this publish discrete dated assignments rather than
// recurrence rules, and pretending to support the whole of RFC 5545 would mean
// a lot of code that never runs.

/**
 * Undo RFC 5545 line folding.
 *
 * Long lines are split with CRLF followed by a single space or tab. Miss this
 * and a long assignment name silently truncates mid-word.
 */
function unfold(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/** `DTSTART;TZID=America/Chicago:20260824T080000` -> name, params, value. */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(';');

  const params = {};
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }

  return { name: name.toUpperCase(), params, value };
}

/** Escaped text: \, \; \n and so on. */
function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * An iCalendar date or date-time.
 *
 * Returns { date, time } where date is YYYY-MM-DD and time is HH:MM or null
 * for an all-day entry. Floating and TZID times are read at face value: the
 * feed publishes local hospital time, which is the timezone the user is in,
 * and guessing otherwise would shift every shift by an offset.
 */
function toZone(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

export function parseIcsDate(value, params = {}, timeZone = 'UTC') {
  const raw = String(value ?? '').trim();

  // All-day: VALUE=DATE, or a bare YYYYMMDD.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly && (params.VALUE === 'DATE' || raw.length === 8)) {
    return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: null };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!dt) return null;

  const [, y, mo, d, h, mi, , zulu] = dt;

  // A trailing Z is a real UTC instant and must be converted into the user's
  // timezone. Left as-is, a 14:00Z conference shows at 2pm instead of 9am -
  // and the date can be wrong too, either side of midnight.
  if (zulu) {
    return toZone(Date.UTC(+y, +mo - 1, +d, +h, +mi), timeZone);
  }

  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

/** Minutes between two HH:MM values on the same day, or 0. */
export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const n = (eh * 60 + em) - (sh * 60 + sm);
  return n > 0 ? n : 0;
}

/**
 * Every VEVENT in the feed, as { date, title, start_time, end_time, all_day }.
 *
 * An event spanning midnight, or an all-day event covering several days, is
 * expanded into one entry per date - the app asks "what is on today", so a
 * multi-day block has to appear on each of its days.
 */
export function parseIcs(text, { maxEvents = 2000, timeZone = 'UTC' } = {}) {
  const lines = unfold(text).split('\n');
  const events = [];

  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === 'BEGIN:VEVENT') { current = {}; continue; }

    if (trimmed === 'END:VEVENT') {
      if (current?.start && current.summary) {
        const start = current.start;
        const end = current.end;

        // DTEND on an all-day event is exclusive: a single day 24th has
        // DTSTART 20260824 and DTEND 20260825. Treating it as inclusive would
        // put an extra phantom day on every all-day assignment.
        let lastDate = start.date;
        if (end && !end.time && end.date > start.date) {
          const ms = Date.parse(`${end.date}T00:00:00Z`) - 86400000;
          lastDate = new Date(ms).toISOString().slice(0, 10);
        } else if (end && end.date > start.date) {
          lastDate = end.date;
        }

        let cursor = Date.parse(`${start.date}T00:00:00Z`);
        const lastMs = Date.parse(`${lastDate}T00:00:00Z`);
        // Guard against a malformed feed claiming a decade-long shift.
        for (let i = 0; cursor <= lastMs && i < 60; i++) {
          const date = new Date(cursor).toISOString().slice(0, 10);
          const single = date === start.date && date === lastDate;

          events.push({
            date,
            title: current.summary,
            start_time: single ? (start.time ?? null) : (date === start.date ? start.time ?? null : null),
            end_time: single ? (end?.time ?? null) : (date === lastDate ? end?.time ?? null : null),
            all_day: !start.time,
          });

          cursor += 86400000;
          if (events.length >= maxEvents) break;
        }
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const parsed = parseLine(trimmed);
    if (!parsed) continue;

    if (parsed.name === 'SUMMARY') current.summary = unescapeText(parsed.value);
    else if (parsed.name === 'DTSTART') current.start = parseIcsDate(parsed.value, parsed.params, timeZone);
    else if (parsed.name === 'DTEND') current.end = parseIcsDate(parsed.value, parsed.params, timeZone);
  }

  return events;
}
