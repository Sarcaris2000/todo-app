import { sendPush } from './push.js';
import { rankTasks, buildDigest, deadlineLabel, DEFAULT_FOLDER_LABELS } from './rank.js';
import {
  getPlan, savePlanEntry, todayWorkout, logWorkout, getPlanForDay,
  workoutDigestLine, localDayOfWeek, DAY_NAMES, backToBackImpactDays,
} from './workouts.js';
import {
  cleanRecur, nextOccurrence, isSnoozed, snoozeDate, snoozeLabel, deferredUntil,
  RECUR_OPTIONS,
} from './recurrence.js';
import {
  listEvents, eventsForDay, createEvent, updateEvent, deleteEvent,
  eventMinutes, eventLabel, eventsDigestLine,
} from './events.js';
import {
  syncSchedule, scheduleForDate, scheduleFrom, getMappings, saveMapping,
  deleteMapping, entryMinutes, scheduleDigestLine, REFRESH_HOURS,
  clinicalMinutesForDay, busyIntervals, nextFreeDays,
} from './schedule.js';
import { longestFreeWindow, toClock } from './freetime.js';
import { parseQuickAdd } from '../public/parse.js';
import { backupToDrive, isConfigured as driveConfigured } from './gdrive.js';
import { inspectExport, restoreExport } from './restore.js';
import {
  encryptBackup, decryptBackup, isEncryptedBackup, toBase64, fromBase64,
} from './backup-crypto.js';
import { seedDemo } from './demo.js';
import {
  checkLockout, recordFailure, clearFailures, clientIp,
  createSession, resolveSession, listSessions, deleteSession,
  deleteOtherSessions, pruneExpired,
} from './auth.js';

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** Length-independent-ish comparison so the passphrase check isn't a timing oracle. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Every endpoint except /api/auth requires a session token. The passphrase is
 * no longer accepted here - it is only good for minting a session, so it stops
 * being transmitted on every request.
 */
async function authorize(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  const session = await resolveSession(env, token);
  if (!session) {
    return { ok: false, response: json({ error: 'Unauthorized' }, 401) };
  }
  return { ok: true, session };
}

/** Wall-clock date and hour in a given IANA timezone. */
function localNow(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24; // guard against a '24' from midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, String(value)).run();
}

async function settings(env) {
  const timezone = await getSetting(env, 'timezone', env.DEFAULT_TIMEZONE || 'America/Chicago');
  const notifyHour = Number(await getSetting(env, 'notify_hour', env.DEFAULT_NOTIFY_HOUR || '6'));
  // 0 means "just show me the total, do not warn".
  const dailyCapacity = Number(await getSetting(env, 'daily_capacity', '0'));
  // 0 means "keep everything forever".
  const archiveAfterDays = Number(await getSetting(env, 'archive_after_days', '90'));
  // Comma-separated weekday numbers, 0 = Sunday. Empty means never.
  const eveningDays = String(await getSetting(env, 'evening_days', '0'));
  const eveningHour = Number(await getSetting(env, 'evening_hour', '20'));
  return { timezone, notifyHour, dailyCapacity, archiveAfterDays, eveningDays, eveningHour };
}

const nowISO = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/** Accept only YYYY-MM-DD, or null. */
function cleanDeadline(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : s;
}

export const CATEGORIES = ['personal', 'work', 'fitness'];

/** Folder names are display-only; the ids above never change. */
export const MAX_FOLDER_LABEL = 14;

export function cleanFolderLabel(value, fallback) {
  const label = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_FOLDER_LABEL);
  return label || fallback;
}

/**
 * The three folder names for this install.
 *
 * Stored as one JSON blob rather than three keys so a partial write cannot
 * leave two folders renamed and one not. Anything missing or corrupt falls
 * back to the default, so a bad value can never produce a nameless tab.
 */
async function folderLabels(env) {
  const raw = await getSetting(env, 'folder_labels', null);
  let stored = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = {};
  }

  const labels = {};
  for (const id of CATEGORIES) {
    labels[id] = cleanFolderLabel(stored[id], DEFAULT_FOLDER_LABELS[id]);
  }
  return labels;
}

function cleanCategory(value) {
  const category = String(value ?? '').toLowerCase().trim();
  return CATEGORIES.includes(category) ? category : 'personal';
}

/** Subtasks arrive as JSON or as an array; normalise either into a clean array. */
function cleanSubtasks(value) {
  let list = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 50)
    .map((s) => ({ text: String(s?.text ?? '').trim().slice(0, 200), done: Boolean(s?.done) }))
    .filter((s) => s.text);
}

/**
 * How much is actually on the plate today: open, unsnoozed, and either due
 * today or already overdue. Sunsama's insight is that a list without a total
 * lets you commit to fourteen hours of work in an eight hour day without ever
 * noticing.
 */
function workloadFor(tasks, todayISO) {
  const due = tasks.filter((t) => t.status !== 'done'
    && !isSnoozed(t, todayISO)
    && t.deadline && t.deadline <= todayISO);

  return {
    count: due.length,
    minutes: due.reduce((n, t) => n + (Number(t.estimate_minutes) || 0), 0),
    // Counted separately: an unestimated task makes the total an understatement,
    // and silently treating it as zero would be a lie.
    unestimated: due.filter((t) => !t.estimate_minutes).length,
  };
}

function cleanTask(input) {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('Title is required');

  const priority = [1, 2, 3].includes(Number(input.priority)) ? Number(input.priority) : 2;
  const estimateRaw = Number(input.estimate_minutes);
  const estimate = Number.isFinite(estimateRaw) && estimateRaw > 0
    ? Math.min(Math.round(estimateRaw), 60 * 24 * 30)
    : null;

  return {
    title: title.slice(0, 200),
    notes: String(input.notes ?? '').slice(0, 4000),
    category: cleanCategory(input.category),
    deadline: cleanDeadline(input.deadline),
    priority,
    estimate_minutes: estimate,
    recur: cleanRecur(input.recur),
    subtasks: JSON.stringify(cleanSubtasks(input.subtasks)),
    hide_until_due: input.hide_until_due ? 1 : 0,
  };
}

/**
 * When a repeating task is completed, schedule the next one.
 *
 * Deliberately triggered by completion rather than by the clock: miss a week
 * and you get one task to catch up on, not seven stacked copies.
 */
async function scheduleNextOccurrence(env, task, todayISO) {
  const rule = cleanRecur(task.recur);
  if (!rule) return null;

  const nextDeadline = nextOccurrence(rule, task.deadline, todayISO);
  if (!nextDeadline) return null;

  const id = newId();
  const timestamp = nowISO();
  await env.DB.prepare(
    `INSERT INTO tasks
       (id, title, notes, category, deadline, priority, estimate_minutes, status, recur,
        hide_until_due, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).bind(
    id, task.title, task.notes, task.category, nextDeadline,
    task.priority, task.estimate_minutes, rule,
    Number(task.hide_until_due) ? 1 : 0, timestamp, timestamp,
  ).run();

  return { id, deadline: nextDeadline };
}

/**
 * The backup payload.
 *
 * Shared by the download button and the Drive upload so the two can never
 * drift - a backup that differs from what you can inspect is worse than none.
 *
 * Deliberately excludes push subscriptions and sessions: those are device
 * credentials, trivially recreated by signing in again, and a file sitting in
 * cloud storage is a bad place for either.
 */
async function buildExport(env, timezone) {
  const tables = ['tasks', 'events', 'workout_plan', 'workout_log',
    'schedule_days', 'service_hours', 'meta'];

  const data = {};
  for (const table of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    data[table] = results ?? [];
  }

  return {
    exported_at: nowISO(),
    app: 'todo',
    schema_version: 10,
    timezone,
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    data,
  };
}

async function runBackup(env, todayISO, timezone, prefix = 'todo-backup') {
  const payload = await buildExport(env, timezone);

  // Sealed before it leaves, when a passphrase is configured. What reaches
  // Google is then a blob that Google cannot read - which is the whole point:
  // storage-provider encryption protects against a stolen disk, not against
  // someone who is inside your account.
  let body = JSON.stringify(payload, null, 2);
  let filename = `${prefix}-${todayISO}.json`;
  if (env.BACKUP_PASSPHRASE) {
    body = toBase64(await encryptBackup(env.BACKUP_PASSPHRASE, body));
    filename += '.enc';
  }

  // Snapshots taken before a restore are a safety net for that afternoon, not
  // an archive, so only a few are worth keeping.
  const result = await backupToDrive(
    env,
    filename,
    body,
    { keep: prefix === 'pre-restore' ? 3 : 12, prefix },
  );

  await setSetting(env, 'backup_last_result', result.ok
    ? `Backed up ${result.file} (${Math.round(result.bytes / 1024)} KB${
      env.BACKUP_PASSPHRASE ? ', encrypted' : ''})`
    : result.reason);

  // A run counter, so an alert can say how long this has been broken. One
  // failed Sunday is probably Google having a bad morning; four in a row is a
  // revoked token and needs you to do something.
  const streak = Number(await getSetting(env, 'backup_fail_streak', '0')) || 0;
  await setSetting(env, 'backup_fail_streak', result.ok ? 0 : streak + 1);
  if (result.ok) await setSetting(env, 'backup_last_at', result.at);

  return { ...result, failures: result.ok ? 0 : streak + 1 };
}

/**
 * Tell the devices a backup did not happen.
 *
 * Only the scheduled run does this. A manual backup reports into the settings
 * panel you are already looking at, and pushing a notification about a button
 * you just pressed is noise.
 */
async function alertBackupFailure(env, result) {
  const weeks = result.failures > 1 ? ` ${result.failures} weeks running.` : '';
  const stale = await getSetting(env, 'backup_last_at', null);
  const since = stale ? ` Last good backup ${stale.slice(0, 10)}.` : '';

  await pushToAllDevices(env, {
    title: 'Backup to Drive failed',
    body: `${result.reason}.${weeks}${since}`,
    tag: 'backup-failure',
    url: '/',
  });
}

// --------------------------------------------------------------------------
// archiving
// --------------------------------------------------------------------------

/**
 * Completed tasks are worth keeping for a while and then they are just weight.
 * The generated workout rows are the worst of it - one a day, forever, and
 * the workout log already records what was actually done.
 *
 * A lifetime counter is kept so the history is summarised rather than simply
 * lost: deleting the rows should not delete the fact that you did the work.
 */
async function archivableBefore(env, todayISO, days) {
  if (!days || days <= 0) return null;
  const cutoffMs = Date.parse(`${todayISO}T00:00:00Z`) - days * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString();
}

async function previewArchive(env, todayISO, days) {
  const cutoff = await archivableBefore(env, todayISO, days);
  if (!cutoff) return { eligible: 0, workouts: 0, cutoff: null };

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN id LIKE 'workout-%' THEN 1 ELSE 0 END) AS w
       FROM tasks
      WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at < ?`,
  ).bind(cutoff).first();

  return { eligible: row?.n ?? 0, workouts: row?.w ?? 0, cutoff: cutoff.slice(0, 10) };
}

async function runArchive(env, todayISO, days) {
  const cutoff = await archivableBefore(env, todayISO, days);
  if (!cutoff) return { removed: 0, cutoff: null };

  const { eligible } = await previewArchive(env, todayISO, days);
  if (!eligible) return { removed: 0, cutoff: cutoff.slice(0, 10) };

  await env.DB.prepare(
    "DELETE FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at < ?",
  ).bind(cutoff).run();

  const previous = Number(await getSetting(env, 'archived_count', '0')) || 0;
  await setSetting(env, 'archived_count', previous + eligible);

  return { removed: eligible, cutoff: cutoff.slice(0, 10) };
}

/** Everything ever finished, whether or not the rows still exist. */
async function lifetimeCompleted(env) {
  const archived = Number(await getSetting(env, 'archived_count', '0')) || 0;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'",
  ).first();
  return archived + (row?.n ?? 0);
}

// --------------------------------------------------------------------------
// the daily digest
// --------------------------------------------------------------------------

/** Deliver one payload to every registered device, pruning dead endpoints. */
async function pushToAllDevices(env, payload) {
  const { results: subs } = await env.DB.prepare('SELECT * FROM subscriptions').all();

  if (!subs || subs.length === 0) {
    return { sent: 0, failed: 0, removed: 0, note: 'No devices are subscribed yet' };
  }

  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const sub of subs) {
    let result;
    try {
      result = await sendPush(sub, payload, env);
    } catch (error) {
      result = { ok: false, status: 0, gone: false, detail: String(error).slice(0, 300) };
    }

    if (result.ok) {
      sent++;
      await env.DB.prepare('UPDATE subscriptions SET last_success = ?, last_error = NULL WHERE id = ?')
        .bind(nowISO(), sub.id).run();
    } else if (result.gone) {
      // The push service says this endpoint is permanently dead - stop retrying it.
      removed++;
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(sub.id).run();
    } else {
      failed++;
      await env.DB.prepare('UPDATE subscriptions SET last_error = ? WHERE id = ?')
        .bind(`${result.status}: ${result.detail}`, sub.id).run();
    }
  }

  return { sent, failed, removed };
}

/**
 * The workout appears both as a card and as a real task, so the two must agree.
 * The task id is derived from the date, which makes creating it idempotent -
 * the cron can run twice without producing duplicates.
 */
async function syncWorkoutTask(env, todayISO, status) {
  const id = `workout-${todayISO}`;
  const existing = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(id).first();
  if (!existing) return;

  const taskStatus = status === 'done' ? 'done' : 'open';
  await env.DB.prepare(
    'UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
  ).bind(taskStatus, taskStatus === 'done' ? nowISO() : null, nowISO(), id).run();
}

/**
 * Today's plan entry, or null if the workout feature is unavailable.
 *
 * The workout is an addition to the digest, so it must never be able to
 * prevent one. An un-migrated database or a broken plan should cost you the
 * workout line, not the whole morning notification.
 */
async function safePlanForToday(env, timezone) {
  try {
    return await getPlanForDay(env, localDayOfWeek(timezone));
  } catch (error) {
    console.error('Workout plan unavailable; sending digest without it', error);
    return null;
  }
}

/** Today's clinical assignments, or an empty list if unavailable. */
async function safeScheduleForToday(env, todayISO) {
  try {
    return await scheduleForDate(env, todayISO);
  } catch (error) {
    console.error('Clinical schedule unavailable', error);
    return [];
  }
}

/** Today's commitments, or an empty list if the feature is unavailable. */
async function safeEventsForToday(env, timezone) {
  try {
    return await eventsForDay(env, localDayOfWeek(timezone));
  } catch (error) {
    console.error('Weekly events unavailable', error);
    return [];
  }
}

/** Create today's workout task in the Fitness folder, unless it already exists. */
async function ensureWorkoutTask(env, todayISO, timezone) {
  const entry = await safePlanForToday(env, timezone);
  // A rest day is not a chore; do not manufacture a task for it.
  if (!entry || entry.modality === 'rest') return null;

  const id = `workout-${todayISO}`;
  const timestamp = nowISO();
  const detail = [entry.instructor, entry.notes].filter(Boolean).join(' — ');

  await env.DB.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, title, notes, category, deadline, priority, estimate_minutes, status, created_at, updated_at)
     VALUES (?, ?, ?, 'fitness', ?, 2, ?, 'open', ?, ?)`,
  ).bind(
    id, entry.title, detail, todayISO,
    entry.duration_minutes ?? null, timestamp, timestamp,
  ).run();

  return id;
}

async function sendDigestToAllDevices(env, todayISO, timezone) {
  const { results: tasks } = await env.DB
    .prepare("SELECT * FROM tasks WHERE status = 'open'").all();

  // The workout gets its own line, so keep its mirrored task out of the
  // numbered list - otherwise the same session is announced twice, and it
  // crowds out a real task that needed the slot.
  const eligible = (tasks ?? [])
    .filter((t) => !/^workout-\d{4}-\d{2}-\d{2}$/.test(t.id))
    .filter((t) => !isSnoozed(t, todayISO));
  const digest = buildDigest(eligible, todayISO, await folderLabels(env));

  const entry = timezone ? await safePlanForToday(env, timezone) : null;
  let body = digest.body;

  // Commitments first: they frame everything below them. Knowing you are on
  // service until six changes how three open tasks should feel.
  const todayEvents = timezone ? await safeEventsForToday(env, timezone) : [];
  const clinical = await safeScheduleForToday(env, todayISO);
  const mappings = await getMappings(env).catch(() => []);

  const lines = [
    scheduleDigestLine(clinical, mappings),
    eventsDigestLine(todayEvents),
  ].filter(Boolean);
  if (lines.length) body += `\n\nToday: ${lines.join(' · ')}`;

  if (entry) body += `\n\nWorkout: ${workoutDigestLine(entry)}`;

  // A total the night's planning cannot argue with.
  const load = workloadFor(eligible, todayISO);
  const loadMinutes = load.minutes + (entry?.duration_minutes || 0);
  const committed = todayEvents.reduce((n, e) => n + eventMinutes(e), 0)
    + clinicalMinutesForDay(clinical, mappings);

  if (loadMinutes > 0 || committed > 0) {
    const capacity = (await settings(env)).dailyCapacity;
    const pretty = (n) => {
      const h = Math.floor(n / 60); const m = n % 60;
      return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
    };

    let line = `\n${pretty(loadMinutes)} of tasks`;
    if (load.unestimated) line += ` (+${load.unestimated} unestimated)`;
    if (committed > 0) line += `, ${pretty(committed)} committed`;

    // Capacity is time available for *work*, so commitments come out of it
    // before the comparison. Otherwise a full clinic day looks the same as an
    // empty one.
    if (capacity > 0) {
      const free = capacity - committed;
      if (free <= 0) {
        line += `. No free time today.`;
      } else if (loadMinutes > free) {
        line += `. Only ${pretty(free)} free — ${pretty(loadMinutes - free)} more than fits.`;
      } else {
        line += `. ${pretty(free)} free.`;
      }
    }

    const window = longestFreeWindow(busyIntervals(clinical, todayEvents, mappings));
    if (window && window.end - window.start >= 30) {
      line += ` Longest clear stretch ${toClock(window.start)}-${toClock(window.end)}.`;
    }
    body += line;
  }

  const result = await pushToAllDevices(env, {
    title: digest.title,
    body,
    tag: `digest-${todayISO}`,
    url: '/',
  });

  // Report the body that was actually sent, not the pre-workout draft, so the
  // in-app preview and the notification can never disagree.
  return { ...result, digest: { ...digest, body } };
}

/**
 * The Sunday review: what a daily digest structurally cannot show you.
 *
 * "Today's focus" is always about today, so slow drift is invisible - a task
 * quietly rotting for six weeks never announces itself. This counts what got
 * finished, what is still slipping, and names the oldest thing still open.
 */
async function sendWeeklyReview(env, todayISO) {
  const DAY = 24 * 60 * 60 * 1000;
  const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
  const weekAgo = new Date(todayMs - 7 * DAY).toISOString().slice(0, 10);
  const weekAhead = new Date(todayMs + 7 * DAY).toISOString().slice(0, 10);

  const { results: rows } = await env.DB.prepare(
    `SELECT status, completed_at, deadline, title, created_at, snoozed_until, priority, id
       FROM tasks`,
  ).all();
  const all = rows ?? [];

  const finished = all.filter((t) => t.status === 'done'
    && String(t.completed_at || '').slice(0, 10) >= weekAgo);

  // Workout tasks are excluded throughout: they are reported as a streak, and
  // one auto-created row a day would drown everything else in these lists.
  const open = all.filter((t) => t.status !== 'done'
    && !isSnoozed(t, todayISO)
    && !/^workout-/.test(t.id));

  const overdue = open.filter((t) => t.deadline && t.deadline < todayISO);

  // What is about to land: high priority, due inside the coming week. This is
  // the half of the review that looks forward rather than back.
  const upcoming = open
    .filter((t) => Number(t.priority) === 1
      && t.deadline
      && t.deadline >= todayISO
      && t.deadline <= weekAhead)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)))
    .slice(0, 4);

  // Things that have quietly aged. Anything already named above is skipped so
  // the same task is not listed twice.
  const named = new Set(upcoming.map((t) => t.id));
  const stale = open
    .filter((t) => !named.has(t.id))
    .map((t) => ({ ...t, age: Math.round((todayMs - Date.parse(t.created_at)) / DAY) }))
    .filter((t) => Number.isFinite(t.age) && t.age >= 14)
    .sort((a, b) => b.age - a.age)
    .slice(0, 3);

  const { results: workouts } = await env.DB.prepare(
    "SELECT date FROM workout_log WHERE status = 'done' AND date >= ?",
  ).bind(weekAgo).all();

  const dayName = (iso) => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (iso === todayISO) return 'today';
    if (Date.parse(`${iso}T00:00:00Z`) === todayMs + DAY) return 'tomorrow';
    return days[d];
  };

  const headline = [`${finished.length} done`, `${open.length} open`];
  if (overdue.length) headline.push(`${overdue.length} overdue`);
  if (workouts?.length) headline.push(`${workouts.length} workouts`);

  const lines = [`${headline.join(' · ')}.`];

  if (upcoming.length) {
    lines.push('', 'High priority this week:');
    upcoming.forEach((t) => lines.push(`• ${t.title} — ${dayName(t.deadline)}`));
  }

  if (stale.length) {
    lines.push('', 'Sitting too long:');
    stale.forEach((t) => lines.push(`• ${t.title} (${t.age}d)`));
  }

  if (!upcoming.length && !stale.length && !overdue.length) {
    lines.push('', 'Nothing overdue and nothing rotting. Good week.');
  }

  return pushToAllDevices(env, {
    title: 'Your week',
    body: lines.join('\n'),
    tag: `review-${todayISO}`,
    url: '/',
  });
}

/**
 * The evening nudge: what is still open, hours after the morning brief said
 * it was there.
 *
 * Deliberately built as "what remains" rather than "did you do the one thing":
 * if the task is finished there is nothing to report and nothing is sent, so
 * the condition takes care of itself and the same mechanism covers anything
 * else left hanging.
 */
async function sendEveningNudge(env, todayISO) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, deadline, snoozed_until, priority FROM tasks WHERE status = 'open'",
  ).all();

  const outstanding = (results ?? [])
    // The workout has its own card and streak; it does not belong in a
    // list of things still owed at the end of the day.
    .filter((t) => !/^workout-/.test(t.id))
    .filter((t) => !isSnoozed(t, todayISO))
    .filter((t) => t.deadline && t.deadline <= todayISO)
    .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))
      || Number(a.priority) - Number(b.priority));

  if (!outstanding.length) return { sent: 0, skipped: true, reason: 'Nothing outstanding' };

  const top = outstanding.slice(0, 4);
  const lines = top.map((t) => `• ${t.title}`);
  if (outstanding.length > top.length) lines.push(`+${outstanding.length - top.length} more`);

  const overdue = outstanding.filter((t) => t.deadline < todayISO).length;

  return pushToAllDevices(env, {
    title: overdue ? `Still open — ${overdue} overdue` : 'Still open tonight',
    body: lines.join('\n'),
    tag: `evening-${todayISO}`,
    url: '/',
  });
}

/** Tell every device that someone is guessing at the passphrase. */
async function sendSecurityAlert(env, ip, failures, retryAfter) {
  const minutes = Math.ceil(retryAfter / 60);
  return pushToAllDevices(env, {
    title: 'Failed sign-in attempts',
    body: `${failures} wrong passphrases from ${ip}. `
      + `That address is locked out for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    tag: 'security-alert',
    url: '/',
  });
}

// --------------------------------------------------------------------------
// API
// --------------------------------------------------------------------------

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // The only unauthenticated endpoint: trade the passphrase for a session
  // token. Rate limited per IP, because this is the one door facing the
  // internet and it was previously unlimited.
  if (path === '/api/auth' && method === 'POST') {
    if (!env.APP_PASSWORD) {
      return json({ error: 'Server is missing APP_PASSWORD' }, 500);
    }

    const ip = clientIp(request);
    const lockout = await checkLockout(env, ip);
    if (lockout.blocked) {
      const minutes = Math.ceil(lockout.retryAfter / 60);
      return new Response(JSON.stringify({
        ok: false,
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        retryAfter: lockout.retryAfter,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': String(lockout.retryAfter),
          'Cache-Control': 'no-store',
        },
      });
    }

    const body = await request.json().catch(() => ({}));

    if (!safeEqual(String(body.passphrase ?? ''), env.APP_PASSWORD)) {
      const failure = await recordFailure(env, ip);

      // Never on the demo: its passphrase is printed on its own lock screen,
      // so a failed attempt carries no signal at all - it would only let a
      // passer-by push "failed sign-in" notifications to whichever strangers
      // happened to have subscribed.
      if (failure.shouldAlert && env.DEMO_MODE !== 'true') {
        // Deliberately awaited: a slow rejection is not a problem here, and it
        // guarantees the warning is sent before the response goes back.
        await sendSecurityAlert(env, ip, failure.failures, failure.retryAfter).catch(() => {});
      }

      return json({
        ok: false,
        error: failure.retryAfter > 0
          ? `Incorrect passphrase. Locked out for ${Math.ceil(failure.retryAfter / 60)} minute(s).`
          : 'Incorrect passphrase',
      }, 401);
    }

    await clearFailures(env, ip);
    const token = await createSession(env, body.label ?? 'device');
    return json({ ok: true, token });
  }

  const auth = await authorize(request, env);
  if (!auth.ok) return auth.response;

  const { timezone, notifyHour } = await settings(env);
  const today = localNow(timezone).date;

  // --- config ---------------------------------------------------------------
  if (path === '/api/config' && method === 'GET') {
    return json({
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      timezone,
      notifyHour,
      dailyCapacity: (await settings(env)).dailyCapacity,
      eveningDays: (await settings(env)).eveningDays,
      eveningHour: (await settings(env)).eveningHour,
      today,
      demo: env.DEMO_MODE === 'true',
      folderLabels: await folderLabels(env),
    });
  }

  if (path === '/api/settings' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: String(body.timezone) });
      } catch {
        return json({ error: 'Unknown timezone' }, 400);
      }
      await setSetting(env, 'timezone', String(body.timezone));
    }
    if (body.folderLabels !== undefined) {
      const incoming = body.folderLabels;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return json({ error: 'folderLabels must be an object' }, 400);
      }

      // Merged over what is stored, so sending one folder does not blank the
      // other two. Empty or whitespace falls back to the default rather than
      // producing an unnamed tab.
      const current = await folderLabels(env);
      const next = {};
      for (const id of CATEGORIES) {
        next[id] = incoming[id] === undefined
          ? current[id]
          : cleanFolderLabel(incoming[id], DEFAULT_FOLDER_LABELS[id]);
      }
      await setSetting(env, 'folder_labels', JSON.stringify(next));
    }

    if (body.eveningDays !== undefined) {
      const days = String(body.eveningDays ?? '')
        .split(',').map((d) => d.trim()).filter((d) => /^[0-6]$/.test(d));
      await setSetting(env, 'evening_days', [...new Set(days)].sort().join(','));
    }
    if (body.eveningHour !== undefined) {
      const h = Number(body.eveningHour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return json({ error: 'eveningHour must be 0-23' }, 400);
      }
      await setSetting(env, 'evening_hour', h);
    }
    if (body.archiveAfterDays !== undefined) {
      const days = Number(body.archiveAfterDays);
      if (!Number.isFinite(days) || days < 0 || days > 3650) {
        return json({ error: 'archiveAfterDays must be 0-3650' }, 400);
      }
      await setSetting(env, 'archive_after_days', Math.round(days));
    }
    if (body.dailyCapacity !== undefined) {
      const minutes = Number(body.dailyCapacity);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) {
        return json({ error: 'dailyCapacity must be 0-1440 minutes' }, 400);
      }
      await setSetting(env, 'daily_capacity', Math.round(minutes));
    }
    if (body.notifyHour !== undefined) {
      const hour = Number(body.notifyHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return json({ error: 'notifyHour must be 0-23' }, 400);
      }
      await setSetting(env, 'notify_hour', hour);
    }
    return json({ ok: true, ...(await settings(env)), folderLabels: await folderLabels(env) });
  }

  // --- tasks ----------------------------------------------------------------
  if (path === '/api/tasks' && method === 'GET') {
    const { results } = await env.DB
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
    const all = results ?? [];

    // There is one list in the UI, so it arrives already ordered the way it
    // should be read: open tasks most-worth-doing first, then completed ones
    // most-recently-finished first. Ranking stays server-side, shared with the
    // digest, so the list and the 6am notification can never disagree.
    // Snoozed tasks are deliberately parked, so they neither rank nor nag.
    // They are still returned, flagged, so the All tab can show them.
    const live = all.filter((t) => t.status !== 'done' && !isSnoozed(t, today));
    const snoozed = all
      .filter((t) => t.status !== 'done' && isSnoozed(t, today))
      .map((t) => ({
        ...t,
        snoozed: true,
        snooze_label: snoozeLabel(deferredUntil(t), today),
      }))
      .sort((a, b) => String(deferredUntil(a)).localeCompare(String(deferredUntil(b))));

    const open = rankTasks(live, today);
    const done = all
      .filter((t) => t.status === 'done')
      .map((t) => ({ ...t, due_label: deadlineLabel(t.deadline, today) }))
      .sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')));

    return json({ tasks: [...open, ...snoozed, ...done], today });
  }

  if (path === '/api/tasks' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    let fields;
    try {
      fields = cleanTask(body);
    } catch (error) {
      return json({ error: String(error.message) }, 400);
    }

    const id = newId();
    const timestamp = nowISO();
    await env.DB.prepare(
      `INSERT INTO tasks (id, title, notes, category, deadline, priority, estimate_minutes, status, recur, subtasks, hide_until_due, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).bind(
      id, fields.title, fields.notes, fields.category, fields.deadline,
      fields.priority, fields.estimate_minutes, fields.recur, fields.subtasks,
      fields.hide_until_due, timestamp, timestamp,
    ).run();

    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    return json({ task }, 201);
  }

  const taskMatch = path.match(/^\/api\/tasks\/([A-Za-z0-9-]+)$/);
  if (taskMatch) {
    const id = taskMatch[1];
    const existing = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'Task not found' }, 404);

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));

      // Status is handled separately so the checkbox can toggle without
      // resending the whole task.
      if (body.status !== undefined) {
        const status = body.status === 'done' ? 'done' : 'open';
        await env.DB.prepare(
          'UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        ).bind(status, status === 'done' ? nowISO() : null, nowISO(), id).run();

        // The workout exists as both a card and a task; completing either one
        // must move the other, or the streak silently disagrees with the list.
        const workoutDate = /^workout-(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1];
        if (workoutDate) {
          await logWorkout(env, workoutDate, status === 'done' ? 'done' : 'clear', existing.title);
        }

        // Repeating tasks spawn their next occurrence on completion. Workout
        // tasks are excluded - the weekly plan already schedules those.
        if (status === 'done' && !workoutDate) {
          const next = await scheduleNextOccurrence(env, existing, today);
          if (next) console.log(`Recurring task ${id} -> next due ${next.deadline}`);
        }
      }

      if (body.snooze !== undefined) {
        const until = body.snooze === null ? null : snoozeDate(body.snooze, today);
        await env.DB.prepare('UPDATE tasks SET snoozed_until = ?, updated_at = ? WHERE id = ?')
          .bind(until, nowISO(), id).run();
      }

      const editable = ['title', 'notes', 'category', 'deadline', 'priority', 'estimate_minutes', 'recur', 'subtasks'];
      if (editable.some((k) => body[k] !== undefined)) {
        let fields;
        try {
          fields = cleanTask({ ...existing, ...body });
        } catch (error) {
          return json({ error: String(error.message) }, 400);
        }
        await env.DB.prepare(
          `UPDATE tasks SET title = ?, notes = ?, category = ?, deadline = ?, priority = ?,
                            estimate_minutes = ?, recur = ?, subtasks = ?,
                            hide_until_due = ?, updated_at = ? WHERE id = ?`,
        ).bind(
          fields.title, fields.notes, fields.category, fields.deadline,
          fields.priority, fields.estimate_minutes, fields.recur, fields.subtasks,
          fields.hide_until_due, nowISO(), id,
        ).run();
      }

      const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
      return json({ task });
    }
  }

  // --- today's ranking -------------------------------------------------------
  if (path === '/api/today' && method === 'GET') {
    const { results } = await env.DB
      .prepare("SELECT * FROM tasks WHERE status = 'open'").all();
    const all = results ?? [];

    // The focus list follows whichever folder you're viewing; the digest
    // preview always reflects what the 6am notification will actually say,
    // which spans both folders.
    const actionable = all.filter((t) => !isSnoozed(t, today));
    const category = url.searchParams.get('category');
    const scoped = CATEGORIES.includes(category)
      ? actionable.filter((t) => t.category === category)
      : actionable;

    const workload = workloadFor(all, today);
    // The workout is real time on the plate too; count it.
    const todayPlan = await safePlanForToday(env, timezone);
    if (todayPlan?.duration_minutes) workload.minutes += todayPlan.duration_minutes;

    const todayEvents = await safeEventsForToday(env, timezone);
    const clinical = await safeScheduleForToday(env, today);
    const mappings = await getMappings(env).catch(() => []);

    // Committed time is everything already spoken for: rostered clinical work
    // plus your own standing commitments.
    const committed = todayEvents.reduce((n, e) => n + eventMinutes(e), 0)
      + clinicalMinutesForDay(clinical, mappings);

    return json({
      today,
      clinical: clinical.map((e) => ({ ...e, minutes: entryMinutes(e, mappings) })),
      free: await nextFreeDays(env, today, mappings).catch(() => ({})),
      // The fortnight ahead, so the Upcoming view can show what is coming
      // rather than only what is due.
      upcomingClinical: (await scheduleFrom(env, today, 21))
        .filter((e) => e.date > today)
        .map((e) => ({ ...e, minutes: entryMinutes(e, mappings) })),
      events: todayEvents.map((e) => ({ ...e, label: eventLabel(e) })),
      workload: {
        ...workload,
        committed,
        capacity: (await settings(env)).dailyCapacity,
        // Where the gap actually is, not just how much of the day is left.
        freeWindow: (() => {
          const w = longestFreeWindow(busyIntervals(clinical, todayEvents, mappings));
          return w ? { minutes: w.end - w.start, label: `${toClock(w.start)}-${toClock(w.end)}` } : null;
        })(),
      },
      ranked: rankTasks(scoped, today),
      digest: buildDigest(all, today, await folderLabels(env)),
      counts: {
        personal: actionable.filter((t) => (t.category || 'personal') === 'personal').length,
        work: actionable.filter((t) => t.category === 'work').length,
        fitness: actionable.filter((t) => t.category === 'fitness').length,
      },
    });
  }

  // --- push subscriptions ----------------------------------------------------
  if (path === '/api/subscriptions' && method === 'GET') {
    // The endpoint is returned so a client can tell whether the server still
    // knows about *this* device, rather than trusting its local subscription.
    const { results } = await env.DB.prepare(
      'SELECT id, device_label, endpoint, created_at, last_success, last_error FROM subscriptions ORDER BY created_at',
    ).all();
    return json({ devices: results ?? [] });
  }

  if (path === '/api/subscriptions' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return json({ error: 'Invalid subscription' }, 400);
    }
    const label = String(body.label ?? 'device').slice(0, 60);

    // Re-subscribing from the same device replaces the old row rather than
    // stacking up duplicates that would each fire their own notification.
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, endpoint, p256dh, auth, device_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         device_label = excluded.device_label,
         last_error = NULL`,
    ).bind(newId(), sub.endpoint, sub.keys.p256dh, sub.keys.auth, label, nowISO()).run();

    return json({ ok: true });
  }

  if (path === '/api/subscriptions' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    if (body.endpoint) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
    } else if (body.id) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(body.id).run();
    } else {
      return json({ error: 'endpoint or id required' }, 400);
    }
    return json({ ok: true });
  }

  // --- workouts --------------------------------------------------------------
  if (path === '/api/workout/today' && method === 'GET') {
    return json(await todayWorkout(env, today, timezone));
  }

  if (path === '/api/workout/log' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const status = ['done', 'skipped', 'clear'].includes(body.status) ? body.status : 'done';
    const entry = await getPlanForDay(env, localDayOfWeek(timezone));

    await logWorkout(env, today, status, entry?.title ?? '');
    // Keep the mirrored task in step, so ticking one does not leave the other
    // stale. The task id is derived from the date, so this is idempotent.
    await syncWorkoutTask(env, today, status);

    return json(await todayWorkout(env, today, timezone));
  }

  if (path === '/api/workout/plan' && method === 'GET') {
    const plan = await getPlan(env);
    return json({ plan, dayNames: DAY_NAMES, warnings: backToBackImpactDays(plan) });
  }

  if (path === '/api/workout/plan' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    const day = Number(body.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return json({ error: 'day_of_week must be 0-6' }, 400);
    }
    const saved = await savePlanEntry(env, day, body);
    const plan = await getPlan(env);
    return json({ entry: saved, warnings: backToBackImpactDays(plan) });
  }

  // --- clinical schedule -----------------------------------------------------
  if (path === '/api/schedule' && method === 'GET') {
    const mappings = await getMappings(env);
    return json({
      configured: Boolean(env.QGENDA_ICS_URL),
      lastSync: await getSetting(env, 'schedule_synced_at', null),
      lastResult: await getSetting(env, 'schedule_last_result', null),
      today: await safeScheduleForToday(env, today),
      upcoming: await scheduleFrom(env, today, 14),
      mappings,
    });
  }

  if (path === '/api/schedule/sync' && method === 'POST') {
    if (!env.QGENDA_ICS_URL) {
      return json({ ok: false, reason: 'No feed configured. Set the QGENDA_ICS_URL secret.' }, 400);
    }
    const result = await syncSchedule(env, today, timezone, { force: true });
    await setSetting(env, 'schedule_last_result', result.ok
      ? `Synced ${result.stored} assignments`
      : result.reason);
    if (result.ok) await setSetting(env, 'schedule_synced_at', result.syncedAt);
    return json(result, result.ok ? 200 : 400);
  }

  if (path === '/api/schedule/mappings' && method === 'PUT') {
    const body = await request.json().catch(() => ({}));
    try {
      await saveMapping(env, body.pattern, body.minutes, body.notes, body.concurrency_group);
      return json({ mappings: await getMappings(env) });
    } catch (error) {
      return json({ error: String(error.message) }, 400);
    }
  }

  if (path === '/api/schedule/mappings' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    if (!body.pattern) return json({ error: 'pattern required' }, 400);
    await deleteMapping(env, body.pattern);
    return json({ mappings: await getMappings(env) });
  }

  // --- quick add from plain text ----------------------------------------------
  if (path === '/api/quick' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const text = String(body.text ?? '').trim();
    if (!text) return json({ error: 'Nothing to add' }, 400);

    // The same parser the browser uses, so a dictated task and a typed one
    // behave identically rather than diverging over time.
    const parsed = parseQuickAdd(text, today);

    const id = newId();
    const timestamp = nowISO();
    const fields = cleanTask({
      title: parsed.title,
      deadline: parsed.deadline,
      priority: parsed.priority,
      category: parsed.category || 'personal',
      estimate_minutes: parsed.estimate_minutes,
      recur: parsed.recur,
    });

    await env.DB.prepare(
      `INSERT INTO tasks (id, title, notes, category, deadline, priority, estimate_minutes, status, recur, subtasks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, '[]', ?, ?)`,
    ).bind(
      id, fields.title, fields.notes, fields.category, fields.deadline,
      fields.priority, fields.estimate_minutes, fields.recur, timestamp, timestamp,
    ).run();

    return json({ ok: true, task: await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first() }, 201);
  }

  // --- export ----------------------------------------------------------------
  if (path === '/api/export' && method === 'GET') {
    const payload = await buildExport(env, timezone);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="todo-backup-${today}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // --- Drive backup ----------------------------------------------------------
  if (path === '/api/backup' && method === 'GET') {
    return json({
      configured: driveConfigured(env),
      encrypted: Boolean(env.BACKUP_PASSPHRASE),
      lastAt: await getSetting(env, 'backup_last_at', null),
      lastResult: await getSetting(env, 'backup_last_result', null),
    });
  }

  if (path === '/api/backup' && method === 'POST') {
    if (!driveConfigured(env)) {
      return json({ ok: false, error: 'Google Drive is not connected' }, 400);
    }
    const result = await runBackup(env, today, timezone);
    // `error` as well as `reason`: the client's fetch wrapper reads `error`,
    // and a backup failure whose cause is swallowed is the worst kind.
    return json(result.ok ? result : { ...result, error: result.reason },
      result.ok ? 200 : 502);
  }

  // --- demo ------------------------------------------------------------------
  if (path === '/api/demo/reset' && method === 'POST') {
    // Only ever reachable on the demo deployment. On the real app this route
    // does not exist, so there is no path by which a stray request could wipe
    // real data.
    if (env.DEMO_MODE !== 'true') return json({ error: 'Not found' }, 404);
    const result = await seedDemo(env, today);
    return json({ ok: true, ...result });
  }

  // --- restore ---------------------------------------------------------------
  if (path === '/api/import' && method === 'POST') {
    const body = await request.json().catch(() => null);

    let payload = body?.backup;

    // A sealed file arrives base64-armoured; unseal it before anything else
    // looks at it, so the rest of the path is identical for both kinds.
    if (body?.encrypted) {
      if (!env.BACKUP_PASSPHRASE) {
        return json({ ok: false, error: 'This backup is encrypted, but no BACKUP_PASSPHRASE is set on the server.' }, 400);
      }
      try {
        const bytes = fromBase64(body.encrypted);
        if (!isEncryptedBackup(bytes)) {
          return json({ ok: false, error: 'That file is not an encrypted backup from this app.' }, 400);
        }
        payload = JSON.parse(await decryptBackup(env.BACKUP_PASSPHRASE, bytes));
      } catch (error) {
        return json({ ok: false, error: String(error.message || error).slice(0, 200) }, 400);
      }
    }

    // Look before you leap: the client shows this summary and asks the user
    // to confirm it, so a wrong file is caught by a human before any write.
    const check = inspectExport(payload);
    if (!check.ok) return json({ ok: false, errors: check.errors }, 400);
    if (body?.confirm !== true) {
      return json({ ok: true, dryRun: true, ...await restoreExport(env, payload, { dryRun: true }) });
    }

    // The undo. A restore is the one operation here that destroys data, so
    // the state it destroys goes to Drive first. Failure to snapshot does not
    // block the restore - the user asked for it - but it is reported.
    let snapshot = null;
    if (driveConfigured(env)) {
      snapshot = await runBackup(env, today, timezone, 'pre-restore').catch(
        (error) => ({ ok: false, reason: String(error).slice(0, 200) }),
      );
    }

    const result = await restoreExport(env, payload);
    if (!result.ok) return json({ ...result, error: result.errors?.[0] }, 400);

    return json({
      ...result,
      snapshot: snapshot?.ok ? snapshot.file : null,
      encrypted: Boolean(env.BACKUP_PASSPHRASE),
    });
  }

  // --- archive ---------------------------------------------------------------
  if (path === '/api/archive' && method === 'GET') {
    const { archiveAfterDays } = await settings(env);
    return json({
      ...(await previewArchive(env, today, archiveAfterDays)),
      archiveAfterDays,
      lifetimeCompleted: await lifetimeCompleted(env),
    });
  }

  if (path === '/api/archive' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const { archiveAfterDays } = await settings(env);
    const days = body.days !== undefined ? Number(body.days) : archiveAfterDays;
    if (!Number.isFinite(days) || days < 1) {
      return json({ error: 'days must be at least 1' }, 400);
    }
    const result = await runArchive(env, today, days);
    return json({ ...result, lifetimeCompleted: await lifetimeCompleted(env) });
  }

  // --- weekly events ---------------------------------------------------------
  if (path === '/api/events' && method === 'GET') {
    const all = await listEvents(env);
    return json({
      events: all,
      dayNames: DAY_NAMES,
      today: { day_of_week: localDayOfWeek(timezone) },
    });
  }

  if (path === '/api/events' && method === 'POST') {
    try {
      return json({ event: await createEvent(env, await request.json()) }, 201);
    } catch (error) {
      return json({ error: String(error.message) }, 400);
    }
  }

  const eventMatch = path.match(/^\/api\/events\/([A-Za-z0-9-]+)$/);
  if (eventMatch) {
    const id = eventMatch[1];
    if (method === 'DELETE') {
      await deleteEvent(env, id);
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      try {
        const updated = await updateEvent(env, id, await request.json());
        if (!updated) return json({ error: 'Event not found' }, 404);
        return json({ event: updated });
      } catch (error) {
        return json({ error: String(error.message) }, 400);
      }
    }
  }

  // --- sessions (signed-in devices) ------------------------------------------
  if (path === '/api/sessions' && method === 'GET') {
    const sessions = await listSessions(env);
    return json({
      sessions: sessions.map((s) => ({
        id: s.id,
        device_label: s.device_label,
        created_at: s.created_at,
        last_seen: s.last_seen,
        current: s.id === auth.session.id,
      })),
    });
  }

  if (path === '/api/sessions' && method === 'DELETE') {
    const body = await request.json().catch(() => ({}));

    if (body.others === true) {
      await deleteOtherSessions(env, auth.session.id);
      return json({ ok: true });
    }
    if (body.self === true) {
      await deleteSession(env, auth.session.id);
      return json({ ok: true });
    }
    if (!body.id) return json({ error: 'id required' }, 400);

    await deleteSession(env, String(body.id));
    return json({ ok: true });
  }

  // --- send the digest right now, for testing --------------------------------
  if (path === '/api/test-evening' && method === 'POST') {
    return json(await sendEveningNudge(env, today));
  }

  if (path === '/api/test-review' && method === 'POST') {
    return json(await sendWeeklyReview(env, today));
  }

  if (path === '/api/test-push' && method === 'POST') {
    await ensureWorkoutTask(env, today, timezone);
    const result = await sendDigestToAllDevices(env, today, timezone);
    return json(result);
  }

  return json({ error: 'Not found' }, 404);
}

// --------------------------------------------------------------------------
// security headers
// --------------------------------------------------------------------------

/**
 * The app loads nothing from anywhere else - no CDN, no fonts, no analytics -
 * and has no inline scripts or style attributes. That means a strict policy
 * with no 'unsafe-inline' anywhere, which is the version actually worth having.
 */
const SECURITY_HEADERS = {
  // Tell browsers to refuse plain HTTP for this host from now on. Does not
  // protect the very first visit; the redirect below covers that.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  // frame-ancestors covers this for modern browsers; kept for older ones.
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// --------------------------------------------------------------------------
// entry points
// --------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve anything over plain HTTP. Without this, typing the address
    // without a scheme would send the passphrase across the network in clear.
    //
    // The target is built by hand rather than by assigning url.protocol: that
    // assignment silently does nothing in this runtime, which produces a
    // redirect to the identical http:// address and an infinite loop.
    // `wrangler dev` rewrites the request to the configured custom domain, so
    // the Worker sees http://todo.example.com even on localhost - a
    // hostname check cannot tell dev from production. ENVIRONMENT comes from
    // .dev.vars locally and from wrangler.toml in production.
    if (url.protocol === 'http:' && env.ENVIRONMENT !== 'development') {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }

    if (url.pathname.startsWith('/api/')) {
      let response;
      try {
        response = await handleApi(request, env, url);
      } catch (error) {
        console.error('API error', error);
        response = json({ error: 'Server error', detail: String(error).slice(0, 300) }, 500);
      }
      return withSecurityHeaders(response);
    }

    // Everything else is the static frontend.
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  // Cloudflare cron is UTC-only, so this fires twice an hour and we decide here
  // whether it is currently the notify hour where you actually are. The
  // last_digest_date guard makes the extra wake-ups harmless and also protects
  // against a duplicate send when clocks shift.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const { timezone, notifyHour } = await settings(env);
        const { date, hour } = localNow(timezone);

        // One-shot test hook: set meta.force_digest = '1' and the next tick
        // sends immediately, whatever the hour. It clears the flag first so a
        // retry cannot loop, and deliberately does not touch last_digest_date,
        // leaving the real morning schedule completely untouched.
        if (await getSetting(env, 'force_digest', '') === '1') {
          await setSetting(env, 'force_digest', '');
          await ensureWorkoutTask(env, date, timezone);
          const forced = await sendDigestToAllDevices(env, date, timezone);
          console.log(`Forced digest ${date} (${timezone}):`, JSON.stringify({
            sent: forced.sent, failed: forced.failed, removed: forced.removed,
          }));
          return;
        }

        // Refresh the clinical feed every few hours, not only at digest time.
        // A schedule change at 9am should not wait until tomorrow morning.
        // The hash check means an unchanged feed costs one HTTP request.
        if (env.QGENDA_ICS_URL && hour % REFRESH_HOURS === 0) {
          try {
            const sync = await syncSchedule(env, date, timezone);
            if (!sync.unchanged) {
              await setSetting(env, 'schedule_last_result', sync.ok
                ? `Synced ${sync.stored} assignments` : sync.reason);
              if (sync.ok) await setSetting(env, 'schedule_synced_at', sync.syncedAt);
              console.log('Schedule changed:', JSON.stringify(sync));
            }
          } catch (error) {
            console.error('Schedule refresh failed', error);
          }
        }

        // Evening nudge, on the days you have asked for. Its own guard key so
        // a failure here cannot affect tomorrow's morning brief.
        const { eveningDays, eveningHour } = await settings(env);
        const wantsTonight = String(eveningDays)
          .split(',').map((d) => d.trim()).filter(Boolean)
          .includes(String(localDayOfWeek(timezone)));

        if (wantsTonight && hour === eveningHour) {
          try {
            const lastEvening = await getSetting(env, 'last_evening_date', '');
            if (lastEvening !== date) {
              await setSetting(env, 'last_evening_date', date);
              const nudge = await sendEveningNudge(env, date);
              console.log(`Evening nudge ${date}:`, JSON.stringify(nudge));
            }
          } catch (error) {
            console.error('Evening nudge failed', error);
          }
        }

        // The demo puts itself back every night at 4am, so it is never more
        // than a day from the state it was designed to show. Guarded by date
        // so the twice-hourly cron cannot reseed repeatedly.
        // Every six hours rather than nightly. The demo is public and its
        // passphrase is printed on its own lock screen, so anyone can fill it
        // with nonsense; a shorter cycle bounds how long a visitor sees someone
        // else's mess. The guard key includes the hour so the twice-hourly
        // cron cannot reseed twice within the same window.
        if (env.DEMO_MODE === 'true' && hour % 6 === 0) {
          try {
            const window = `${date}-${hour}`;
            const lastSeed = await getSetting(env, 'demo_reset_window', '');
            if (lastSeed !== window) {
              await seedDemo(env, date);
              await setSetting(env, 'demo_reset_window', window);
              console.log(`Demo reset ${window}`);
            }
          } catch (error) {
            console.error('Demo reset failed', error);
          }
        }

        if (hour !== notifyHour) return;

        const lastSent = await getSetting(env, 'last_digest_date', '');
        if (lastSent === date) return;

        // Claim the slot before sending so a retry cannot double-notify.
        await setSetting(env, 'last_digest_date', date);

        // Materialise today's workout task before the digest reads the list.
        // Wrapped because a workout problem must not cost you the digest.
        try {
          await ensureWorkoutTask(env, date, timezone);
        } catch (error) {
          console.error('Could not create the workout task', error);
        }

        const result = await sendDigestToAllDevices(env, date, timezone);
        console.log(`Daily digest ${date} (${timezone}):`, JSON.stringify({
          sent: result.sent, failed: result.failed, removed: result.removed,
        }));

        // Sunday also gets a weekly review. Its own guard key, so a failure
        // here can never suppress tomorrow's daily digest.
        if (localDayOfWeek(timezone) === 0) {
          try {
            const lastReview = await getSetting(env, 'last_review_date', '');
            if (lastReview !== date) {
              await setSetting(env, 'last_review_date', date);
              const review = await sendWeeklyReview(env, date);
              console.log(`Weekly review ${date}:`, JSON.stringify({ sent: review.sent }));
            }
          } catch (error) {
            console.error('Weekly review failed', error);
          }
        }

        // Weekly backup to Drive, on the same Sunday pass as the review.
        // Its own guard key and its own try/catch: a Google outage must cost
        // you a backup, not a morning brief.
        if (localDayOfWeek(timezone) === 0 && driveConfigured(env)) {
          try {
            const lastBackup = await getSetting(env, 'backup_guard_date', '');
            if (lastBackup !== date) {
              await setSetting(env, 'backup_guard_date', date);
              const backup = await runBackup(env, date, timezone);
              console.log(`Weekly backup ${date}:`, JSON.stringify(backup));
              if (!backup.ok) await alertBackupFailure(env, backup);
            }
          } catch (error) {
            console.error('Weekly backup failed', error);
          }
        }

        // Housekeeping: expired sessions, stale lockouts, and old completed
        // tasks. Wrapped so a housekeeping failure never costs you a digest.
        await pruneExpired(env);
        try {
          const { archiveAfterDays } = await settings(env);
          const archived = await runArchive(env, date, archiveAfterDays);
          if (archived.removed) {
            console.log(`Archived ${archived.removed} completed tasks before ${archived.cutoff}`);
          }
        } catch (error) {
          console.error('Archive pass failed', error);
        }
      } catch (error) {
        console.error('Scheduled digest failed', error);
      }
    })());
  },
};
