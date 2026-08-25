'use strict';

/**
 * Natural-language quick add.
 *
 * Turns "Call Riverside friday 3pm p1 #work 30m" into structured fields and a
 * cleaned-up title. Runs in the browser so the preview updates as you type -
 * a round trip per keystroke would be too slow to be useful, and a parser you
 * cannot see the output of is one you will not trust.
 *
 * Everything it recognises is optional. Type a plain sentence and you get a
 * plain task, which is the behaviour that matters most.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseQuickAdd(input, todayISO) {
  const original = String(input ?? '');
  let text = ` ${original} `;

  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  const matched = [];

  const take = (regex, handler) => {
    const m = regex.exec(text);
    if (!m) return false;
    if (handler(m) === false) return false;
    matched.push(m[0].trim());
    text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
    return true;
  };

  const result = {
    title: '',
    deadline: null,
    priority: 2,
    category: null,
    estimate_minutes: null,
    recur: null,
  };

  // --- repeat, before dates: "every friday" must not be read as "friday" ---
  take(/\bevery\s+(day|daily)\b/i, () => { result.recur = 'daily'; });
  take(/\bevery\s+(weekday|weekdays)\b/i, () => { result.recur = 'weekdays'; });
  take(/\bevery\s+(week|weekly)\b/i, () => { result.recur = 'weekly'; });
  take(/\bevery\s+(month|monthly)\b/i, () => { result.recur = 'monthly'; });
  take(/\b(daily)\b/i, () => { if (result.recur) return false; result.recur = 'daily'; });
  take(/\b(weekly)\b/i, () => { if (result.recur) return false; result.recur = 'weekly'; });
  take(/\b(monthly)\b/i, () => { if (result.recur) return false; result.recur = 'monthly'; });

  // "every tuesday" is weekly AND sets the first occurrence to that Tuesday.
  take(/\bevery\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i, (m) => {
    result.recur = 'weekly';
    const target = WEEKDAYS[m[1].toLowerCase()];
    let cursor = todayMs + DAY_MS;
    for (let i = 0; i < 7; i++) {
      if (new Date(cursor).getUTCDay() === target) { result.deadline = iso(cursor); break; }
      cursor += DAY_MS;
    }
  });

  // --- folder ---
  take(/\s#(work|personal|fitness)\b/i, (m) => { result.category = m[1].toLowerCase(); });

  // --- priority: p1/p2/p3, or !/!!/!!! ---
  take(/\sp([123])\b/i, (m) => { result.priority = Number(m[1]); });
  take(/\s(!{1,3})(?=\s)/, (m) => {
    // More marks means more urgent: !!! is high.
    result.priority = m[1].length >= 3 ? 1 : m[1].length === 2 ? 1 : 2;
  });

  // --- duration: 30m, 45min, 1h, 1.5h, 90 minutes ---
  take(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/i, (m) => {
    result.estimate_minutes = Math.round(parseFloat(m[1]) * 60);
  });
  take(/\s(\d+)\s*(m|min|mins|minute|minutes)\b/i, (m) => {
    if (result.estimate_minutes) return false;
    result.estimate_minutes = Number(m[1]);
  });

  // --- dates, most specific first ---
  if (!result.deadline) {
    take(/\btoday\b/i, () => { result.deadline = todayISO; })
    || take(/\btomorrow\b|\btmrw\b/i, () => { result.deadline = iso(todayMs + DAY_MS); })
    || take(/\bin\s+(\d+)\s+(day|days)\b/i, (m) => { result.deadline = iso(todayMs + Number(m[1]) * DAY_MS); })
    || take(/\bin\s+(\d+)\s+(week|weeks)\b/i, (m) => { result.deadline = iso(todayMs + Number(m[1]) * 7 * DAY_MS); })
    || take(/\bnext\s+week\b/i, () => {
      // The coming Monday.
      let cursor = todayMs + DAY_MS;
      for (let i = 0; i < 8; i++) {
        if (new Date(cursor).getUTCDay() === 1) { result.deadline = iso(cursor); return; }
        cursor += DAY_MS;
      }
    })
    // "Aug 30" / "30 Aug" / "August 30th"
    || take(/\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
      (m) => { result.deadline = monthDay(MONTHS[m[1].toLowerCase()], Number(m[2]), todayMs); })
    || take(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/i,
      (m) => { result.deadline = monthDay(MONTHS[m[2].toLowerCase()], Number(m[1]), todayMs); })
    // 2026-09-01
    || take(/\b(\d{4}-\d{2}-\d{2})\b/, (m) => { result.deadline = m[1]; })
    // A bare weekday means the next one coming up.
    || take(/\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i, (m) => {
      const target = WEEKDAYS[m[1].toLowerCase()];
      let cursor = todayMs + DAY_MS;
      for (let i = 0; i < 7; i++) {
        if (new Date(cursor).getUTCDay() === target) { result.deadline = iso(cursor); return; }
        cursor += DAY_MS;
      }
    });
  }

  // A time of day is recognised so it does not pollute the title, but the
  // app schedules by date only, so it is dropped rather than stored.
  take(/\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/i, () => {});

  result.title = text.replace(/\s+/g, ' ').trim();

  // If parsing consumed the whole thing, the input was all metadata and no
  // task. Better to hand back the original than an empty title.
  if (!result.title) result.title = original.trim();

  return { ...result, matched };
}

/** Month/day in the current year, or next year if that date has passed. */
function monthDay(monthIndex, day, todayMs) {
  if (monthIndex === undefined || !day || day < 1 || day > 31) return null;
  const today = new Date(todayMs);
  let candidate = Date.UTC(today.getUTCFullYear(), monthIndex, day);
  if (candidate < todayMs) candidate = Date.UTC(today.getUTCFullYear() + 1, monthIndex, day);
  return new Date(candidate).toISOString().slice(0, 10);
}


// Exported for the Worker, and also hung on globalThis so the classic-script
// app.js can reach it once this module has executed.
export { parseQuickAdd };
globalThis.parseQuickAdd = parseQuickAdd;
