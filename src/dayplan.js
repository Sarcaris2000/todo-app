// Putting the list into the day.
//
// The app already knows two things separately: what is worth doing, and when
// you are free. This is the arithmetic that joins them - "you have 55 minutes
// before clinic, here is what fits" rather than a list and a calendar sitting
// next to each other leaving you to do the matching in your head.
//
// It is a proposal, not a commitment. Nothing here is saved, no reminder
// fires, and re-asking an hour later gives a different and equally disposable
// answer. That is deliberate: a plan that persists becomes a second list to
// maintain, and the failure mode of every time-blocking tool is that you end
// up serving the schedule instead of the work.

import { mergeIntervals } from './freetime.js';

// What a task with no estimate is assumed to take. Long enough to be worth
// scheduling, short enough that guessing wrong costs little.
export const DEFAULT_MINUTES = 30;

// Below this, a gap is not worth naming. Nobody starts a task in four minutes.
export const MIN_USEFUL_GAP = 10;

/**
 * Subtract a set of intervals from a set of windows.
 *
 * Used to carve pinned work out of the free time before anything else is
 * placed, so a task that already claims 3pm keeps it.
 */
export function carve(windows, taken) {
  const blocks = mergeIntervals(taken);
  let out = windows.map((w) => ({ ...w }));

  for (const block of blocks) {
    const next = [];
    for (const w of out) {
      if (block.end <= w.start || block.start >= w.end) { next.push(w); continue; }
      if (block.start > w.start) next.push({ start: w.start, end: block.start });
      if (block.end < w.end) next.push({ start: block.end, end: w.end });
    }
    out = next;
  }

  return out.filter((w) => w.end - w.start >= MIN_USEFUL_GAP);
}

const estimateOf = (task) => {
  const n = Number(task.estimate_minutes);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MINUTES;
};

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 24 * 60 ? mins : null;
};

/**
 * Lay today's tasks into today's gaps.
 *
 * Two passes, and the order matters:
 *
 * 1. Tasks that already carry a time of day are placed where they say. You
 *    chose that hour; a planner that quietly moves it is worse than no
 *    planner. They are laid down first and everything else works around them,
 *    even if that means a higher-ranked task gets bumped to later.
 *
 * 2. Everything else is placed in ranked order, first-fit, into whatever is
 *    left. First-fit rather than best-fit on purpose: filling the earliest gap
 *    keeps the day front-loaded, and an optimally packed day that leaves the
 *    important thing until five o'clock is not the goal.
 *
 * Anything that does not fit comes back as `unplaced`, because a planner that
 * silently drops half the list is telling you the day is fine when it is not.
 */
export function planDay({ windows, tasks, nowMinutes = 0 }) {
  // Nothing is scheduled into time that has already gone.
  const ahead = windows
    .map((w) => ({ start: Math.max(w.start, nowMinutes), end: w.end }))
    .filter((w) => w.end - w.start >= MIN_USEFUL_GAP);

  const pinned = [];
  const loose = [];
  for (const task of tasks) {
    const at = toMinutes(task.start_time);
    if (at === null) loose.push(task);
    else pinned.push({ task, at });
  }
  pinned.sort((a, b) => a.at - b.at);

  const blocks = [];
  const unplaced = [];

  // --- pass one: the hours you already chose --------------------------------
  for (const { task, at } of pinned) {
    const end = Math.min(at + estimateOf(task), 24 * 60 - 1);
    if (end <= nowMinutes) { unplaced.push({ task, reason: 'already past' }); continue; }

    const start = Math.max(at, nowMinutes);
    // A pinned task is placed where it says even if that hour is already
    // spoken for - moving it would be worse - but the collision is reported
    // rather than drawn as though the day were fine.
    const fits = ahead.some((w) => start >= w.start && end <= w.end);
    blocks.push({ start, end, task, pinned: true, conflict: !fits });
  }

  // --- pass two: fill what is left, in the order worth doing ----------------
  let free = carve(ahead, blocks.map((b) => ({ start: b.start, end: b.end })));

  for (const task of loose) {
    const need = estimateOf(task);
    const slot = free.find((w) => w.end - w.start >= need);
    if (!slot) { unplaced.push({ task, reason: 'no gap long enough' }); continue; }

    blocks.push({ start: slot.start, end: slot.start + need, task, pinned: false });
    slot.start += need;
    free = free.filter((w) => w.end - w.start >= MIN_USEFUL_GAP);
  }

  blocks.sort((a, b) => a.start - b.start || a.end - b.end);

  const scheduled = blocks.reduce((n, b) => n + (b.end - b.start), 0);
  const available = ahead.reduce((n, w) => n + (w.end - w.start), 0);

  // Measured from what is actually left rather than by subtracting scheduled
  // minutes: a pinned task sitting outside the free windows consumes none of
  // them, and subtracting it would quietly understate the headroom.
  const spare = free.reduce((n, w) => n + (w.end - w.start), 0);

  return {
    blocks,
    unplaced,
    scheduled,
    available,
    spare,
    conflicts: blocks.filter((b) => b.conflict).length,
  };
}
