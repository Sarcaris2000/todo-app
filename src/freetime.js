// Where the gaps actually are.
//
// A total is not enough. Six hours committed can mean one solid block with an
// afternoon free, or two sessions with the middle of the day cut out - and
// "you have 3h free" means something quite different in each case.

/** "08:30" -> 510 minutes past midnight. */
export function toMinutes(hhmm) {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 510 -> "8:30am". */
export function toClock(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export function parseBlocks(value) {
  if (!value) return null;
  let raw = value;
  if (typeof value === 'string') {
    try { raw = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(raw) || !raw.length) return null;

  const out = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const start = toMinutes(pair[0]);
    const end = toMinutes(pair[1]);
    if (start === null || end === null || end <= start) continue;
    out.push({ start, end });
  }
  return out.length ? out : null;
}

/** Overlapping or touching intervals merged into the fewest possible. */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].filter(Boolean).sort((a, b) => a.start - b.start);
  const merged = [];

  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    // Touching counts as overlapping: back-to-back blocks are one stretch of
    // busy, not two with a zero-length gap between them.
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

/**
 * Free stretches inside the working day.
 *
 * Anything outside the day bounds is ignored rather than counted as free -
 * 3am is technically unoccupied and useless.
 */
export function freeWindows(busy, dayStart = 7 * 60, dayEnd = 19 * 60) {
  const merged = mergeIntervals(busy)
    .map((b) => ({ start: Math.max(b.start, dayStart), end: Math.min(b.end, dayEnd) }))
    .filter((b) => b.end > b.start);

  const free = [];
  let cursor = dayStart;

  for (const block of merged) {
    if (block.start > cursor) free.push({ start: cursor, end: block.start });
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < dayEnd) free.push({ start: cursor, end: dayEnd });

  return free;
}

/** The longest single free stretch, or null if the day is full. */
export function longestFreeWindow(busy, dayStart, dayEnd) {
  const windows = freeWindows(busy, dayStart, dayEnd);
  if (!windows.length) return null;
  return windows.reduce((best, w) => ((w.end - w.start) > (best.end - best.start) ? w : best));
}
