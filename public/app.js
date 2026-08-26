'use strict';

// --------------------------------------------------------------------------
// state
// --------------------------------------------------------------------------

// A random session token, not the passphrase. The passphrase is sent exactly
// once - to /api/auth - and is never stored on the device.
const TOKEN_KEY = 'todo.session';
let token = localStorage.getItem(TOKEN_KEY) || '';
let config = { vapidPublicKey: null, timezone: 'America/Chicago', notifyHour: 6, today: '' };
let tasks = [];
let filter = 'open';
let search = '';
let editingSubtasks = [];
let upcomingClinical = [];
let upcomingEvents = [];
let upcomingDays = Number(localStorage.getItem('todo.upcomingDays')) || 7;

// Which folder is being viewed: 'all' | 'work' | 'personal' | 'fitness'. Sticky per device.
const FOLDER_KEY = 'todo.folder';
let folder = localStorage.getItem(FOLDER_KEY) || 'all';

// Defaults only. Replaced by whatever this install has been renamed to, as
// soon as /config comes back.
let FOLDER_LABELS = { work: 'Work', personal: 'Personal', fitness: 'Fitness' };

/**
 * Push the current names into every place one is shown: the tabs, the
 * new-task menu, and (via re-render) the chips on each row.
 *
 * The tab row is a fixed four, so this never changes the layout - but three
 * long names can still overflow it, which is what the settings warning is for.
 */
function applyFolderLabels(labels) {
  if (labels) FOLDER_LABELS = { ...FOLDER_LABELS, ...labels };
  for (const id of ['work', 'personal', 'fitness']) {
    const tab = document.getElementById(`tab-name-${id}`);
    if (tab) tab.textContent = FOLDER_LABELS[id];
    const option = document.getElementById(`opt-${id}`);
    if (option) option.textContent = FOLDER_LABELS[id];
    const camOption = document.getElementById(`cam-opt-${id}`);
    if (camOption) camOption.textContent = FOLDER_LABELS[id];
  }
}
const RECUR_LABELS = {
  daily: 'Every day', weekdays: 'Every weekday',
  weekly: 'Every week', monthly: 'Every month',
};
const folderLabel = (c) => FOLDER_LABELS[c || 'personal'] || 'Personal';
const inFolder = (task) => folder === 'all' || (task.category || 'personal') === folder;

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------------------
// api
// --------------------------------------------------------------------------

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        // Session tokens are base64url, so they are always header-safe. The
        // passphrase never travels this way - it could contain characters an
        // HTTP header cannot carry.
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection, and that the app is deployed.');
  }

  if (response.status === 401) {
    lock('Session expired. Enter your passphrase again.');
    throw new Error('Unauthorized');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // The most common first-run failure is a deploy whose database schema was
    // never applied. Say so plainly instead of leaking a raw SQLite error.
    if (/no such table/i.test(data.detail || '')) {
      throw new Error(
        'The database has no tables yet. Run this from the project folder, then reload:\n'
        + 'npx wrangler d1 execute todo --remote --file=./schema.sql',
      );
    }
    // `detail` carries the actual exception. Dropping it turned a real bug
    // into the word "Server error" and cost a round trip to diagnose.
    const detail = data.detail && data.detail !== data.error ? ` - ${data.detail}` : '';
    throw new Error(`${data.error || `Request failed (${response.status})`}${detail}`);
  }

  return data;
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 2800);
}

const DAY_MS = 86400000;

function daysUntil(fromISO, toISO) {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

function deadlineLabel(deadline, today) {
  if (!deadline) return null;
  const days = daysUntil(today, deadline);
  if (days === null) return null;
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'due yesterday';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days <= 6) return `due in ${days} days`;
  return `due ${deadline}`;
}

/**
 * "3pm", "9:30am". Mirrors timeLabel in rank.js, which does the same job for
 * the notification text - the two must agree, or a task reads one way on the
 * lock screen and another in the list.
 */
function timeLabel(hhmm) {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${min ? `:${String(min).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * "8am-12pm", "7pm", "6am-7pm". One format for every span in the UI.
 *
 * The app used to show four at once on a single screen: a task chip said
 * "3pm", the Coming up row said "19:00-21:30", the clinical strip said
 * "06:00–19:00", and the notification said "4pm-5pm" - four renderings of the
 * same kind of fact, which reads as four different kinds of thing.
 */
function timeRange(start, end) {
  const from = timeLabel(start);
  if (!from) return null;
  const to = timeLabel(end);
  return to ? `${from}-${to}` : from;
}

function estimateLabel(minutes) {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} hr` : `${hours.toFixed(1)} hr`;
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function greetingFor(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

function matchesSearch(task) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return String(task.title).toLowerCase().includes(needle)
    || String(task.notes || '').toLowerCase().includes(needle)
    || JSON.parse(task.subtasks || '[]').some((st) => String(st.text).toLowerCase().includes(needle));
}

/** One task row. Shared by the ranked list and the grouped Upcoming view. */
function taskRowHtml(task, rank) {

    const days = task.deadline ? daysUntil(config.today, task.deadline) : null;
    const dueClass = days === null ? '' : days < 0 ? 'overdue' : days <= 2 ? 'due-soon' : '';
    const chips = [];

    // In a single-folder view the label is redundant - everything is that folder.
    if (folder === 'all') {
      const c = task.category || 'personal';
      chips.push(`<span class="chip folder-${c}">${escapeHtml(folderLabel(c))}</span>`);
    }

    const due = deadlineLabel(task.deadline, config.today);
    if (due) chips.push(`<span class="chip ${dueClass}">${escapeHtml(due)}</span>`);
    // Sits next to the deadline: together they are one answer to "when".
    const at = timeLabel(task.start_time);
    if (at) chips.push(`<span class="chip at-time">${escapeHtml(at)}</span>`);
    if (task.priority === 1) chips.push('<span class="chip p1">High</span>');
    if (task.priority === 3) chips.push('<span class="chip">Low</span>');
    const estimate = estimateLabel(task.estimate_minutes);
    if (estimate) chips.push(`<span class="chip">${escapeHtml(estimate)}</span>`);
    if (task.recur) chips.push(`<span class="chip repeats">${escapeHtml(RECUR_LABELS[task.recur] || 'Repeats')}</span>`);
    if (task.snooze_label) chips.push(`<span class="chip snoozed">${escapeHtml(task.snooze_label)}</span>`);
    const steps = JSON.parse(task.subtasks || '[]');
    if (steps.length) {
      const done_ = steps.filter((x) => x.done).length;
      chips.push(`<span class="chip progress">${done_}/${steps.length}</span>`);
    }

    const done = task.status === 'done';

    // The top three open tasks in the current view carry the rank badge that
    // the old "What to work on" panel used to show.
    const badge = rank > 0 && rank <= 3
      ? `<span class="rank rank-${rank}">${rank}</span>`
      : '';

    return `
      <div class="task-row" data-id="${task.id}">
        <!-- An invisible strip down the left edge. Hovering it brings in the
             Later button; hovering anywhere else brings in Edit and Complete.
             A mouse cannot swipe, so without this the left-hand action was
             simply unreachable on a laptop. -->
        <span class="later-zone" aria-hidden="true"></span>
        <div class="task-later">
          <!-- Two rows: a plain label saying what this strip is, then the
               durations. The label is a span, not a button - naming the action
               is its whole job, and a third clickable thing here would just be
               something else to hit by accident. -->
          <span class="later-title">${task.snoozed ? 'Snoozed' : 'Snooze'}</span>
          <div class="later-options">
            ${task.snoozed
    ? `<button data-later="${task.id}">Unhide</button>`
    : `<button data-snooze="${task.id}" data-preset="tomorrow">Tomorrow</button>
               <button data-snooze="${task.id}" data-preset="weekend">Weekend</button>
               <button data-snooze="${task.id}" data-preset="nextweek">Next week</button>`}
          </div>
        </div>
        <div class="task-actions" aria-hidden="false">
          <button class="swipe-action edit" data-edit="${task.id}">Edit</button>
          <button class="swipe-action complete" data-toggle="${task.id}">
            ${done ? 'Reopen' : 'Complete'}
          </button>
        </div>
        <div class="task ${done ? 'done' : ''} ${task.overdue && !done ? 'is-overdue' : ''} ${task.snoozed ? 'is-snoozed' : ''}">
          ${badge || '<span class="rank rank-none" aria-hidden="true"></span>'}
          <div class="task-main">
            <div class="task-title">${escapeHtml(task.title)}</div>
            ${task.notes ? `<div class="task-notes">${escapeHtml(task.notes)}</div>` : ''}
            ${chips.length ? `<div class="task-meta">${chips.join('')}</div>` : ''}
          </div>
        </div>
      </div>`;
  }

function renderList() {
  const container = $('task-list');

  // A search looks everywhere. Scoping it to the current folder and status
  // would hide the thing you are searching for and give no clue why.
  const visible = search
    ? tasks.filter(matchesSearch)
    : tasks.filter(inFolder).filter((task) => (
      filter === 'all' ? true
        : filter === 'done' ? task.status === 'done'
          : task.status === 'open'
    ));

  // No client-side sorting: the server already returns open tasks in ranked
  // order, so the top of this list is what to work on. Sorting again here would
  // be a second, competing opinion.
  $('empty-state').hidden = visible.length > 0;

  let openRank = 0;

  container.innerHTML = visible.map((task) => {
    const rank = (!task.snoozed && task.status !== 'done') ? ++openRank : 0;
    return taskRowHtml(task, rank);
  }).join('');

  closeSwipedRow();
}

// --------------------------------------------------------------------------
// coming up
// --------------------------------------------------------------------------

/**
 * The days ahead, as a schedule rather than a to-do list.
 *
 * Kept separate from Tasks deliberately: a rostered clinic is not something
 * you complete, and interleaving the two made the task list answer two
 * different questions at once.
 */
function renderFreeDays(free) {
  const box = $('free-days');
  if (!free || (!free.nextFreeDay && !free.nextFreeWeekend)) { box.textContent = ''; return; }

  const pretty = (iso) => new Date(`${iso}T12:00:00Z`)
    .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const bits = [];
  if (free.nextFreeDay) bits.push(`Next clear day: ${pretty(free.nextFreeDay)}`);
  if (free.nextFreeWeekend) {
    bits.push(`next clear weekend: ${pretty(free.nextFreeWeekend.saturday)}\u2013${pretty(free.nextFreeWeekend.sunday)}`);
  }
  box.textContent = bits.join(' · ');
}

// Least movable first: a rostered shift, then an appointment, then a task.
const KIND_ORDER = { clinical: 0, event: 1, task: 2 };

function renderUpcoming() {
  const section = $('upcoming-section');
  const container = $('upcoming-list');

  const horizon = new Date(Date.parse(`${config.today}T00:00:00Z`) + upcomingDays * DAY_MS)
    .toISOString().slice(0, 10);

  const rows = [
    ...upcomingClinical
      .filter((c) => c.date > config.today && c.date <= horizon)
      .map((c) => ({ date: c.date, kind: 'clinical', entry: c })),
    ...upcomingEvents
      .filter((e) => e.date > config.today && e.date <= horizon)
      .map((e) => ({ date: e.date, kind: 'event', entry: e })),
    ...tasks
      .filter((t) => t.status === 'open' && !t.snoozed
        && t.deadline && t.deadline > config.today && t.deadline <= horizon)
      .map((t) => ({ date: t.deadline, kind: 'task', task: t })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date))
    // Within a day the order runs from what cannot move to what can.
    || (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));

  section.hidden = false;
  $('upcoming-empty').hidden = rows.length > 0;

  let lastDay = null;
  container.innerHTML = rows.map((row) => {
    let heading = '';
    if (row.date !== lastDay) {
      lastDay = row.date;
      const d = new Date(`${row.date}T12:00:00Z`);
      heading = `<div class="day-heading">${escapeHtml(
        d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      )}</div>`;
    }

    if (row.kind === 'clinical') {
      const e = row.entry;
      const hours = e.minutes ? prettyMinutes(e.minutes) : null;
      return `${heading}
        <div class="clinical-row">
          <span class="clinical-dot" aria-hidden="true"></span>
          <span class="clinical-title">${escapeHtml(e.title.replace(/\s*\[.*\]$/, ''))}</span>
          ${hours ? `<span class="clinical-hours">${escapeHtml(hours)}</span>` : ''}
        </div>`;
    }

    if (row.kind === 'event') {
      const e = row.entry;
      const when = timeRange(e.start_time, e.end_time);
      return `${heading}
        <div class="clinical-row is-event">
          <span class="clinical-dot" aria-hidden="true"></span>
          <span class="clinical-title">${escapeHtml(e.title)}</span>
          ${when ? `<span class="clinical-hours">${escapeHtml(when)}</span>` : ''}
        </div>`;
    }

    const t = row.task;
    const folder = folderLabel(t.category);
    return `${heading}
      <div class="upcoming-task" data-edit="${t.id}">
        <span class="clinical-dot" aria-hidden="true"></span>
        <span class="clinical-title">${escapeHtml(t.title)}</span>
        <span class="chip folder-${escapeHtml(t.category || 'personal')}">${escapeHtml(folder)}</span>
        ${t.priority === 1 ? '<span class="chip p1">High</span>' : ''}
      </div>`;
  }).join('');
}

// --------------------------------------------------------------------------
// weekly events
// --------------------------------------------------------------------------

const EV_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Today according to the server, which is the clock that decides what "once,
// today" means. Empty until the calendar has been loaded at least once.
let todayFromServer = '';

function renderTodayEvents(events, clinical) {
  const box = $('today-events');

  // Rostered clinical work first: it is the part you cannot move.
  const parts = [
    ...(clinical || []).map((c) => {
      const when = timeRange(c.start_time, c.end_time);
      if (when && c.end_time) return `${c.title} ${when}`;
      return c.minutes ? `${c.title} (${prettyMinutes(c.minutes)})` : c.title;
    }),
    ...(events || []).map((e) => e.label),
  ];

  if (!parts.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<b>Today</b>' + parts.map((p) => escapeHtml(p)).join(' · ');
}

// --- clinical schedule ------------------------------------------------------

async function loadSchedule() {
  const s = await api('/schedule');

  $('sched-status').textContent = !s.configured
    ? 'No feed connected. Set the QGENDA_ICS_URL secret to enable it.'
    : `${s.lastResult || 'Never synced'}`
      + (s.lastSync ? ` · last ${new Date(s.lastSync).toLocaleString()}` : '');
  $('sched-sync').disabled = !s.configured;

  const box = $('map-list');
  box.innerHTML = s.mappings.length
    ? s.mappings.map((m) => `
        <div class="event-row">
          <div style="flex:1;min-width:0">
            <div>${escapeHtml(m.pattern)}</div>
            <div class="muted small">${prettyMinutes(m.minutes)}${m.notes ? ` · ${escapeHtml(m.notes)}` : ''}</div>
          </div>
          <button class="device-remove" data-map-remove="${escapeHtml(m.pattern)}">Remove</button>
        </div>`).join('')
    : '<p class="muted small">No assignments mapped yet.</p>';
}

/** "Thu 27 Aug" - short, and unambiguous about which Thursday. */
function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${EV_DAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

/**
 * The calendar list in Settings.
 *
 * Split in two, because one list could not say which rows repeat. A one-off
 * was rendered under its weekday like everything else - "Thu", no date - so a
 * teleclinic on the 27th was indistinguishable from a standing Thursday
 * commitment, and the today highlight fired on every Thursday after it.
 */
function eventRow(e, isToday) {
  const time = (timeRange(e.start_time, e.end_time) ?? 'any time')
    + (e.tentative ? ' · rarely attend' : '');
  // A one-off is stamped with its date; only a dateless row is a weekday.
  const when = e.date ? shortDate(e.date) : EV_DAYS[e.day_of_week].slice(0, 3);
  return `
    <div class="event-row ${isToday ? 'is-today' : ''}">
      <span class="event-day ${e.date ? 'is-once' : ''}">${escapeHtml(when)}</span>
      <div style="flex:1;min-width:0">
        <div>${escapeHtml(e.title)}</div>
        <div class="muted small">${escapeHtml(time)}</div>
      </div>
      <button class="device-remove" data-ev-remove="${e.id}">Remove</button>
    </div>`;
}

async function loadEvents() {
  const { events, today } = await api('/events');
  const container = $('event-list');

  // The server's date, not the browser's: it is the one that decides which day
  // a new event lands on. Done before the empty-calendar return below, since
  // adding your first event is exactly when the default matters most.
  todayFromServer = today.date || todayFromServer;
  syncEventKind();

  const weekly = events.filter((e) => !e.date);
  const once = events.filter((e) => e.date);

  if (!events.length) {
    container.innerHTML = '<p class="muted small">Nothing scheduled yet.</p>';
    return;
  }

  const sections = [];
  if (weekly.length) {
    sections.push(`<p class="muted small ev-heading">Every week</p>`
      + weekly.map((e) => eventRow(e, e.day_of_week === today.day_of_week)).join(''));
  }
  if (once.length) {
    sections.push(`<p class="muted small ev-heading">Just once</p>`
      + once.map((e) => eventRow(e, e.date === today.date)).join(''));
  }
  container.innerHTML = sections.join('');
}

async function addEvent() {
  const title = $('ev-title').value.trim();
  if (!title) { toast('Give the event a name'); return; }

  const once = $('ev-day').value === 'once';
  if (once && !$('ev-date').value) { toast('Pick a date'); return; }

  try {
    await api('/events', {
      method: 'POST',
      // A date makes it a one-off; a weekday makes it a standing commitment.
      // The server derives the weekday from the date, so sending both would
      // only create a way for them to disagree.
      body: JSON.stringify({
        ...(once ? { date: $('ev-date').value } : { day_of_week: Number($('ev-day').value) }),
        title,
        start_time: $('ev-start').value || null,
        end_time: $('ev-end').value || null,
        tentative: $('ev-tentative').checked,
      }),
    });
    $('ev-title').value = '';
    $('ev-start').value = '';
    $('ev-end').value = '';
    $('ev-tentative').checked = false;
    await loadEvents();
    await refresh();
    toast(once ? 'Added to your calendar' : 'Added to your week');
  } catch (error) {
    toast(error.message);
  }
}

// --------------------------------------------------------------------------
// quick add
// --------------------------------------------------------------------------

/** Show what the parser understood, so it can be trusted or corrected. */
const parseInput = (raw) => (typeof globalThis.parseQuickAdd === 'function'
  ? parseQuickAdd(raw, config.today)
  // parse.js missing: treat the whole line as a plain title rather than break.
  : { title: raw, deadline: null, priority: 2, category: null, estimate_minutes: null, recur: null });

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// null = follow the parser's guess; 'task'/'event' = the user overrode it.
let quickKindOverride = null;

const quickKind = (p) => quickKindOverride || (p.kind === 'event' ? 'event' : 'task');

function renderQuickPreview() {
  const box = $('quick-preview');
  const raw = $('quick-input').value.trim();
  if (!raw) { box.hidden = true; return; }

  const p = parseInput(raw);
  const toks = [];
  if (p.deadline) toks.push(deadlineLabel(p.deadline, config.today) || p.deadline);
  if (p.priority === 1) toks.push('high priority');
  if (p.priority === 3) toks.push('low priority');
  if (p.category) toks.push(folderLabel(p.category));
  if (p.estimate_minutes) toks.push(estimateLabel(p.estimate_minutes));
  if (p.recur) toks.push(RECUR_LABELS[p.recur]);

  // The guess is never binding: it is shown, and one tap flips it. Nobody
  // should have to learn that a time range means "event" - they should see what
  // is about to be created and correct it when it is wrong.
  const isEvent = quickKind(p) === 'event';
  if (isEvent) {
    if (p.time) toks.unshift(p.endTime ? `${p.time}-${p.endTime}` : p.time);
    if (p.repeatsWeekly) toks.unshift(`every ${DAY_NAMES[p.dayOfWeek]}`);
  }

  box.hidden = false;
  box.innerHTML = `<span class="kind${isEvent ? ' is-event' : ''}">${isEvent ? 'Event' : 'Task'}</span>`
    + `<b>${escapeHtml(p.title)}</b>`
    + toks.map((t) => `<span class="tok">${escapeHtml(t)}</span>`).join('')
    + `<button type="button" class="kind-flip" id="quick-flip">make it a ${isEvent ? 'task' : 'event'}</button>`;
}

async function submitQuickAdd(event) {
  event.preventDefault();
  const raw = $('quick-input').value.trim();
  if (!raw) return;

  const p = parseInput(raw);
  const kind = quickKind(p);
  try {
    if (kind === 'event') {
      await api('/events', {
        method: 'POST',
        body: JSON.stringify({
          title: p.title,
          // A weekly commitment carries a weekday; a one-off carries a date.
          ...(p.repeatsWeekly
            ? { day_of_week: p.dayOfWeek }
            : { date: p.date || p.deadline || config.today }),
          start_time: p.time || null,
          end_time: p.endTime || null,
        }),
      });
    } else {
      await api('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: p.title,
          deadline: p.deadline,
          // The preview already showed this time back as confirmation that it
          // had been understood, and then the request dropped it. Saying "3pm"
          // and storing nothing was the worst of both.
          start_time: p.time || null,
          priority: p.priority,
          // Unstated folder follows the view you are in, same as the full form.
          category: p.category || (folder === 'all' ? 'personal' : folder),
          estimate_minutes: p.estimate_minutes,
          recur: p.recur,
        }),
      });
    }
    $('quick-input').value = '';
    $('quick-preview').hidden = true;
    quickKindOverride = null;
    await refresh();
    toast(kind === 'event' ? 'Event added' : 'Added');
  } catch (error) {
    toast(error.message);
  }
}

// --------------------------------------------------------------------------
// subtasks
// --------------------------------------------------------------------------

function renderSubtasks() {
  const box = $('subtask-list');
  box.innerHTML = editingSubtasks.map((st, i) => `
    <div class="subtask ${st.done ? 'is-done' : ''}">
      <input type="checkbox" data-st-toggle="${i}" ${st.done ? 'checked' : ''}>
      <span>${escapeHtml(st.text)}</span>
      <button type="button" data-st-remove="${i}" aria-label="Remove step">✕</button>
    </div>`).join('');
}

function addSubtask() {
  const input = $('subtask-input');
  const text = input.value.trim();
  if (!text) return;
  editingSubtasks.push({ text, done: false });
  input.value = '';
  renderSubtasks();
  input.focus();
}

// --------------------------------------------------------------------------
// today's workout
// --------------------------------------------------------------------------

const MODALITY_LABEL = {
  bike: 'Ride', run: 'Run', strength: 'Strength',
  yoga: 'Yoga / mobility', walk: 'Walk', rest: 'Rest',
};

async function renderWorkout() {
  const card = $('workout-card');

  let data;
  try {
    data = await api('/workout/today');
  } catch {
    card.hidden = true;   // workouts are optional; never block the task list
    return;
  }

  const w = data.workout;
  if (!w) { card.hidden = true; return; }

  card.hidden = false;
  const isRest = w.modality === 'rest';
  const logged = data.status;

  card.classList.toggle('is-rest', isRest);
  card.classList.toggle('is-logged', Boolean(logged));

  $('workout-title').textContent = w.title;

  const meta = [
    MODALITY_LABEL[w.modality] || w.modality,
    w.duration_minutes ? `${w.duration_minutes} min` : null,
    w.instructor || null,
  ].filter(Boolean).join(' · ');
  $('workout-meta').textContent = meta;
  $('workout-notes').textContent = w.notes || '';

  // A streak of 1 is not an achievement worth a badge.
  $('workout-streak').textContent = data.streak > 1 ? `${data.streak} day streak` : '';

  // Rest days need no buttons, and a logged day shows what you chose instead.
  $('workout-actions').hidden = isRest || Boolean(logged);
  const loggedNote = $('workout-logged');
  if (logged) {
    loggedNote.hidden = false;
    loggedNote.innerHTML = logged === 'done'
      ? 'Logged as done. <button class="linkish" id="workout-undo">Undo</button>'
      : 'Skipped today. <button class="linkish" id="workout-undo">Undo</button>';
    $('workout-undo').addEventListener('click', () => logWorkout('clear'));
  } else {
    loggedNote.hidden = true;
    loggedNote.textContent = '';
  }
}

async function logWorkout(status) {
  try {
    await api('/workout/log', { method: 'POST', body: JSON.stringify({ status }) });
    await renderWorkout();
    await refresh();
    if (status === 'done') toast('Workout logged');
  } catch (error) {
    toast(error.message);
  }
}

// --- weekly plan editor -----------------------------------------------------

function showPlanWarnings(warnings) {
  const box = $('plan-warning');
  if (!warnings || !warnings.length) { box.hidden = true; return; }
  const pairs = warnings.map((w) => `${w.name} and ${w.nextName}`).join(', ');
  box.hidden = false;
  box.textContent = `Back-to-back running days: ${pairs}. `
    + 'Running loads bone and tendon harder than riding, and they adapt slower '
    + 'than your fitness does. Put a bike, strength or rest day between them.';
}

async function loadPlanEditor() {
  const { plan, dayNames, warnings } = await api('/workout/plan');
  showPlanWarnings(warnings);
  const container = $('plan-editor');
  const todayIndex = new Date(`${config.today}T00:00:00Z`).getUTCDay();

  container.innerHTML = plan.map((entry) => `
    <div class="plan-day ${entry.day_of_week === todayIndex ? 'is-today' : ''}"
         data-day="${entry.day_of_week}">
      <div class="plan-day-name">
        <span>${escapeHtml(dayNames[entry.day_of_week])}</span>
        ${entry.day_of_week === todayIndex ? '<span>today</span>' : ''}
      </div>
      <div class="plan-row">
        <input class="grow" data-field="title" value="${escapeHtml(entry.title)}"
               placeholder="What you're doing" maxlength="120">
      </div>
      <div class="plan-row">
        <select class="shrink" data-field="modality">
          ${['bike', 'run', 'strength', 'yoga', 'walk', 'rest'].map((m) => `
            <option value="${m}" ${entry.modality === m ? 'selected' : ''}>
              ${MODALITY_LABEL[m]}
            </option>`).join('')}
        </select>
        <input class="shrink" data-field="duration_minutes" type="number" min="1" step="1"
               inputmode="numeric" placeholder="min"
               value="${entry.duration_minutes ?? ''}">
        <input class="shrink" data-field="instructor" value="${escapeHtml(entry.instructor)}"
               placeholder="Instructor" maxlength="60">
      </div>
      <div class="plan-row">
        <input class="grow" data-field="notes" value="${escapeHtml(entry.notes)}"
               placeholder="Notes" maxlength="500">
      </div>
    </div>`).join('');

  // Save on blur rather than with a button - seven days times five fields is a
  // lot of rows to make someone confirm one at a time.
  container.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('change', async () => {
      const dayEl = input.closest('.plan-day');
      const payload = { day_of_week: Number(dayEl.dataset.day) };
      dayEl.querySelectorAll('[data-field]').forEach((f) => {
        payload[f.dataset.field] = f.value;
      });
      try {
        const result = await api('/workout/plan', { method: 'PUT', body: JSON.stringify(payload) });
        showPlanWarnings(result.warnings);
        toast('Plan updated');
        await renderWorkout();
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

// --------------------------------------------------------------------------
// swipe-to-reveal
// --------------------------------------------------------------------------

// Width of the revealed Edit + Complete buttons. Must match --actions-width.
const ACTIONS_WIDTH = 168;
// Width of the left-hand Later strip. Must match --later-width.
// Must match --later-width in styles.css; there is a test that they agree.
const LATER_WIDTH = 210;
// Past this much drag, releasing snaps the row open rather than closed.
const OPEN_THRESHOLD = 55;

let swipe = null;        // in-progress gesture
let openRowEl = null;    // the row currently held open

function closeSwipedRow() {
  if (!openRowEl) return;
  // Clearing the inline transform hands control back to the stylesheet, which
  // parks both strips off-screen and lets hover work again.
  const actions = openRowEl.querySelector('.task-actions');
  const later = openRowEl.querySelector('.task-later');
  if (actions) actions.style.transform = '';
  if (later) later.style.transform = '';
  openRowEl.classList.remove('is-open', 'is-open-later');
  openRowEl = null;
}

function openLaterRow(row) {
  if (openRowEl && openRowEl !== row) closeSwipedRow();
  row.querySelector('.task-later').style.transform = 'translateX(0px)';
  row.classList.add('is-open-later');
  openRowEl = row;
}

function openSwipedRow(row) {
  if (openRowEl && openRowEl !== row) closeSwipedRow();
  row.querySelector('.task-actions').style.transform = 'translateX(0px)';
  row.classList.add('is-open');
  openRowEl = row;
}

function initSwipe(container) {
  container.addEventListener('pointerdown', (event) => {
    // Let the action buttons handle their own clicks.
    if (event.target.closest('.task-actions')) return;

    const row = event.target.closest('.task-row');
    if (!row) return;

    swipe = {
      row,
      card: row.querySelector('.task'),
      actions: row.querySelector('.task-actions'),
      later: row.querySelector('.task-later'),
      startX: event.clientX,
      startY: event.clientY,
      // The buttons sit fully off to the right when closed, flush when open.
      base: row.classList.contains('is-open') ? 0 : ACTIONS_WIDTH,
      laterBase: row.classList.contains('is-open-later') ? 0 : -LATER_WIDTH,
      axis: null,          // decided on first meaningful move
      pointerId: event.pointerId,
    };
  });

  container.addEventListener('pointermove', (event) => {
    if (!swipe || event.pointerId !== swipe.pointerId) return;

    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;

    // Decide once whether this is a horizontal swipe or a vertical scroll, so
    // the page still scrolls normally under a finger moving up and down.
    if (!swipe.axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (swipe.axis === 'x') {
        swipe.row.classList.add('is-dragging');
        swipe.card.setPointerCapture?.(event.pointerId);
      }
    }
    if (swipe.axis !== 'x') return;

    event.preventDefault();

    if (dx > 0 && swipe.laterBase === -LATER_WIDTH && swipe.base === ACTIONS_WIDTH) {
      // Swiping right pulls the Later strip in from the left edge.
      let offset = swipe.laterBase + dx;
      if (offset > 0) offset = 0;
      swipe.later.style.transform = `translateX(${offset}px)`;
      swipe.direction = 'right';
      return;
    }

    // Swiping left (negative dx) pulls the buttons in from the right, from
    // ACTIONS_WIDTH (hidden) down to 0 (flush). Clamped at fully-open, with a
    // little rubber-band resistance when pushed back past closed.
    let offset = swipe.base + dx;
    if (offset < 0) offset *= 0.25;
    if (offset > ACTIONS_WIDTH) offset = ACTIONS_WIDTH;
    swipe.actions.style.transform = `translateX(${offset}px)`;
    swipe.direction = 'left';
  });

  const finish = (event) => {
    if (!swipe || (event.pointerId !== undefined && event.pointerId !== swipe.pointerId)) return;

    const dragged = swipe.axis === 'x';
    const row = swipe.row;
    const actions = swipe.actions;
    row.classList.remove('is-dragging');

    if (dragged && swipe.direction === 'right') {
      const offset = swipe.laterBase + (event.clientX - swipe.startX);
      if (offset > -LATER_WIDTH + OPEN_THRESHOLD) openLaterRow(row);
      else {
        swipe.later.style.transform = '';
        row.classList.remove('is-open-later');
        if (openRowEl === row) openRowEl = null;
      }
    } else if (dragged) {
      const offset = swipe.base + (event.clientX - swipe.startX);
      // Pulled in far enough to commit? Otherwise let it spring back.
      if (offset < ACTIONS_WIDTH - OPEN_THRESHOLD) openSwipedRow(row);
      else {
        actions.style.transform = '';
        row.classList.remove('is-open');
        if (openRowEl === row) openRowEl = null;
      }
    } else if (openRowEl) {
      // A plain tap anywhere while a row is open just closes it.
      closeSwipedRow();
    }

    swipe = null;
  };

  container.addEventListener('pointerup', finish);
  container.addEventListener('pointercancel', finish);

  // Trackpad two-finger horizontal swipe on a Mac arrives as wheel deltaX.
  let wheelTimer = null;
  container.addEventListener('wheel', (event) => {
    const row = event.target.closest('.task-row');
    if (!row) return;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;

    event.preventDefault();
    clearTimeout(wheelTimer);
    if (event.deltaX > 8) openSwipedRow(row);
    else if (event.deltaX < -8 && openRowEl === row) closeSwipedRow();
    wheelTimer = setTimeout(() => { wheelTimer = null; }, 200);
  }, { passive: false });
}

function prettyMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderWorkload(w) {
  const box = $('workload');
  if (!w || (!w.minutes && !w.count)) { box.hidden = true; return; }

  box.hidden = false;
  const bits = [`${prettyMinutes(w.minutes)} of tasks`];
  if (w.unestimated) bits.push(`${w.unestimated} unestimated`);
  if (w.committed) bits.push(`${prettyMinutes(w.committed)} committed`);

  // Capacity is time available for work, so commitments are deducted first -
  // otherwise a full clinic day reads the same as an empty one.
  let over = false;
  if (w.capacity > 0) {
    const free = w.capacity - (w.committed || 0);
    if (free <= 0) { bits.push('no free time today'); over = true; }
    else if (w.minutes > free) {
      bits.push(`only ${prettyMinutes(free)} free — ${prettyMinutes(w.minutes - free)} more than fits`);
      over = true;
    } else {
      bits.push(`${prettyMinutes(free)} free`);
    }
  }

  // Where the gap is, not just how much of it there is.
  if (w.freeWindow && w.freeWindow.minutes >= 30) {
    bits.push(`longest clear stretch ${w.freeWindow.label}`);
  }

  box.classList.toggle('is-over', over);
  box.textContent = bits.join(' · ');
}

async function refresh() {
  const scope = folder === 'all' ? '' : `?category=${encodeURIComponent(folder)}`;
  const [taskData, todayData] = await Promise.all([api('/tasks'), api(`/today${scope}`)]);

  // Assigned before any render call - renderUpcoming() reads this, and
  // populating it afterwards left the section a render behind.
  upcomingClinical = todayData.upcomingClinical || [];
  upcomingEvents = todayData.upcomingEvents || [];
  renderFreeDays(todayData.free);
  tasks = taskData.tasks;
  config.today = taskData.today;

  const counts = todayData.counts || { personal: 0, work: 0, fitness: 0 };
  const totalOpenCount = (counts.personal || 0) + (counts.work || 0) + (counts.fitness || 0);
  $('count-all').textContent = totalOpenCount || '';
  $('count-work').textContent = counts.work || '';
  $('count-personal').textContent = counts.personal || '';
  $('count-fitness').textContent = counts.fitness || '';

  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23',
  }).format(new Date()));

  $('greeting').textContent = greetingFor(localHour);
  $('today-date').textContent = new Date(`${config.today}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  renderList();
  renderUpcoming();
  renderWorkout().catch(() => {});

  renderTodayEvents(todayData.events, todayData.clinical);
  renderWorkload(todayData.workload);

  // The digest spans every folder, so report the combined total here rather
  // than whatever folder happens to be on screen. It used to say "both
  // folders", which stopped being true when the third folder arrived and would
  // be wrong again for anyone who renames them.
  const totalOpen = totalOpenCount;
  const hour12 = `${((config.notifyHour + 11) % 12) + 1}${config.notifyHour < 12 ? 'am' : 'pm'}`;
  $('digest-note').textContent = totalOpen
    ? `${totalOpen} open across all folders · digest at ${hour12}`
    : `Digest at ${hour12}`;
}

// --------------------------------------------------------------------------
// task form
// --------------------------------------------------------------------------

/** Highlight whichever quick-duration matches the current value, if any. */
function syncQuickPicks() {
  const current = $('f-estimate').value;
  document.querySelectorAll('.quick').forEach((button) => {
    button.classList.toggle('is-set', button.dataset.minutes !== '' && button.dataset.minutes === current);
  });
}

function openForm(task = null) {
  $('task-form').hidden = false;
  $('add-toggle').hidden = true;
  $('form-error').hidden = true;

  $('task-id').value = task?.id || '';
  $('f-title').value = task?.title || '';
  $('f-notes').value = task?.notes || '';
  // A new task lands in the folder you're looking at; "All" defaults to personal.
  $('f-category').value = task?.category || (folder === 'all' ? 'personal' : folder);
  $('f-deadline').value = task?.deadline || '';
  $('f-start').value = task?.start_time || '';
  $('f-recur').value = task?.recur || '';
  try { editingSubtasks = JSON.parse(task?.subtasks || '[]'); } catch { editingSubtasks = []; }
  renderSubtasks();
  $('f-snooze').value = task?.snoozed_until || '';
  $('f-hide-until-due').checked = Boolean(Number(task?.hide_until_due));
  $('f-priority').value = String(task?.priority || 2);
  $('f-estimate').value = task?.estimate_minutes || '';

  $('save-btn').textContent = task ? 'Save changes' : 'Add task';
  $('delete-btn').hidden = !task;
  syncQuickPicks();
  $('f-title').focus();
}

function closeForm() {
  $('task-form').hidden = true;
  $('add-toggle').hidden = false;
  $('task-form').reset();
  $('task-id').value = '';
}

async function submitForm(event) {
  event.preventDefault();
  const id = $('task-id').value;

  const payload = {
    title: $('f-title').value.trim(),
    notes: $('f-notes').value.trim(),
    category: $('f-category').value,
    recur: $('f-recur').value || null,
    start_time: $('f-start').value || null,
    subtasks: editingSubtasks,
    snooze: $('f-snooze').value || null,
    hide_until_due: $('f-hide-until-due').checked,
    deadline: $('f-deadline').value || null,
    priority: Number($('f-priority').value),
    estimate_minutes: $('f-estimate').value ? Number($('f-estimate').value) : null,
  };

  if (!payload.title) {
    $('form-error').textContent = 'Give the task a name.';
    $('form-error').hidden = false;
    return;
  }

  $('save-btn').disabled = true;
  try {
    if (id) {
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/tasks', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeForm();
    await refresh();
    toast(id ? 'Saved' : 'Task added');
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
  } finally {
    $('save-btn').disabled = false;
  }
}

async function deleteTask() {
  const id = $('task-id').value;
  if (!id || !confirm('Delete this task?')) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  closeForm();
  await refresh();
  toast('Deleted');
}

async function snoozeTask(id, preset) {
  try {
    await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ snooze: preset }) });
    await refresh();
    toast(preset ? 'Hidden until tomorrow' : 'Back on the list');
  } catch (error) {
    toast(error.message);
  }
}

async function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const status = task.status === 'done' ? 'open' : 'done';
  task.status = status; // optimistic, so the checkbox feels instant
  renderList();
  await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  await refresh();
}

// --------------------------------------------------------------------------
// notifications
// --------------------------------------------------------------------------

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function deviceLabel() {
  const ua = navigator.userAgent;
  let base = 'Device';
  if (/iPhone/.test(ua)) base = 'iPhone';
  else if (/iPad/.test(ua)) base = 'iPad';
  else if (/Macintosh/.test(ua)) base = 'Mac';
  else if (/Windows/.test(ua)) base = 'Windows PC';
  else if (/Android/.test(ua)) base = 'Android';

  // The installed app and the browser tab are separate subscriptions with
  // separate storage, so distinguish them - otherwise the device list shows
  // two identical "Mac" rows and there is no way to tell which to remove.
  return `${base} (${isStandalone() ? 'installed app' : 'browser'})`;
}

function base64UrlToUint8Array(base64Url) {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function updateNotificationUI() {
  const status = $('notif-status');
  const button = $('enable-notif');
  const hint = $('ios-hint');

  button.hidden = true;
  hint.hidden = true;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // Safari on iOS only exposes PushManager to home-screen apps, so an
  // unsupported result there almost always means "not installed yet".
  if (!supported) {
    if (isIOS() && !isStandalone()) {
      status.className = 'status-pill off';
      status.textContent = 'Not installed on this iPhone';
      hint.hidden = false;
    } else {
      status.className = 'status-pill off';
      status.textContent = 'This browser does not support push';
    }
    return;
  }

  if (Notification.permission === 'denied') {
    status.className = 'status-pill off';
    status.textContent = 'Blocked in browser settings';
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();

  // A local subscription is not enough - the server has to know about it too.
  // Removing a device in Settings would otherwise leave this stuck on "On"
  // with the enable button hidden, and no way to re-register.
  // null means "could not check", which must not be treated as "off".
  let serverKnows = null;
  if (subscription) {
    try {
      const { devices } = await api('/subscriptions');
      serverKnows = devices.some((d) => d.endpoint === subscription.endpoint);
    } catch {
      serverKnows = null;
    }
  }

  if (subscription && Notification.permission === 'granted' && serverKnows !== false) {
    status.className = 'status-pill on';
    status.textContent = 'On for this device';
  } else {
    status.className = 'status-pill off';
    status.textContent = 'Off for this device';
    button.hidden = false;
  }
}

async function enableNotifications() {
  const button = $('enable-notif');
  button.disabled = true;

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Permission denied');
      return;
    }

    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    if (!config.vapidPublicKey) throw new Error('Server has no VAPID key configured');

    // Reuse the existing subscription if there is one; otherwise create it.
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey),
      });
    }

    await api('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON(), label: deviceLabel() }),
    });

    toast('Notifications on for this device');
    await updateNotificationUI();
    await loadDevices();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function loadDevices() {
  const { devices } = await api('/subscriptions');
  const container = $('device-list');

  if (!devices.length) {
    container.innerHTML = '<p class="muted small">No devices subscribed yet.</p>';
    return;
  }

  container.innerHTML = devices.map((device) => {
    const detail = device.last_error
      ? 'last send failed'
      : device.last_success
        ? `last sent ${new Date(device.last_success).toLocaleDateString()}`
        : 'not sent yet';
    return `
      <div class="device">
        <div>
          <div>${escapeHtml(device.device_label)}</div>
          <div class="muted small">${escapeHtml(detail)}</div>
        </div>
        <button class="device-remove" data-remove="${device.id}">Remove</button>
      </div>`;
  }).join('');
}

async function loadSessions() {
  const { sessions } = await api('/sessions');
  const container = $('session-list');

  if (!sessions.length) {
    container.innerHTML = '<p class="muted small">No active sessions.</p>';
    return;
  }

  container.innerHTML = sessions.map((s) => {
    const seen = s.last_seen
      ? `last used ${new Date(s.last_seen).toLocaleDateString()}`
      : 'not used yet';
    return `
      <div class="device">
        <div>
          <div>${escapeHtml(s.device_label)}${s.current ? ' <span class="chip p1">this device</span>' : ''}</div>
          <div class="muted small">${escapeHtml(seen)}</div>
        </div>
        ${s.current ? '' : `<button class="device-remove" data-revoke="${s.id}">Sign out</button>`}
      </div>`;
  }).join('');
}

// --------------------------------------------------------------------------
// settings sheet
// --------------------------------------------------------------------------

function buildEveningHourOptions() {
  $('s-evening-hour').innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const label = `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? 'am' : 'pm'}`;
    return `<option value="${hour}">${label}</option>`;
  }).join('');
}

function buildHourOptions() {
  const select = $('s-hour');
  select.innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const label = `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? 'am' : 'pm'}`;
    return `<option value="${hour}">${label}</option>`;
  }).join('');
}

function buildEventDayOptions() {
  // "Just once" first, because a one-off is the thing you are most likely to
  // be adding by hand; the seven weekdays are set up once and rarely revisited.
  // Until this existed, Settings could only make weekly commitments, and the
  // only route to a one-off was typing a date into quick add.
  $('ev-day').innerHTML = '<option value="once">Just once…</option>'
    + EV_DAYS.map((d, i) => `<option value="${i}">Every ${d}</option>`).join('');
}

/**
 * Show the date field only when "Just once" is selected.
 *
 * Called once during wiring - before sign-in, when config.today is still the
 * empty placeholder - and again from loadEvents once the real date is known.
 * Guarding on config.today keeps the first call from writing an empty value
 * that looks deliberate.
 */
function syncEventKind() {
  const once = $('ev-day').value === 'once';
  $('ev-date').hidden = !once;
  const today = todayFromServer || config.today;
  if (once && !$('ev-date').value && today) $('ev-date').value = today;
}

// --------------------------------------------------------------------------
// the day plan
// --------------------------------------------------------------------------

const planClock = (mins) => timeLabel(
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);

/**
 * Draw the proposal.
 *
 * Deliberately not interactive: there is nothing to drag and nothing to save.
 * It answers "what could I get done today" and then gets out of the way - the
 * list stays the thing you actually work from.
 */
function renderPlan(plan) {
  const summary = $('plan-summary');
  const list = $('plan-blocks');

  if (!plan.blocks.length) {
    list.innerHTML = '';
    summary.textContent = plan.available === 0
      ? 'No working time left today.'
      : 'Nothing on the list fits the time that is left.';
  } else {
    list.innerHTML = plan.blocks.map((b) => `
      <li class="plan-block ${b.conflict ? 'is-clash' : ''}">
        <span class="plan-time">${escapeHtml(planClock(b.start))}</span>
        <span class="plan-title">${escapeHtml(b.title)}</span>
        <span class="plan-mins">${b.minutes}m</span>
      </li>`).join('');
    summary.textContent = `${prettyMinutes(plan.scheduled)} placed`
      + (plan.spare ? `, ${prettyMinutes(plan.spare)} still free` : ', nothing spare');
  }

  // Saying what did not fit is the honest half: a plan that shows four things
  // and silently omits six reads as "today is fine". But when there was no
  // time to begin with, naming every task is just the whole list again - the
  // summary above has already given the only useful answer.
  const notes = [];
  if (plan.conflicts) {
    notes.push(`${plan.conflicts} pinned to a time you are already committed.`);
  }
  if (plan.unplaced.length && plan.available > 0) {
    const named = plan.unplaced.slice(0, 4).map((u) => u.title);
    const rest = plan.unplaced.length - named.length;
    notes.push(`Did not fit: ${named.join(', ')}${rest ? `, and ${rest} more` : ''}.`);
  }
  $('plan-unplaced').hidden = !notes.length;
  $('plan-unplaced').textContent = notes.join(' ');
}

async function loadPlan() {
  $('plan-summary').textContent = 'Working it out…';
  try {
    renderPlan(await api('/day-plan'));
  } catch (error) {
    $('plan-summary').textContent = error.message;
    $('plan-blocks').innerHTML = '';
  }
}

// --------------------------------------------------------------------------
// calendar feed
// --------------------------------------------------------------------------

function renderFeed(info) {
  const on = Boolean(info.enabled && info.url);
  $('feed-off').hidden = on;
  $('feed-on').hidden = !on;
  if (on) $('feed-url').value = info.url;
}

async function loadFeed() {
  try {
    renderFeed(await api('/feed'));
  } catch {
    $('feed-status').textContent = 'Could not check the calendar link.';
  }
}

/**
 * Mint a link, or replace the one that exists.
 *
 * Replacing is the only revoke there is for a URL already sitting in Apple's
 * servers, so the confirm spells out that subscribed calendars will stop
 * updating rather than quietly breaking later.
 */
async function newFeedLink(replacing) {
  if (replacing && !confirm(
    'Regenerate the link?\n\nAny calendar already subscribed with the old link '
    + 'will stop updating until you give it the new one.')) return;
  try {
    renderFeed(await api('/feed', { method: 'POST' }));
    $('feed-status').textContent = replacing
      ? 'New link created. Re-subscribe anywhere you used the old one.'
      : 'Link created. Paste it into your calendar app.';
  } catch (error) {
    $('feed-status').textContent = error.message;
  }
}

/**
 * Mint a token for a Siri Shortcut and show how to use it.
 *
 * The token is shown once and never again - the server keeps only a hash - so
 * the steps are printed alongside it rather than behind another click.
 */
async function makeShortcutToken() {
  if (!confirm(
    'Create a token for Siri?\n\nIt is shown once and lets anything holding it '
    + 'add to your list. You can revoke it under signed-in devices.')) return;
  try {
    const r = await api('/shortcut-token', { method: 'POST' });
    $('shortcut-out').hidden = false;
    $('shortcut-token').value = r.token;
    $('shortcut-steps').innerHTML = [
      'In Shortcuts: <b>+</b>, then add <b>Dictate Text</b> — it has to come first.',
      'Add <b>Get Contents of URL</b> below it.',
      `URL <code>${escapeHtml(r.endpoint)}?format=text</code>, Method <b>POST</b>.`,
      'Headers: <code>Authorization</code> = <code>Bearer &lt;the token above&gt;</code>'
        + ' — the word Bearer, one space, then the token. No colon.',
      'Request Body <b>JSON</b>, one field, key <code>text</code> (lowercase),'
        + ' value = the blue <b>Dictated Text</b> chip. Tap it in; do not type it.',
      'Add <b>Show Notification</b> last, showing <b>Contents of URL</b>, so you'
        + ' can see what was understood.',
      'Name it &ldquo;Add to To Do&rdquo; — the name is what you say to Siri.',
    ].map((line, i) => `${i + 1}. ${line}`).join('<br>');
    $('shortcut-status').textContent = '';
    await loadSessions().catch(() => {});
  } catch (error) {
    $('shortcut-status').textContent = error.message;
  }
}

async function loadArchiveStatus() {
  const a = await api('/archive');
  $('s-archive').value = a.archiveAfterDays ?? 90;
  const parts = [`${a.lifetimeCompleted} completed all time.`];
  if (a.eligible) {
    parts.push(`${a.eligible} finished before ${a.cutoff} can be cleared`
      + (a.workouts ? ` (${a.workouts} of them workout rows).` : '.'));
  } else {
    parts.push('Nothing old enough to clear.');
  }
  $('archive-status').textContent = parts.join(' ');
  $('archive-now').disabled = !a.eligible;
}

/**
 * Whether Drive is connected, and how the last backup went. A backup you
 * cannot confirm ran is not a backup.
 */
async function refreshBackupStatus() {
  const status = $('backup-status');
  const button = $('backup-now');
  try {
    const info = await api('/backup');
    button.disabled = !info.configured;
    if (!info.configured) {
      status.textContent = 'Not connected yet - see SETUP-DRIVE.md.';
      return;
    }
    status.textContent = info.lastAt
      ? `Last run ${info.lastAt.slice(0, 10)} - ${info.lastResult}`
      : 'Connected. No backup has run yet.';
  } catch {
    status.textContent = '';
  }
}

async function openSettings() {
  $('settings').hidden = false;
  $('s-hour').value = String(config.notifyHour);
  $('s-timezone').value = config.timezone;
  $('s-capacity').value = config.dailyCapacity || 0;
  $('s-evening-hour').value = String(config.eveningHour ?? 20);
  const active = String(config.eveningDays ?? '').split(',').filter(Boolean);
  document.querySelectorAll('#evening-days button').forEach((b) => {
    b.classList.toggle('is-on', active.includes(b.dataset.day));
  });
  await updateNotificationUI();
  await loadDevices();
  await loadSessions().catch(() => {});
  await loadPlanEditor().catch(() => {});
  await loadEvents().catch(() => {});
  await loadFeed().catch(() => {});
  await loadArchiveStatus().catch(() => {});
  await loadSchedule().catch(() => {});
  await refreshBackupStatus().catch(() => {});

  for (const id of ['work', 'personal', 'fitness']) {
    $(`s-folder-${id}`).value = FOLDER_LABELS[id];
  }
  checkFolderWidth();
}

/**
 * Three long names overflow the tab row even though there are only ever four
 * tabs. Measured on a mockup: "Work / Personal / Fitness" fits comfortably,
 * three nine-letter names do not. Warn rather than forbid - it is their phone.
 */
function checkFolderWidth() {
  const names = ['work', 'personal', 'fitness'].map((id) => $(`s-folder-${id}`).value.trim());
  const total = names.reduce((n, s) => n + s.length, 0);
  const warning = $('folder-width-warning');
  warning.hidden = total <= 24;
  warning.textContent = total > 24
    ? `Those names total ${total} characters. Above about 24 the folder row starts to scroll on a phone, and the last folder is hidden until you swipe.`
    : '';
}

async function saveSettings() {
  try {
    const data = await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        notifyHour: Number($('s-hour').value),
        timezone: $('s-timezone').value.trim(),
        dailyCapacity: Number($('s-capacity').value) || 0,
        eveningHour: Number($('s-evening-hour').value),
        eveningDays: [...document.querySelectorAll('#evening-days button.is-on')]
          .map((b) => b.dataset.day).join(','),
        archiveAfterDays: Number($('s-archive').value) || 0,
        folderLabels: {
          work: $('s-folder-work').value,
          personal: $('s-folder-personal').value,
          fitness: $('s-folder-fitness').value,
        },
      }),
    });
    config.notifyHour = data.notifyHour;
    config.timezone = data.timezone;
    config.dailyCapacity = data.dailyCapacity ?? config.dailyCapacity;
    config.eveningDays = data.eveningDays ?? config.eveningDays;
    config.eveningHour = data.eveningHour ?? config.eveningHour;
    // The server sends back what it stored, which may differ from what was
    // typed - blanks become the default, and long names are trimmed.
    if (data.folderLabels) {
      config.folderLabels = data.folderLabels;
      applyFolderLabels(data.folderLabels);
      for (const id of ['work', 'personal', 'fitness']) {
        $(`s-folder-${id}`).value = FOLDER_LABELS[id];
      }
      checkFolderWidth();
    }
    toast('Settings saved');
    await refresh();
  } catch (error) {
    toast(error.message);
  }
}

// --------------------------------------------------------------------------
// lock screen
// --------------------------------------------------------------------------

/**
 * The demo's passphrase, shown on its own lock screen.
 *
 * Keyed off the hostname rather than /api/config, because config needs a
 * session and the whole problem is that the visitor does not have one yet.
 * Only ever true on the demo deployment.
 */
function revealDemoHint() {
  if (location.hostname.split('.')[0] !== 'demo') return;

  $('lock-demo-hint').hidden = false;
  // Filled in rather than merely shown. The passphrase is printed on this
  // screen anyway, so making someone read it and type it back is friction
  // that protects nothing. The lock screen still appears, and the auth code
  // behind it is untouched - there is no bypass, just one less thing to type.
  const input = $('lock-input');
  if (input && !input.value) input.value = 'demo';
}

function lock(message) {
  $('app').hidden = true;
  $('settings').hidden = true;
  $('lock').hidden = false;
  revealDemoHint();
  if (message) {
    $('lock-error').textContent = message;
    $('lock-error').hidden = false;
  }
}

/** Show a failure on the lock screen instead of failing silently. */
function showLockError(error) {
  // "Unauthorized" already routed through lock() with its own message.
  if (error?.message === 'Unauthorized') return;

  const text = error?.message || 'Something went wrong. Check your connection and try again.';
  $('lock-error').textContent = text;
  $('lock-error').style.whiteSpace = 'pre-wrap';
  $('lock-error').hidden = false;
  console.error('Unlock failed:', error);
}

async function unlock(passphrase) {
  let response;
  try {
    response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, label: deviceLabel() }),
    });
  } catch {
    // Browsers report this as a bare "Failed to fetch", which tells you nothing.
    throw new Error('Could not reach the server. Check your connection, and that the app is deployed.');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // 429 means this address is locked out after repeated failures.
    $('lock-error').textContent = data.error
      || (response.status === 429 ? 'Too many attempts. Try again shortly.' : 'Incorrect passphrase');
    $('lock-error').hidden = false;
    return false;
  }

  // Store the session token, never the passphrase.
  token = data.token;
  localStorage.setItem(TOKEN_KEY, token);
  return true;
}

async function start() {
  config = { ...config, ...(await api('/config')) };
  applyFolderLabels(config.folderLabels);

  if (config.camera) $('camera-row').hidden = false;

  if (config.demo) {
    $('demo-banner').hidden = false;
    document.body.classList.add('is-demo');
  }
  $('lock').hidden = true;
  $('app').hidden = false;
  await refresh();

  // Keep the service worker current so push keeps working after a redeploy.
  if ('serviceWorker' in navigator && Notification?.permission === 'granted') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // When a new service worker takes over after a deploy, reload so the page is
  // not left running the previous build. A stale page whose API contract has
  // changed fails in confusing ways - it will happily accept your passphrase
  // and then reject its own next request.
  if ('serviceWorker' in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  // Earlier versions kept the passphrase itself in localStorage. Clear any
  // leftover copy - the whole point of session tokens is that it isn't there.
  localStorage.removeItem('todo.passphrase');

  buildHourOptions();
  buildEveningHourOptions();
  document.querySelectorAll('#evening-days button').forEach((b) => {
    b.addEventListener('click', () => b.classList.toggle('is-on'));
  });

  $('lock-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Unlocking…';
    $('lock-error').hidden = true;

    try {
      if (await unlock($('lock-input').value)) {
        $('lock-input').value = '';
        // start() can still fail after a correct passphrase - the passphrase
        // check never touches the database, so a broken database only shows up
        // here. Without this catch the failure is completely silent.
        await start();
      }
    } catch (error) {
      showLockError(error);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Unlock';
    }
  });

  // Quick durations - faster than typing, and impossible to get wrong.
  document.querySelectorAll('.quick').forEach((button) => {
    button.addEventListener('click', () => {
      $('f-estimate').value = button.dataset.minutes;
      syncQuickPicks();
    });
  });
  $('f-estimate').addEventListener('input', syncQuickPicks);

  $('quick-form').addEventListener('submit', submitQuickAdd);
  $('quick-input').addEventListener('input', () => {
    // Typing again means the guess is worth re-making.
    quickKindOverride = null;
    renderQuickPreview();
  });

  // Delegated: the preview is rebuilt on every keystroke, so the button itself
  // is a different element each time.
  $('quick-preview').addEventListener('click', (event) => {
    if (!event.target.closest('#quick-flip')) return;
    const p = parseInput($('quick-input').value.trim());
    quickKindOverride = quickKind(p) === 'event' ? 'task' : 'event';
    renderQuickPreview();
  });

  $('search').addEventListener('input', (event) => {
    search = event.target.value.trim();
    renderList();
  });

  $('subtask-add-btn').addEventListener('click', addSubtask);
  $('subtask-input').addEventListener('keydown', (event) => {
    // Enter inside the step field must add a step, not submit the whole task.
    if (event.key === 'Enter') { event.preventDefault(); addSubtask(); }
  });
  $('subtask-list').addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-st-toggle]');
    if (toggle) {
      const i = Number(toggle.dataset.stToggle);
      editingSubtasks[i].done = toggle.checked;
      renderSubtasks();
      return;
    }
    const remove = event.target.closest('[data-st-remove]');
    if (remove) {
      editingSubtasks.splice(Number(remove.dataset.stRemove), 1);
      renderSubtasks();
    }
  });

  $('add-toggle').addEventListener('click', () => openForm());
  $('cancel-btn').addEventListener('click', closeForm);
  $('task-form').addEventListener('submit', submitForm);
  $('delete-btn').addEventListener('click', deleteTask);

  initSwipe($('task-list'));

  document.body.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) { closeSwipedRow(); toggleTask(toggle.dataset.toggle); return; }

    const snooze = event.target.closest('[data-snooze]');
    if (snooze) {
      closeSwipedRow();
      snoozeTask(snooze.dataset.snooze, snooze.dataset.preset);
      return;
    }

    const later = event.target.closest('[data-later]');
    if (later) {
      const task = tasks.find((t) => t.id === later.dataset.later);
      closeSwipedRow();
      snoozeTask(later.dataset.later, task?.snoozed ? null : 'tomorrow');
      return;
    }

    // Editing is now a deliberate choice from the swipe menu, rather than
    // something that happens whenever you tap a task.
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      const task = tasks.find((t) => t.id === edit.dataset.edit);
      closeSwipedRow();
      if (task) { openForm(task); $('task-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }

    // Clicking anywhere else dismisses an open row.
    if (openRowEl && !event.target.closest('.task-row')) closeSwipedRow();
  });

  // Restore the folder this device was last looking at.
  document.querySelectorAll('.folder').forEach((button) => {
    const active = button.dataset.folder === folder;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));

    button.addEventListener('click', async () => {
      folder = button.dataset.folder;
      localStorage.setItem(FOLDER_KEY, folder);

      document.querySelectorAll('.folder').forEach((b) => {
        const on = b === button;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
      });

      // Re-fetch: the focus ranking is scoped server-side to the chosen folder.
      await refresh().catch((error) => toast(error.message));
    });
  });

  document.querySelectorAll('.range').forEach((button) => {
    if (Number(button.dataset.range) === upcomingDays) {
      document.querySelectorAll('.range').forEach((b) => b.classList.remove('is-active'));
      button.classList.add('is-active');
    }
    button.addEventListener('click', () => {
      upcomingDays = Number(button.dataset.range);
      localStorage.setItem('todo.upcomingDays', String(upcomingDays));
      document.querySelectorAll('.range').forEach((b) => b.classList.toggle('is-active', b === button));
      renderUpcoming();
    });
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      filter = tab.dataset.filter;
      renderList();
    });
  });

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', (event) => {
    if (event.target === $('settings')) $('settings').hidden = true;
  });

  $('plan-toggle').addEventListener('click', async () => {
    const panel = $('plan-panel');
    const opening = panel.hidden;
    panel.hidden = !opening;
    $('plan-toggle').setAttribute('aria-expanded', String(opening));
    $('plan-toggle').textContent = opening
      ? 'Hide the plan' : "Fit today's list into today's gaps";
    // Recomputed every time it opens: an hour of clinic later, the answer is
    // different, and a stale plan is worse than none.
    if (opening) await loadPlan();
  });

  $('shortcut-make').addEventListener('click', makeShortcutToken);
  $('feed-enable').addEventListener('click', () => newFeedLink(false));
  $('feed-new').addEventListener('click', () => newFeedLink(true));
  $('feed-off-btn').addEventListener('click', async () => {
    if (!confirm('Turn off the calendar link? Subscribed calendars will stop updating.')) return;
    renderFeed(await api('/feed', { method: 'DELETE' }));
    $('feed-status').textContent = 'Calendar link turned off.';
  });
  /**
   * Copy a field's value, saying so either way.
   *
   * Clipboard access is refused in plenty of contexts - an insecure origin, a
   * denied permission, an in-app browser - so the fallback selects the text
   * instead of reporting a dead end. On a phone that leaves it one tap from
   * the Copy item in the selection menu.
   */
  const copyField = async (fieldId, statusId) => {
    const value = $(fieldId).value;
    try {
      await navigator.clipboard.writeText(value);
      $(statusId).textContent = 'Copied.';
    } catch {
      $(fieldId).select();
      $(fieldId).setSelectionRange(0, value.length); // iOS ignores select() alone
      $(statusId).textContent = 'Selected — copy it from the menu.';
    }
  };

  $('feed-copy').addEventListener('click', () => copyField('feed-url', 'feed-status'));
  $('shortcut-copy').addEventListener('click', () => copyField('shortcut-token', 'shortcut-status'));

  buildEventDayOptions();
  syncEventKind();
  $('ev-day').addEventListener('change', syncEventKind);
  $('ev-add').addEventListener('click', addEvent);
  $('ev-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addEvent(); }
  });
  $('event-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ev-remove]');
    if (!button) return;
    // Deleting a task asks first; deleting a commitment did not, even though a
    // weekly one takes more setting up and there is no undo for either.
    const name = button.closest('.event-row')?.querySelector('div > div')?.textContent?.trim();
    if (!confirm(`Remove ${name ? `"${name}"` : 'this'} from your calendar?`)) return;
    await api(`/events/${button.dataset.evRemove}`, { method: 'DELETE' });
    await loadEvents();
    await refresh();
  });

  $('workout-done').addEventListener('click', () => logWorkout('done'));
  $('workout-skip').addEventListener('click', () => logWorkout('skipped'));

  $('enable-notif').addEventListener('click', enableNotifications);
  $('save-settings').addEventListener('click', saveSettings);

  $('sched-sync').addEventListener('click', async () => {
    $('sched-sync').disabled = true;
    $('sched-status').textContent = 'Syncing…';
    try {
      const r = await api('/schedule/sync', { method: 'POST' });
      toast(r.ok ? `Synced ${r.stored} assignments` : r.reason);
    } catch (error) {
      toast(error.message);
    } finally {
      await loadSchedule().catch(() => {});
      await refresh().catch(() => {});
    }
  });

  $('map-add').addEventListener('click', async () => {
    const pattern = $('map-pattern').value.trim();
    const minutes = Number($('map-minutes').value);
    if (!pattern || !Number.isFinite(minutes)) { toast('Need a name and a number of minutes'); return; }
    try {
      await api('/schedule/mappings', { method: 'PUT', body: JSON.stringify({ pattern, minutes }) });
      $('map-pattern').value = ''; $('map-minutes').value = '';
      await loadSchedule();
      await refresh();
      toast('Saved');
    } catch (error) { toast(error.message); }
  });

  $('map-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-map-remove]');
    if (!button) return;
    await api('/schedule/mappings', {
      method: 'DELETE',
      body: JSON.stringify({ pattern: button.dataset.mapRemove }),
    });
    await loadSchedule();
    await refresh();
  });

  $('backup-now').addEventListener('click', async () => {
    const button = $('backup-now');
    button.disabled = true;
    $('backup-status').textContent = 'Uploading...';
    try {
      const result = await api('/backup', { method: 'POST' });
      $('backup-status').textContent = result.ok
        ? `Saved ${result.file} to Drive, keeping ${result.kept}.`
        : `Failed: ${result.reason}`;
    } catch (error) {
      $('backup-status').textContent = `Failed: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  // Restore runs in two passes: inspect, show the user what is in the file,
  // then replace only after they confirm the summary they just read.
  let pendingRestore = null;

  $('restore-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    pendingRestore = null;
    $('restore-confirm').hidden = true;
    if (!file) { $('restore-status').textContent = ''; return; }

    $('restore-status').textContent = 'Reading...';
    try {
      const raw = await file.text();

      // An encrypted backup is base64 armour around a binary container whose
      // first eight bytes are the magic. Detect it here so the user gets a
      // clear message rather than a JSON parse error on a wall of base64.
      //
      // Matched by prefix rather than by exact version. This read TODOBK01
      // while the writer had moved to TODOBK02, so the magic check could never
      // fire and only the filename fallback was doing any work - which would
      // have failed the moment a file was renamed. Any TODOBK<nn> is an
      // encrypted backup as far as detection goes; the server checks the exact
      // version and reports a mismatch properly.
      let sealed = file.name.endsWith('.enc');
      try {
        sealed = /^TODOBK\d{2}/.test(atob(raw.slice(0, 24).replace(/\s+/g, '')).slice(0, 8))
          || sealed;
      } catch {
        // Not base64 at all, so it is not an encrypted backup. atob throws on
        // a plain JSON file, which used to take the whole handler with it.
      }

      const result = await api('/import', {
        method: 'POST',
        body: JSON.stringify(sealed
          ? { encrypted: raw }
          : { backup: JSON.parse(raw) }),
      });

      const s = result.summary;
      const when = s.exportedAt ? s.exportedAt.slice(0, 10) : 'an unknown date';
      const parts = Object.entries(result.restored)
        .filter(([, n]) => n > 0)
        .map(([table, n]) => `${n} ${table}`);
      $('restore-status').textContent =
        `${sealed ? 'Decrypted. ' : ''}From ${when}: ${parts.join(', ')}. `
        + `${s.openTasks} tasks still open.`;
      pendingRestore = sealed ? { encrypted: raw } : { backup: JSON.parse(raw) };
      $('restore-confirm').hidden = false;
    } catch (error) {
      $('restore-status').textContent = `Cannot use that file: ${error.message}`;
    }
  });

  $('restore-confirm').addEventListener('click', async () => {
    if (!pendingRestore) return;
    if (!confirm('Replace everything in the app with this backup? This cannot be undone from here.')) return;

    const button = $('restore-confirm');
    button.disabled = true;
    $('restore-status').textContent = 'Restoring...';
    try {
      const result = await api('/import', {
        method: 'POST',
        body: JSON.stringify({ ...pendingRestore, confirm: true }),
      });
      const undo = result.snapshot ? ` Previous state saved as ${result.snapshot}.` : '';
      $('restore-status').textContent = `Restored.${undo} Reloading...`;
      setTimeout(() => location.reload(), 1500);
    } catch (error) {
      $('restore-status').textContent = `Restore failed: ${error.message}`;
      button.disabled = false;
    }
  });

  for (const id of ['work', 'personal', 'fitness']) {
    $(`s-folder-${id}`).addEventListener('input', checkFolderWidth);
  }

  // --- camera capture -------------------------------------------------------

  /**
   * Shrink before uploading. A modern phone photo is 4 MB and about 4000px
   * wide; the reader gains nothing above ~1568px, and the smaller payload is
   * the difference between a two-second round trip and a twenty-second one on
   * hospital wifi.
   */
  async function shrinkImage(file, maxEdge = 1568) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { base64: btoa(binary), mediaType: 'image/jpeg', bytes: bytes.length };
  }

  let pendingReading = null;

  function showCameraResult(message, { warn = false, fields = false } = {}) {
    $('camera-result').hidden = false;
    $('camera-result').classList.toggle('is-warn', warn);
    $('camera-status').textContent = message;
    $('camera-fields').hidden = !fields;
  }

  $('camera-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    pendingReading = null;
    showCameraResult('Reading the photo...');

    try {
      const { base64, mediaType } = await shrinkImage(file);
      const result = await api('/vision', {
        method: 'POST',
        body: JSON.stringify({ image: base64, mediaType }),
      });

      if (!result.ok) {
        showCameraResult(result.error, { warn: true });
        return;
      }

      const r = result.reading;
      pendingReading = r;

      // The reader already decides between an event and a task - a poster for
      // Grand Rounds is not something you tick off. That answer used to be
      // discarded, and everything became a task.
      $('cam-is-event').checked = r.kind === 'event';
      $('cam-title').value = r.title;
      $('cam-date').value = r.date || '';
      $('cam-start').value = r.time || '';
      $('cam-end').value = r.endTime || '';
      $('cam-notes').value = [r.location, r.notes].filter(Boolean).join(' - ');
      $('cam-category').value = folder === 'all' ? 'work' : folder;
      syncCameraKind();

      const kindWord = r.kind === 'event' ? 'Event' : 'Task';
      const when = r.date ? `${r.date}${r.time ? ` at ${r.time}` : ''}` : 'no date found';
      const unsure = r.confidence === 'low'
        ? ' The photo was hard to read, so check this carefully.'
        : '';
      showCameraResult(`${kindWord}: ${r.title} - ${when}.${unsure}`,
        { warn: r.confidence === 'low', fields: true });
    } catch (error) {
      showCameraResult(`Could not read that photo: ${error.message}`, { warn: true });
    }
  });

  // Both kinds can carry a start time; only an event has an end. A task with
  // an end time would be an event, and events already exist.
  function syncCameraKind() {
    const isEvent = $('cam-is-event').checked;
    $('cam-end').closest('.field').hidden = !isEvent;
    $('cam-category').closest('.field').hidden = isEvent;
  }

  $('cam-is-event').addEventListener('change', syncCameraKind);

  $('cam-cancel').addEventListener('click', () => {
    pendingReading = null;
    $('camera-result').hidden = true;
    $('camera-fields').hidden = true;
  });

  $('cam-save').addEventListener('click', async () => {
    const title = $('cam-title').value.trim();
    if (!title) { showCameraResult('Give it a title first.', { warn: true, fields: true }); return; }

    const button = $('cam-save');
    button.disabled = true;
    const asEvent = $('cam-is-event').checked;
    try {
      // Created through the ordinary endpoints, so a photographed entry gets
      // exactly the same validation as a typed one.
      if (asEvent) {
        await api('/events', {
          method: 'POST',
          body: JSON.stringify({
            title,
            date: $('cam-date').value || config.today,
            start_time: $('cam-start').value || null,
            end_time: $('cam-end').value || null,
            notes: $('cam-notes').value.trim(),
          }),
        });
      } else {
        await api('/tasks', {
          method: 'POST',
          body: JSON.stringify({
            title,
            notes: $('cam-notes').value.trim(),
            category: $('cam-category').value,
            deadline: $('cam-date').value || null,
            start_time: $('cam-start').value || null,
            priority: 2,
          }),
        });
      }
      pendingReading = null;
      $('camera-result').hidden = true;
      $('camera-fields').hidden = true;
      toast(asEvent ? 'Event added from photo' : 'Added from photo');
      await refresh();
    } catch (error) {
      showCameraResult(error.message, { warn: true, fields: true });
    } finally {
      button.disabled = false;
    }
  });

  $('demo-reset').addEventListener('click', async () => {
    const button = $('demo-reset');
    button.disabled = true;
    button.textContent = 'Resetting...';
    try {
      const result = await api('/demo/reset', { method: 'POST' });
      // The reset invalidated this device's session on purpose; the response
      // carries its replacement, so the reload lands back inside the app.
      if (result?.token) {
        token = result.token;
        localStorage.setItem(TOKEN_KEY, token);
      }
      location.reload();
    } catch {
      button.textContent = 'Reset failed';
      button.disabled = false;
    }
  });

  const downloadFrom = async (path, filename) => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Export failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  $('export-csv').addEventListener('click', async () => {
    try { await downloadFrom('/api/export/tasks?format=csv', `tasks-${config.today}.csv`); }
    catch (error) { toast(error.message); }
  });

  $('export-md').addEventListener('click', async () => {
    try { await downloadFrom('/api/export/tasks?format=markdown', `tasks-${config.today}.md`); }
    catch (error) { toast(error.message); }
  });

  // Two steps, same as restore: show what was understood, then write.
  let pendingImport = null;

  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    pendingImport = null;
    $('import-confirm').hidden = true;
    if (!file) { $('import-status').textContent = ''; return; }

    $('import-status').textContent = 'Reading...';
    try {
      const csv = await file.text();
      const result = await api('/import/tasks', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      });

      const names = result.sample.map((t) => t.title).join(', ');
      const skipped = result.skipped.length
        ? ` ${result.skipped.length} line(s) skipped (no title).`
        : '';
      const kind = result.format === 'ics'
        ? `calendar (${result.icsKind === 'VTODO' ? 'to-dos' : 'events'})`
        : ({ csv: 'CSV', markdown: 'Markdown', json: 'JSON' }[result.format] || result.format);
      $('import-status').textContent =
        `Read as ${kind}: ${result.count} task(s) - e.g. ${names}.${skipped}`;
      pendingImport = csv;
      $('import-confirm').hidden = false;
      $('import-confirm').textContent = `Add ${result.count} task(s)`;
    } catch (error) {
      $('import-status').textContent = error.message;
    }
  });

  $('import-confirm').addEventListener('click', async () => {
    if (!pendingImport) return;
    const button = $('import-confirm');
    button.disabled = true;
    try {
      const result = await api('/import/tasks', {
        method: 'POST',
        body: JSON.stringify({ csv: pendingImport, confirm: true }),
      });
      $('import-status').textContent = `Added ${result.added} task(s).`;
      $('import-file').value = '';
      button.hidden = true;
      pendingImport = null;
      await refresh();
    } catch (error) {
      $('import-status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('export-now').addEventListener('click', async () => {
    $('export-now').disabled = true;
    try {
      // Fetched with the session token rather than a plain link, so the file
      // cannot be pulled by anyone who merely knows the URL.
      const response = await fetch('/api/export', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `todo-backup-${config.today}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Backup downloaded');
    } catch (error) {
      toast(error.message);
    } finally {
      $('export-now').disabled = false;
    }
  });

  $('archive-now').addEventListener('click', async () => {
    const days = Number($('s-archive').value) || 90;
    if (!confirm(`Permanently delete completed tasks older than ${days} days? This cannot be undone.`)) return;
    try {
      const r = await api('/archive', { method: 'POST', body: JSON.stringify({ days }) });
      toast(r.removed ? `Cleared ${r.removed} old task${r.removed === 1 ? '' : 's'}` : 'Nothing to clear');
      await loadArchiveStatus();
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  });

  $('test-push').addEventListener('click', async () => {
    $('test-push').disabled = true;
    $('test-result').textContent = 'Sending…';
    try {
      const result = await api('/test-push', { method: 'POST' });
      $('test-result').textContent = result.sent
        ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.`
        : (result.note || 'No devices received it.');
    } catch (error) {
      $('test-result').textContent = error.message;
    } finally {
      $('test-push').disabled = false;
    }
  });

  $('device-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    await api('/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ id: button.dataset.remove }),
    });
    await loadDevices();
    await updateNotificationUI();
  });

  $('sign-out').addEventListener('click', async () => {
    // Revoke the session server-side, not just locally, so the token cannot be
    // replayed from a copy of this device's storage.
    try {
      await api('/sessions', { method: 'DELETE', body: JSON.stringify({ self: true }) });
    } catch { /* signing out locally still matters if the request fails */ }
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    lock();
  });

  $('sign-out-others').addEventListener('click', async () => {
    if (!confirm('Sign out every other device? They will each need the passphrase again.')) return;
    try {
      await api('/sessions', { method: 'DELETE', body: JSON.stringify({ others: true }) });
      toast('Other devices signed out');
      await loadSessions();
    } catch (error) {
      toast(error.message);
    }
  });

  $('session-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke]');
    if (!button) return;
    await api('/sessions', {
      method: 'DELETE',
      body: JSON.stringify({ id: button.dataset.revoke }),
    });
    await loadSessions();
  });

  // Refresh when the app comes back to the foreground so all three devices
  // converge without a manual reload.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && token && !$('app').hidden) refresh().catch(() => {});
  });

  if (token) {
    try {
      await start();
    } catch (error) {
      // Same trap on reload: a stored passphrase plus a broken backend used to
      // land on a blank lock screen with no explanation.
      lock();
      showLockError(error);
    }
  } else {
    lock();
  }
});
