// The public demo's sample data.
//
// Regenerated from scratch every night, and every date is computed relative to
// the day it runs. A demo with hard-coded dates is a demo that looks abandoned
// within a week - every task overdue, the schedule ending last month.
//
// The person in here is invented. The service names are generic on purpose:
// a public demo has no business carrying a real department's service names.

const DAY_MS = 86_400_000;

const shift = (todayISO, days) =>
  new Date(Date.parse(`${todayISO}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Monday of the week containing todayISO, so the schedule lines up sensibly. */
function weekStart(todayISO) {
  const date = new Date(`${todayISO}T00:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return shift(todayISO, -back);
}

function demoTasks(todayISO) {
  const t = (days) => shift(todayISO, days);
  return [
    {
      id: 'demo-1', title: 'Review fellow research proposals', category: 'work',
      deadline: t(-2), priority: 1, estimate_minutes: 90,
      notes: 'Three proposals. Feedback due back to the program director.',
      subtasks: [
        { text: 'Proposal 1 - airway remodelling', done: true },
        { text: 'Proposal 2 - sleep apnoea cohort', done: false },
        { text: 'Proposal 3 - ILD registry', done: false },
      ],
    },
    {
      id: 'demo-2', title: 'Sign outstanding PFT reports', category: 'work',
      deadline: t(0), priority: 1, estimate_minutes: 45,
      notes: 'Sample data. Nothing here is a real patient.',
    },
    {
      // Carries a time: a task can be pinned to an hour without becoming an
      // appointment. Nothing alerts at 3pm and no capacity is deducted.
      id: 'demo-11', title: 'Call the lab about the spirometry order', category: 'work',
      deadline: t(0), start_time: '15:00', priority: 2, estimate_minutes: 10,
    },
    {
      id: 'demo-3', title: 'Peloton - 30 min endurance ride', category: 'fitness',
      deadline: t(0), priority: 2, estimate_minutes: 30,
    },
    {
      id: 'demo-4', title: 'Renew board certification paperwork', category: 'work',
      deadline: t(4), priority: 1, estimate_minutes: 60,
      subtasks: [
        { text: 'Gather CME certificates', done: true },
        { text: 'Complete the application', done: false },
        { text: 'Pay the fee', done: false },
      ],
    },
    {
      id: 'demo-5', title: 'Book flights for the conference', category: 'personal',
      deadline: t(6), priority: 2, estimate_minutes: 20,
    },
    {
      id: 'demo-6', title: 'Prep Grand Rounds talk - Interstitial Lung Disease',
      category: 'work', deadline: t(12), priority: 1, estimate_minutes: 180,
      notes: 'Fifty minutes plus questions.',
      subtasks: [
        { text: 'Outline', done: true },
        { text: 'Build slides', done: false },
        { text: 'Run through once out loud', done: false },
      ],
    },
    {
      id: 'demo-7', title: 'Replace the smoke alarm batteries', category: 'personal',
      deadline: null, priority: 3, estimate_minutes: 15,
    },
    {
      id: 'demo-8', title: 'Long-term: build the PFT teaching module',
      category: 'work', deadline: null, priority: 2, estimate_minutes: null,
      notes: 'No deadline, but it still ranks - undated does not mean invisible.',
    },
    {
      // Demonstrates hide_until_due: invisible until the day it is due.
      id: 'demo-9', title: 'Weekly review - plan the coming week',
      category: 'work', deadline: shift(weekStart(todayISO), 6),
      priority: 2, estimate_minutes: 30, recur: 'weekly', hide_until_due: 1,
    },
    {
      id: 'demo-10', title: 'Call Mum', category: 'personal',
      deadline: t(1), priority: 2, estimate_minutes: 20, recur: 'weekly',
    },
    {
      id: 'demo-done-1', title: 'Dictate Monday clinic notes', category: 'work',
      deadline: t(-1), priority: 1, estimate_minutes: 40, status: 'done',
    },
    {
      id: 'demo-done-2', title: 'Peloton - 20 min upper body strength',
      category: 'fitness', deadline: t(-1), priority: 2, estimate_minutes: 20, status: 'done',
    },
  ];
}

const DEMO_EVENTS = [
  { id: 'demo-ev-1', title: 'Division conference', day_of_week: 1, start_time: '07:30', end_time: '08:30', tentative: 0 },
  { id: 'demo-ev-2', title: 'Fellow teaching', day_of_week: 3, start_time: '12:00', end_time: '13:00', tentative: 0 },
  { id: 'demo-ev-3', title: 'Grand Rounds', day_of_week: 4, start_time: '08:00', end_time: '09:00', tentative: 1 },
  { id: 'demo-ev-4', title: 'Research meeting', day_of_week: 2, start_time: '16:00', end_time: '17:00', tentative: 0 },
];

/**
 * One-off dates, relative to whenever the demo is seeded.
 *
 * The four above are the standing week. Without these the demo showed only
 * weekly commitments, so the calendar looked like something that could hold a
 * rota and nothing else - a visitor had no way to see that a dinner on a
 * particular Thursday has somewhere to live.
 */
const DEMO_ONE_OFFS = [
  { id: 'demo-ev-5', in_days: 2, title: 'Dinner with the Harrisons', start_time: '19:00', end_time: '21:30' },
  { id: 'demo-ev-6', in_days: 9, title: 'Dentist', start_time: '08:15', end_time: '09:00' },
];

// `blocks` is JSON, and it is what makes a split day read as "6h committed,
// longest clear window 12pm-5pm" rather than one shapeless eleven-hour bar.
// Inpatient assignments share a concurrency group: covering two at once is one
// day of work, not two.
const DEMO_SERVICE_HOURS = [
  { pattern: 'ICU SERVICE', minutes: 660, blocks: '[["07:00","18:00"]]', concurrency_group: 'inpatient' },
  { pattern: 'CONSULTS', minutes: 660, blocks: '[["07:00","18:00"]]', concurrency_group: 'inpatient' },
  { pattern: 'PULMONARY CLINIC PM', minutes: 330, blocks: '[["12:00","17:30"]]', concurrency_group: null },
  { pattern: 'PFT READING', minutes: 360, blocks: '[["08:00","12:00"],["17:00","19:00"]]', concurrency_group: null },
  { pattern: 'BACK-UP', minutes: 0, blocks: null, concurrency_group: null },
];

/**
 * Two weeks of a plausible call schedule, so the free-time maths has something
 * real to chew on: an inpatient week, then a mixed week of clinic and reading.
 *
 * Monday..Sunday. Null is a day off.
 */
const CALL_SCHEDULE = [
  // This week: on service, plus reading stacked on top of two days.
  [['ICU SERVICE'], ['ICU SERVICE', 'PFT READING'], ['ICU SERVICE'],
    ['ICU SERVICE', 'PFT READING'], ['ICU SERVICE'], ['BACK-UP'], null],
  // Next week: clinic and reading, which is a very different shaped day.
  [['PFT READING'], ['PULMONARY CLINIC PM'], ['PFT READING', 'PULMONARY CLINIC PM'],
    ['CONSULTS'], ['CONSULTS'], null, null],
];

function demoSchedule(todayISO) {
  const monday = weekStart(todayISO);
  const rows = [];

  for (let week = 0; week < CALL_SCHEDULE.length; week++) {
    for (let day = 0; day < 7; day++) {
      const titles = CALL_SCHEDULE[week][day];
      if (!titles) continue;
      const date = shift(monday, week * 7 + day);
      for (const title of titles) {
        // The feed's nominal window is deliberately wider than the mapping,
        // exactly as the real one is - the mapping is what should win.
        rows.push({ date, title, start_time: '06:00', end_time: '19:00' });
      }
    }
  }
  return rows;
}

const DEMO_WORKOUTS = [
  { day_of_week: 1, title: '30 min endurance ride', modality: 'bike', duration_minutes: 30 },
  { day_of_week: 2, title: '20 min upper body strength', modality: 'strength', duration_minutes: 20 },
  { day_of_week: 3, title: '30 min intervals ride', modality: 'bike', duration_minutes: 30 },
  { day_of_week: 4, title: '20 min yoga flow', modality: 'yoga', duration_minutes: 20 },
  { day_of_week: 5, title: '30 min full body strength', modality: 'strength', duration_minutes: 30 },
  { day_of_week: 6, title: '45 min long ride', modality: 'bike', duration_minutes: 45 },
  { day_of_week: 0, title: 'Rest day', modality: 'rest', duration_minutes: 0 },
];

/**
 * Wipe and rebuild the demo. Idempotent, and safe to run at any hour.
 *
 * Push subscriptions and sessions go too: a demo notification should not keep
 * arriving on a stranger's phone for weeks after they looked at it once.
 */
export async function seedDemo(env, todayISO) {
  const now = new Date().toISOString();

  for (const table of ['tasks', 'events', 'workout_plan', 'workout_log',
    'schedule_days', 'service_hours', 'subscriptions', 'sessions', 'auth_attempts', 'meta']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => {});
  }

  for (const t of demoTasks(todayISO)) {
    await env.DB.prepare(
      `INSERT INTO tasks (id, title, notes, category, deadline, start_time, priority, estimate_minutes,
                          status, recur, subtasks, hide_until_due, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      t.id, t.title, t.notes ?? '', t.category, t.deadline, t.start_time ?? null, t.priority,
      t.estimate_minutes ?? null, t.status ?? 'open', t.recur ?? null,
      JSON.stringify(t.subtasks ?? []), t.hide_until_due ?? 0,
      now, now, t.status === 'done' ? now : null,
    ).run();
  }

  for (const e of DEMO_EVENTS) {
    await env.DB.prepare(
      `INSERT INTO events (id, day_of_week, title, start_time, end_time, notes, tentative, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    ).bind(e.id, e.day_of_week, e.title, e.start_time, e.end_time, e.tentative, now).run();
  }

  for (const e of DEMO_ONE_OFFS) {
    const date = shift(todayISO, e.in_days);
    // day_of_week is NOT NULL and is always derived from the date, exactly as
    // cleanEvent does it - the seed must not be the one place they disagree.
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    await env.DB.prepare(
      `INSERT INTO events (id, date, day_of_week, title, start_time, end_time, notes, tentative, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', 0, ?)`,
    ).bind(e.id, date, dow, e.title, e.start_time, e.end_time, now).run();
  }

  for (const sh of DEMO_SERVICE_HOURS) {
    await env.DB.prepare(
      `INSERT INTO service_hours (pattern, minutes, notes, concurrency_group, blocks)
       VALUES (?, ?, '', ?, ?)`,
    ).bind(sh.pattern, sh.minutes, sh.concurrency_group, sh.blocks).run();
  }

  for (const d of demoSchedule(todayISO)) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO schedule_days (date, title, start_time, end_time, all_day, synced_at, source)
       VALUES (?, ?, ?, ?, 0, ?, 'demo')`,
    ).bind(d.date, d.title, d.start_time, d.end_time, now).run();
  }

  for (const w of DEMO_WORKOUTS) {
    await env.DB.prepare(
      `INSERT INTO workout_plan (day_of_week, title, modality, duration_minutes, instructor, notes)
       VALUES (?, ?, ?, ?, '', '')`,
    ).bind(w.day_of_week, w.title, w.modality, w.duration_minutes).run();
  }

  // A short streak, so the workout card has something to show. Sunday is a
  // rest day and is logged as skipped, which must not break the streak.
  for (let i = 1; i <= 5; i++) {
    const date = shift(todayISO, -i);
    const rest = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    await env.DB.prepare(
      'INSERT OR REPLACE INTO workout_log (date, status, title, logged_at) VALUES (?, ?, ?, ?)',
    ).bind(date, rest ? 'skipped' : 'done', rest ? 'Rest day' : 'Completed', now).run();
  }

  for (const [key, value] of Object.entries({
    timezone: 'America/Chicago',
    notify_hour: '6',
    daily_capacity: '240',
    archive_after_days: '90',
    evening_days: '0',
    evening_hour: '20',
    // The demo shows the folders renamed, because a demo of a feature should
    // demonstrate the feature. Reset restores these along with everything else.
    folder_labels: JSON.stringify({ work: 'Clinical', personal: 'Home', fitness: 'Training' }),
    demo_seeded_at: now,
  })) {
    await env.DB.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .bind(key, String(value)).run();
  }

  return { seeded: true, at: now };
}
