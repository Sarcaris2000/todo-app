// Getting tasks in and out in formats other tools understand.
//
// Distinct from backup/restore on purpose:
//
//   backup / restore  - every table, exact, destructive. For "the database is
//                       gone". Not meant to be read by a human or by Excel.
//   export  / import  - just the tasks, in a format other software reads, and
//                       importing ADDS rather than replaces.
//
// Conflating the two is how people lose data: someone means to merge a list
// from a spreadsheet and instead overwrites four years of history.

/** RFC 4180: quote when the value contains a comma, quote, or newline. */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'title', 'notes', 'folder', 'deadline', 'priority',
  'estimate_minutes', 'status', 'recur', 'subtasks', 'completed_at',
];

const PRIORITY_NAMES = { 1: 'high', 2: 'normal', 3: 'low' };

export function tasksToCsv(tasks, labels = {}) {
  const rows = [CSV_COLUMNS.join(',')];

  for (const t of tasks) {
    const subtasks = (() => {
      try {
        const list = JSON.parse(t.subtasks || '[]');
        // Round-trippable and readable: "[x] done item | [ ] open item".
        return list.map((s) => `[${s.done ? 'x' : ' '}] ${s.text}`).join(' | ');
      } catch { return ''; }
    })();

    rows.push([
      t.title,
      t.notes,
      labels[t.category] || t.category || 'personal',
      t.deadline || '',
      PRIORITY_NAMES[t.priority] || 'normal',
      t.estimate_minutes || '',
      t.status || 'open',
      t.recur || '',
      subtasks,
      t.completed_at || '',
    ].map(csvCell).join(','));
  }

  return `${rows.join('\n')}\n`;
}

/** A checklist you can paste into an email or a notes app. */
export function tasksToMarkdown(tasks, labels = {}, todayISO = '') {
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const lines = [`# Tasks${todayISO ? ` - ${todayISO}` : ''}`, ''];

  const byFolder = new Map();
  for (const t of open) {
    const key = labels[t.category] || t.category || 'personal';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(t);
  }

  for (const [folder, items] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${folder}`, '');
    for (const t of items) {
      const bits = [];
      if (t.deadline) bits.push(`due ${t.deadline}`);
      if (t.estimate_minutes) bits.push(`${t.estimate_minutes}m`);
      if (t.priority === 1) bits.push('high');
      lines.push(`- [ ] ${t.title}${bits.length ? ` _(${bits.join(', ')})_` : ''}`);

      try {
        for (const s of JSON.parse(t.subtasks || '[]')) {
          lines.push(`  - [${s.done ? 'x' : ' '}] ${s.text}`);
        }
      } catch { /* a malformed subtask blob should not cost you the export */ }
    }
    lines.push('');
  }

  if (done.length) {
    lines.push(`## Completed (${done.length})`, '');
    for (const t of done) lines.push(`- [x] ${t.title}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Which delimiter is this file using?
 *
 * European Excel writes semicolons; anything copied out of a spreadsheet is
 * often tab-separated. Assuming commas turned both into a single column whose
 * "title" was the entire line - garbage that imported without complaint.
 */
export function sniffDelimiter(text) {
  const firstLine = String(text).split(/\n/).find((l) => l.trim()) || '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', '\t', ';', '|']) {
    // Count only outside quotes, so a comma inside a title does not win.
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * A real CSV reader: quoted fields may contain commas and newlines.
 *
 * Splitting on commas works right up until someone's task is called
 * "Call Smith, then Jones" - and then it silently shifts every later column.
 */
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }

  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Other apps name these columns differently. Matching on aliases means a
// Todoist or TickTick export usually just works instead of needing a mapping UI.
const ALIASES = {
  title: ['title', 'task', 'name', 'content', 'subject', 'summary', 'item'],
  notes: ['notes', 'note', 'description', 'details', 'comment'],
  folder: ['folder', 'category', 'list', 'project', 'section', 'area', 'tag'],
  deadline: ['deadline', 'due', 'due date', 'date', 'duedate', 'due_date', 'when'],
  priority: ['priority', 'importance', 'flag'],
  estimate_minutes: ['estimate_minutes', 'estimate', 'minutes', 'duration', 'time'],
  status: ['status', 'completed', 'done', 'state'],
  recur: ['recur', 'repeat', 'recurring', 'recurrence'],
  subtasks: ['subtasks', 'checklist', 'steps'],
};

// Both sides get the same normalisation. Previously the header was normalised
// ("estimate_minutes" -> "estimate minutes") but the alias list was not, so our
// own column name failed to match its own field and every estimate was silently
// dropped on the way back in.
const normalise = (s) => String(s).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

function headerMap(header) {
  const map = {};
  header.forEach((raw, index) => {
    const name = normalise(raw);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (map[field] === undefined && aliases.some((a) => normalise(a) === name)) {
        map[field] = index;
      }
    }
  });
  return map;
}

const cleanDate = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  // Accept the common human forms other exporters produce.
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
};

function cleanPriority(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (['1', 'high', 'p1', 'urgent', 'true', 'yes'].includes(s)) return 1;
  if (['3', 'low', 'p3', 'p4'].includes(s)) return 3;
  return 2;
}

function cleanSubtasks(value) {
  const s = String(value ?? '').trim();
  if (!s) return [];
  return s.split('|').map((part) => {
    const m = part.trim().match(/^\[( |x|X)\]\s*(.*)$/);
    return m
      ? { text: m[2].trim(), done: m[1].toLowerCase() === 'x' }
      : { text: part.trim(), done: false };
  }).filter((x) => x.text);
}

/**
 * Turn parsed CSV rows into tasks, reporting what could not be used.
 *
 * Never throws on a bad row: one malformed line out of two hundred should
 * cost you that line and tell you which, not the whole import.
 */
export function rowsToTasks(rows, { categories = ['personal', 'work', 'fitness'], labels = {} } = {}) {
  if (!rows.length) return { tasks: [], skipped: [], columns: {} };

  const columns = headerMap(rows[0]);
  // No recognisable header? Assume a bare list of titles, one per line.
  const hasHeader = columns.title !== undefined;
  const body = hasHeader ? rows.slice(1) : rows;

  // Folder names are matched against whatever this install calls them.
  const labelToId = {};
  for (const [id, label] of Object.entries(labels)) {
    labelToId[String(label).toLowerCase()] = id;
  }

  const tasks = [];
  const skipped = [];

  body.forEach((row, i) => {
    const at = (field) => (columns[field] === undefined ? '' : row[columns[field]]);
    const title = String((hasHeader ? at('title') : row[0]) ?? '').trim();

    if (!title) { skipped.push({ line: i + (hasHeader ? 2 : 1), why: 'no title' }); return; }

    const folderRaw = String(at('folder') ?? '').trim().toLowerCase();
    const category = labelToId[folderRaw]
      || (categories.includes(folderRaw) ? folderRaw : 'personal');

    const statusRaw = String(at('status') ?? '').trim().toLowerCase();
    const done = ['done', 'completed', 'true', 'yes', 'x', '1'].includes(statusRaw);

    const minutes = Number(String(at('estimate_minutes') ?? '').replace(/[^0-9.]/g, ''));

    tasks.push({
      title: title.slice(0, 200),
      notes: String(at('notes') ?? '').slice(0, 4000),
      category,
      deadline: cleanDate(at('deadline')),
      priority: cleanPriority(at('priority')),
      estimate_minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
      status: done ? 'done' : 'open',
      recur: String(at('recur') ?? '').trim().toLowerCase() || null,
      subtasks: cleanSubtasks(at('subtasks')),
    });
  });

  return { tasks, skipped, columns, hasHeader };
}

import { parseIcs, parseIcsTodos, isIcs } from './ics.js';

// --------------------------------------------------------------------------
// format detection and the other readers
// --------------------------------------------------------------------------

const CHECKBOX = /^(\s*)[-*]\s*\[([ xX])\]\s*(.+)$/;

export function detectFormat(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 'empty';
  if (isIcs(trimmed)) return 'ics';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';

  const lines = trimmed.split('\n').filter((l) => l.trim());
  const checkboxes = lines.filter((l) => CHECKBOX.test(l)).length;
  // One checkbox in a spreadsheet is a coincidence; a third of the file is a
  // Markdown checklist.
  if (checkboxes && checkboxes >= lines.length * 0.3) return 'markdown';

  return 'csv';
}

/**
 * Markdown checklists - what we ourselves export, and what people keep in
 * Obsidian, Apple Notes, and GitHub issues.
 *
 *   ## Work            -> folder for everything beneath it
 *   - [ ] Renew licence -> a task
 *     - [x] Find form   -> a subtask of the task above
 *   _(due 2026-09-01, 30m, high)_ -> metadata we wrote on the way out
 */
export function parseMarkdown(text) {
  const tasks = [];
  const skipped = [];
  let folder = '';

  String(text).split(/\r?\n/).forEach((line, index) => {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const name = heading[1].trim();
      // "Completed (3)" is our own section header, not a folder.
      if (!/^completed\b/i.test(name) && !/^tasks?\b/i.test(name)) folder = name;
      return;
    }

    const box = line.match(CHECKBOX);
    if (!box) {
      if (line.trim()) skipped.push({ line: index + 1, why: 'not a checklist item' });
      return;
    }

    const [, indent, mark, rest] = box;
    const done = mark.toLowerCase() === 'x';

    // Indented items belong to the task above them.
    if (indent.length >= 2 && tasks.length) {
      tasks[tasks.length - 1].subtasks.push({ text: rest.trim(), done });
      return;
    }

    let title = rest.trim();
    let deadline = null;
    let minutes = null;
    let priority = 2;

    const meta = title.match(/_\(([^)]*)\)_\s*$/);
    if (meta) {
      title = title.slice(0, meta.index).trim();
      for (const part of meta[1].split(',').map((p) => p.trim())) {
        if (/^due\s/i.test(part)) deadline = part.replace(/^due\s+/i, '').trim();
        else if (/^\d+m$/i.test(part)) minutes = Number(part.slice(0, -1));
        else if (/^high$/i.test(part)) priority = 1;
        else if (/^low$/i.test(part)) priority = 3;
      }
    }

    if (!title) { skipped.push({ line: index + 1, why: 'no title' }); return; }

    tasks.push({
      title, folder, deadline, priority, minutes,
      status: done ? 'done' : 'open', subtasks: [],
    });
  });

  return { tasks, skipped };
}

/**
 * iCalendar, mapped onto tasks.
 *
 * VTODO is the standard's own to-do component and is preferred whenever the
 * file has any. A file of pure VEVENTs is treated as "turn my calendar into
 * tasks", which is what someone who picked a calendar file plainly wanted -
 * but events are only used when there are no VTODOs to prefer.
 *
 * RFC 5545 priority runs 1 (highest) to 9 (lowest), 0 meaning unset, which is
 * a different scale from ours and from every app's UI.
 */
export function icsToRows(text, timeZone = 'UTC') {
  const header = ['title', 'notes', 'folder', 'deadline', 'priority', 'status'];
  const rows = [header];

  const todos = parseIcsTodos(text, { timeZone });

  if (todos.length) {
    for (const t of todos) {
      const done = t.status === 'COMPLETED' || t.percent === 100 || Boolean(t.completed);
      const priority = !t.priority ? 'normal'
        : t.priority <= 4 ? 'high'
          : t.priority >= 6 ? 'low' : 'normal';
      rows.push([
        t.summary, t.description || '', t.categories || '',
        (t.due || t.start)?.date || '', priority, done ? 'done' : 'open',
      ]);
    }
    return { rows, kind: 'VTODO', count: todos.length };
  }

  const events = parseIcs(text, { timeZone });
  // parseIcs expands multi-day blocks into one entry per date; for tasks we
  // want one task per event, so collapse back to the first date per title.
  const seen = new Map();
  for (const e of events) {
    const key = `${e.title}|${e.date}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  for (const e of seen.values()) {
    rows.push([e.title, '', '', e.date, 'normal', 'open']);
  }
  return { rows, kind: 'VEVENT', count: seen.size };
}

/** A JSON array of task-ish objects, ours or anyone's. */
export function parseJsonTasks(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON'); }

  // Accept a bare array, or the shapes an export usually wraps them in.
  const list = Array.isArray(data) ? data
    : Array.isArray(data.tasks) ? data.tasks
      : Array.isArray(data?.data?.tasks) ? data.data.tasks
        : null;

  if (!list) {
    throw new Error('That JSON has no task list. Expected an array, or an object with a "tasks" array.');
  }
  return list;
}

/**
 * The single entry point the API uses.
 *
 * Detects the format, and - importantly - refuses a file it cannot actually
 * read rather than inventing tasks from it. An earlier version turned a
 * Markdown heading into a task called "## Work" without complaint, which is a
 * worse failure than saying no.
 */
export function importTasks(text, options = {}) {
  const format = detectFormat(text);
  if (format === 'empty') throw new Error('That file was empty');

  let rows;
  if (format === 'markdown') {
    const parsed = parseMarkdown(text);
    rows = [['title', 'notes', 'folder', 'deadline', 'priority', 'estimate_minutes', 'status', 'subtasks']];
    for (const t of parsed.tasks) {
      rows.push([
        t.title, '', t.folder, t.deadline || '',
        t.priority === 1 ? 'high' : t.priority === 3 ? 'low' : 'normal',
        t.minutes || '', t.status,
        t.subtasks.map((s) => `[${s.done ? 'x' : ' '}] ${s.text}`).join(' | '),
      ]);
    }
    const result = rowsToTasks(rows, options);
    return { ...result, format, skipped: [...parsed.skipped, ...result.skipped] };
  }

  if (format === 'ics') {
    const { rows: icsRows, kind, count } = icsToRows(text, options.timeZone || 'UTC');
    if (!count) {
      throw new Error('That calendar file has no to-dos or events in it');
    }
    return { ...rowsToTasks(icsRows, options), format, icsKind: kind };
  }

  if (format === 'json') {
    const list = parseJsonTasks(text);
    const fields = ['title', 'notes', 'category', 'folder', 'deadline', 'priority',
      'estimate_minutes', 'status', 'recur', 'subtasks'];
    const header = fields.filter((f) => list.some((x) => x && x[f] !== undefined));
    if (!header.includes('title')) throw new Error('Those JSON objects have no "title" field');
    rows = [header];
    for (const item of list) {
      rows.push(header.map((f) => {
        const v = item?.[f];
        if (f === 'subtasks' && Array.isArray(v)) {
          return v.map((s) => `[${s?.done ? 'x' : ' '}] ${s?.text ?? s}`).join(' | ');
        }
        return v === null || v === undefined ? '' : String(v);
      }));
    }
    return { ...rowsToTasks(rows, options), format };
  }

  const delimiter = sniffDelimiter(text);
  const result = rowsToTasks(parseCsv(text, delimiter), options);

  // Last line of defence: if the "titles" look like markup or raw data, we
  // guessed the format wrong, and importing would create nonsense.
  const suspicious = result.tasks.filter((t) =>
    /^[#>{[]|^\s*[-*]\s*\[|[;\t|]\s*\S+\s*[;\t|]/.test(t.title)).length;
  if (result.tasks.length && suspicious > result.tasks.length * 0.5) {
    throw new Error('That file could not be read as a task list. Supported: CSV (comma, '
      + 'semicolon or tab separated), a Markdown checklist, a JSON array, or one task per line.');
  }

  return { ...result, format, delimiter };
}
