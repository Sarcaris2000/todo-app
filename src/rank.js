// Decides what "you should work on this today" actually means.
//
// The score is deliberately deadline-dominant: an overdue task always outranks
// a high-priority task with lots of runway, because that is how the day usually
// actually goes. Priority breaks ties and controls what surfaces when nothing
// is urgent.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `fromISO` to `toISO`, both YYYY-MM-DD. Negative = overdue. */
export function daysUntil(fromISO, toISO) {
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  const to = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

export function scoreTask(task, todayISO) {
  let score = 0;

  // Priority: high 60, normal 40, low 20.
  const priority = Number(task.priority) || 2;
  score += (4 - Math.min(3, Math.max(1, priority))) * 20;

  const days = task.deadline ? daysUntil(todayISO, task.deadline) : null;
  if (days === null) {
    // No deadline: keep it visible but below anything genuinely time-bound.
    score += 8;
  } else if (days < 0) {
    // Overdue, and more overdue is worse - capped so a forgotten task from
    // last year cannot permanently own the top slot.
    score += 120 + Math.min(-days, 14) * 6;
  } else if (days === 0) {
    score += 100;
  } else if (days === 1) {
    score += 76;
  } else if (days <= 3) {
    score += 58 - (days - 2) * 9;
  } else if (days <= 7) {
    score += 34 - (days - 4) * 5;
  } else if (days <= 14) {
    score += 15;
  } else {
    score += 6;
  }

  // Nudge quick wins up slightly - useful for filling the edges of a day.
  const estimate = Number(task.estimate_minutes);
  if (estimate && estimate <= 30) score += 7;
  // And nudge very large tasks up a little too, so they get started early
  // rather than colliding with their own deadline.
  if (estimate && estimate >= 240 && days !== null && days <= 7) score += 10;

  // Age tiebreaker: something sitting untouched for weeks deserves a look.
  if (task.created_at) {
    const ageDays = Math.floor((Date.now() - Date.parse(task.created_at)) / DAY_MS);
    if (Number.isFinite(ageDays) && ageDays > 0) score += Math.min(ageDays, 21) * 0.4;
  }

  return score;
}

/** Human label for a deadline, relative to today. */
export function deadlineLabel(deadline, todayISO) {
  if (!deadline) return null;
  const days = daysUntil(todayISO, deadline);
  if (days === null) return null;
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'due yesterday';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days <= 6) return `due in ${days} days`;
  if (days <= 13) return 'due next week';
  return `due ${deadline}`;
}

/** Open tasks, most-worth-doing first. */
export function rankTasks(tasks, todayISO) {
  return tasks
    .filter((t) => t.status === 'open')
    .map((t) => ({
      ...t,
      score: scoreTask(t, todayISO),
      due_label: deadlineLabel(t.deadline, todayISO),
      overdue: t.deadline ? daysUntil(todayISO, t.deadline) < 0 : false,
    }))
    .sort((a, b) => b.score - a.score || String(a.created_at).localeCompare(String(b.created_at)));
}

/**
 * Turn the ranked list into the text of the 6am notification.
 * Kept short - lock screens truncate hard, especially on iPhone.
 */
/**
 * What each folder is called. Overridable per install - one person's third
 * folder is Fitness, another's is Family - so nothing downstream may assume
 * these strings.
 */
export const DEFAULT_FOLDER_LABELS = { work: 'Work', personal: 'Personal', fitness: 'Fitness' };

export function buildDigest(tasks, todayISO, labels = DEFAULT_FOLDER_LABELS) {
  const ranked = rankTasks(tasks, todayISO);
  if (ranked.length === 0) {
    return {
      title: 'Nothing on the list',
      body: 'No open tasks today. Add something when you think of it.',
      count: 0,
    };
  }

  const top = ranked.slice(0, 3);
  const overdueCount = ranked.filter((t) => t.overdue).length;

  const title = overdueCount > 0
    ? `Today's focus - ${overdueCount} overdue`
    : `Today's focus - ${ranked.length} open`;

  // Only label the folder when both are actually in play. If everything open
  // is work, prefixing every line with "Work" is just noise on a lock screen.
  const folders = new Set(ranked.map((t) => t.category || 'personal'));
  const showFolder = folders.size > 1;

  const lines = top.map((t, i) => {
    const due = t.due_label ? ` (${t.due_label})` : '';
    // Was a two-way test that labelled every fitness task "Personal". With
    // renameable folders that would be wrong twice over.
    const category = t.category || 'personal';
    const folder = showFolder
      ? `${labels[category] || DEFAULT_FOLDER_LABELS[category] || category} · `
      : '';
    return `${i + 1}. ${folder}${t.title}${due}`;
  });

  if (ranked.length > top.length) {
    lines.push(`+${ranked.length - top.length} more`);
  }

  return { title, body: lines.join('\n'), count: ranked.length, top };
}
