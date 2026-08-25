// Reading a backup back in.
//
// The counterpart to buildExport(). Two things make this harder than it looks:
//
//   1. A backup can be older than the schema it is restored into, or newer.
//      Columns are intersected with the live table rather than trusted, so a
//      restore never fails on a column that has since been added or dropped.
//   2. It is the only destructive operation in the app. Nothing here runs
//      without an explicit confirmation, and the caller takes a snapshot of
//      the current state first.

export const RESTORABLE = [
  'tasks', 'events', 'workout_plan', 'workout_log',
  'schedule_days', 'service_hours', 'meta',
];

/**
 * Settings that describe the running system rather than the user's data.
 *
 * Restoring a three-week-old `last_digest_date` would re-fire a digest already
 * sent; restoring `backup_last_result` would report a backup that did not
 * happen; restoring `schedule_feed_hash` would let the next sync decide the
 * feed is unchanged and leave the restored schedule rows stale. The user's
 * real preferences - timezone, notify hour, capacity - are not in this list
 * and do come back.
 */
const META_RUNTIME_KEYS = new Set([
  'force_digest', 'last_digest_date', 'last_evening_date', 'last_review_date',
  'backup_guard_date', 'backup_last_at', 'backup_last_result', 'backup_fail_streak',
  'schedule_synced_at', 'schedule_last_result', 'schedule_feed_hash',
  'demo_reset_window', 'demo_reset_date', 'demo_seeded_at',
  'vision_day', 'vision_used',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Is this file a backup of this app, and what is in it?
 *
 * Deliberately strict about provenance and lenient about contents: a JSON file
 * from somewhere else must be rejected outright, but a genuine backup missing
 * a table that did not exist when it was taken is fine.
 */
export function inspectExport(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { ok: false, errors: ['That file is not a backup - it is not a JSON object.'], summary: null };
  }
  if (payload.app !== 'todo') {
    errors.push('That file was not produced by this app (no "app": "todo" marker).');
  }
  if (!isPlainObject(payload.data)) {
    errors.push('The backup has no "data" section.');
  }

  if (errors.length) return { ok: false, errors, summary: null };

  const counts = {};
  let total = 0;
  for (const table of RESTORABLE) {
    const rows = payload.data[table];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      errors.push(`"${table}" is not a list of rows.`);
      continue;
    }
    counts[table] = rows.length;
    total += rows.length;
  }

  if (errors.length) return { ok: false, errors, summary: null };
  if (total === 0) {
    return { ok: false, errors: ['That backup is empty - it contains no rows at all.'], summary: null };
  }

  const tasks = payload.data.tasks ?? [];
  const deadlines = tasks.map((t) => t?.deadline).filter(Boolean).sort();

  return {
    ok: true,
    errors: [],
    summary: {
      exportedAt: typeof payload.exported_at === 'string' ? payload.exported_at : null,
      schemaVersion: payload.schema_version ?? null,
      timezone: typeof payload.timezone === 'string' ? payload.timezone : null,
      counts,
      total,
      openTasks: tasks.filter((t) => t?.status !== 'done').length,
      deadlineRange: deadlines.length
        ? { first: deadlines[0], last: deadlines[deadlines.length - 1] }
        : null,
    },
  };
}

/** The columns this database actually has, so a backup cannot introduce one. */
async function liveColumns(env, table) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((results ?? []).map((c) => c.name));
}

/** D1 rejects very large batches, so writes go up in chunks. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Replace the contents of the restorable tables with those in the backup.
 *
 * `subscriptions`, `sessions`, and `auth_attempts` are never touched: they are
 * not in a backup, and wiping them would sign out every device and stop the
 * morning notification arriving.
 */
export async function restoreExport(env, payload, { dryRun = false } = {}) {
  const check = inspectExport(payload);
  if (!check.ok) return { ok: false, errors: check.errors };

  const report = { restored: {}, skippedColumns: {}, skippedMetaKeys: 0 };

  for (const table of RESTORABLE) {
    const rows = payload.data[table];
    if (!Array.isArray(rows)) continue;

    const columns = await liveColumns(env, table);
    if (columns.size === 0) continue; // table does not exist here at all

    let usable = rows;
    if (table === 'meta') {
      const before = usable.length;
      usable = usable.filter((r) => !META_RUNTIME_KEYS.has(String(r?.key)));
      report.skippedMetaKeys = before - usable.length;
    }

    // Any column in the backup that this schema no longer has is dropped
    // rather than treated as an error.
    const present = new Set();
    for (const row of usable) {
      if (!isPlainObject(row)) continue;
      for (const key of Object.keys(row)) present.add(key);
    }
    const keep = [...present].filter((c) => columns.has(c));
    const dropped = [...present].filter((c) => !columns.has(c));
    if (dropped.length) report.skippedColumns[table] = dropped;

    report.restored[table] = usable.length;
    if (dryRun || keep.length === 0) continue;

    const placeholders = keep.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${table} (${keep.join(', ')}) VALUES (${placeholders})`;

    // meta is merged by key so that settings absent from the backup keep
    // their current value; every other table is replaced wholesale.
    if (table !== 'meta') {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }

    for (const group of chunk(usable.filter(isPlainObject), 40)) {
      await env.DB.batch(group.map((row) => env.DB.prepare(sql)
        .bind(...keep.map((c) => (row[c] === undefined ? null : row[c])))));
    }
  }

  return { ok: true, dryRun, summary: check.summary, ...report };
}
