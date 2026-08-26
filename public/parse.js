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
  //
  // Three spellings, because the hash is unsayable. Dictation transcribes a
  // spoken "#" as the literal word "hashtag", so #work - the only form that
  // used to work - could never be reached by voice, and every dictated task
  // landed in whichever folder the fallback picked.
  take(/\s#(work|personal|fitness)\b/i, (m) => { result.category = m[1].toLowerCase(); })
  || take(/\s(?:hashtag|hash tag)\s+(work|personal|fitness)\b/i,
    (m) => { result.category = m[1].toLowerCase(); });

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
    // "next thursday" is the Thursday of NEXT week - not the one in two days.
    //
    // The parser used to treat "next" as decoration and resolve it the same as
    // a bare weekday, so a task said on a Tuesday for "next Thursday" landed
    // two days out instead of nine. Harmless-looking, and worse once "next"
    // was being swallowed silently: the stray word at least used to show it
    // had not been read. Dictation has no preview at all, so this has to be
    // right rather than merely explainable.
    || take(/\b(?:next)\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i, (m) => {
      const target = WEEKDAYS[m[1].toLowerCase()];
      // Weeks run Monday to Sunday here. With a Sunday start, "next Thursday"
      // said on a Sunday would jump ten days out, which nobody means.
      const mondayThisWeek = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY_MS;
      const offsetFromMonday = (target + 6) % 7;
      result.deadline = iso(mondayThisWeek + (offsetFromMonday + 7) * DAY_MS);
    })
    // "this thursday", "on thursday", or a bare "thursday": the next one
    // coming up. The qualifier is swallowed rather than left in the title.
    || take(/\b(?:this|on|coming)\s+(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b|\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i, (m) => {
      const target = WEEKDAYS[(m[1] || m[2]).toLowerCase()];
      let cursor = todayMs + DAY_MS;
      for (let i = 0; i < 7; i++) {
        if (new Date(cursor).getUTCDay() === target) { result.deadline = iso(cursor); return; }
        cursor += DAY_MS;
      }
    });
  }

  // Times used to be recognised only so they would not pollute the title, then
  // thrown away - the app scheduled by date alone. Events need them, so they
  // are kept now.
  //
  // A RANGE ("7-9pm", "08:00-09:00") reads as an event: a thing that occupies a
  // stretch of the day. A single time stays a task, because "call the lab 3pm"
  // is still something you tick off, and changing that would break every
  // existing habit.
  take(/\b(\d{1,2})(:\d{2})?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(:\d{2})?\s*(am|pm)\b/i, (m) => {
    const meridiem = (m[3] || m[6] || '').toLowerCase();
    result.time = to24h(m[1], m[2], meridiem);
    result.endTime = to24h(m[4], m[5], (m[6] || '').toLowerCase());
    result.kind = 'event';
  })
  || take(/\b(\d{1,2})(:\d{2})\s*(?:-|–|to)\s*(\d{1,2})(:\d{2})\b/, (m) => {
    result.time = to24h(m[1], m[2], '');
    result.endTime = to24h(m[3], m[4], '');
    result.kind = 'event';
  })
  || take(/\b(\d{1,2})(:\d{2})?\s*(am|pm)\b/i, (m) => {
    result.time = to24h(m[1], m[2], m[3].toLowerCase());
  })
  || take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, (m) => {
    result.time = to24h(m[1], `:${m[2]}`, '');
  });

  // What kind of thing is this?
  //
  // A time range means it occupies a stretch of the day, which is what an event
  // is. Combined with the weekly recurrence the parser already understands,
  // "every thursday 8-9am" is a standing commitment; the same words without a
  // time are still a task you tick off.
  if (result.kind === 'event') {
    if (result.recur === 'weekly' && result.deadline) {
      result.repeatsWeekly = true;
      result.dayOfWeek = new Date(`${result.deadline}T00:00:00Z`).getUTCDay();
    } else {
      // A one-off needs a date; with none given, it is today.
      result.repeatsWeekly = false;
      result.date = result.deadline || todayISO;
    }
  }

  // "for work" is only a filing instruction when it is the last thing said, so
  // this runs after the dates and times have been lifted out - otherwise "prep
  // the talk for work friday" is still trailing "friday" at the moment we look,
  // and the folder goes unread. Anchoring is what keeps "sign the form for
  // personal reasons" intact.
  if (!result.category) {
    take(/\s(?:for|into)\s+(work|personal|fitness)\s*$/i,
      (m) => { result.category = m[1].toLowerCase(); });
  }

  result.title = text.replace(/\s+/g, ' ').trim();

  // If parsing consumed the whole thing, the input was all metadata and no
  // task. Better to hand back the original than an empty title.
  if (!result.title) result.title = original.trim();

  return { ...result, matched };
}

/** "7", ":30", "pm" -> "19:30". Returns null for anything implausible. */
function to24h(hour, minutes, meridiem) {
  let h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  const m = minutes ? Number(String(minutes).replace(':', '')) : 0;
  if (!Number.isInteger(m) || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
