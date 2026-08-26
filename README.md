# To Do

A personal task app that sends you **one notification each morning** telling you
what to work on — weighed against how much of your day is already committed.

Built for one person per deployment. There is no sign-up, no multi-user
support, and no server you depend on but do not control. You deploy your own
copy to your own Cloudflare account, and your data lives in your database.

## What it does

- **One ranked list.** Deadlines dominate; priority is a tiebreak. Overdue items
  stop escalating after two weeks so they cannot bury everything else.
- **A 6am push notification** on every device you sign in on — a short brief
  naming what to start with, not a badge count.
- **Reads your calendar feed.** Point it at an iCalendar URL (a work rota, an
  on-call schedule, anything that publishes `.ics`) and it subtracts committed
  hours from the day, so the workload total is honest.
- **Finds the real gap.** Assignments split across a day leave usable windows in
  between; it merges the busy intervals and reports the longest clear stretch.
- **Three folders, named by you.** Work / Personal / Fitness by default. Rename
  them to anything — Family, Research, Home.
- **Recurring tasks, snooze, subtasks, search**, natural-language quick add, a
  weekly workout plan with streaks, and tasks that stay hidden until the day
  they are actually actionable.
- **Photograph a flyer.** Point the camera at a conference poster or a printed
  schedule; Claude reads the date out of it and proposes a task. Nothing is
  created until you confirm what it read.
- **Import and export that other software understands** - CSV, Markdown
  checklists, JSON, and iCalendar. Coming from another app, or leaving for one,
  should not mean retyping anything.
- **Publishes a calendar feed of its own.** One read-only `.ics` URL your phone,
  Mac or watch can subscribe to, carrying the rota, standing commitments,
  one-off dates and anything pinned to an hour. Off until you turn it on.
- **Add things by voice.** A Siri Shortcut posts a dictated line to the same
  parser typing uses, and reads back what it understood.
- **Fits the list into the day.** Takes the gaps your commitments leave and lays
  the ranked list into them using each task's estimate, naming whatever does not
  fit rather than quietly dropping it.
- **An evening nudge** with what is still owed and what tomorrow holds, since the
  evening is the last point you can do anything about tomorrow.
- **Weekly backups to your own Google Drive**, encrypted before they leave, with
  a restore path that has been tested rather than assumed.

Installs as a progressive web app on iPhone, iPad, and Mac.

## What it is built on

One Cloudflare Worker, one D1 (SQLite) database, and a frontend of plain HTML,
CSS, and JavaScript. **No framework, no build step, and no runtime dependencies
at all** — the Web Push encryption (RFC 8291) and VAPID signing (RFC 8292) are
implemented directly against the Web Crypto API. `wrangler` is the only dev
dependency.

Everything fits comfortably in Cloudflare's free tier.

## Setup

You need a [Cloudflare account](https://dash.cloudflare.com/sign-up) (free) and
Node 18 or newer.

```bash
git clone https://github.com/YOUR-USERNAME/todo-app.git
cd todo-app
npm install
./setup.sh
```

`setup.sh` walks through the rest: it logs you into Cloudflare, creates the D1
database and writes its id into `wrangler.toml`, applies the schema and
migrations, generates your VAPID keypair, asks for a passphrase, and deploys.

Then open the URL it prints, enter your passphrase, and allow notifications.

### On iPhone

Safari → Share → **Add to Home Screen**. Notifications only work from the
installed app, not from a Safari tab — this is an iOS restriction, not a bug.

### Changing your passphrase

```bash
./set-passphrase.sh
```

## Optional extras

**A calendar feed.** Settings → Clinical schedule. Paste any iCalendar
subscription URL. Then map each recurring assignment to the hours it really
occupies, because published windows are usually wider than the actual day.
Assignments sharing a *concurrency group* are covered at the same time and count
once; different groups add.

**Backups to Google Drive.** See [SETUP-DRIVE.md](SETUP-DRIVE.md). Roughly ten
minutes of clicking in the Google Cloud console, once. It uses the `drive.file`
scope, which lets the app see only files it created itself — it cannot read the
rest of your Drive.

**A public demo.** Copy `wrangler.demo.example.toml` to `wrangler.demo.toml`,
create a second database, and deploy it separately. It seeds itself with sample
data and resets every six hours. Give it its own passphrase and its own VAPID
keys — the demo's passphrase is public by design. The lock screen prefills the
passphrase when the hostname begins with `demo.`.

## Getting your tasks in and out

Settings -> Import and export. Deliberately separate from backup and restore:
**importing adds tasks, it never replaces what you have.**

Export as **CSV** (opens in any spreadsheet) or as a **Markdown checklist**
(paste into notes, an email, or an issue).

Import accepts:

| Format | Notes |
|---|---|
| CSV | comma, semicolon, tab or pipe separated - the delimiter is detected |
| Markdown | `## Heading` becomes a folder, `- [ ]` a task, an indented `- [ ]` a subtask |
| JSON | a bare array, `{"tasks": [...]}`, or one of this app's own backups |
| iCalendar | `.ics` - `VTODO` items preferred, falling back to events |
| Plain text | one task per line, no header needed |

Columns are matched by name against a table of aliases, so exports from most
task apps work unchanged - Todoist's `CONTENT`/`DESCRIPTION`/`PRIORITY`/`DATE`,
for instance. Folder names are matched against whatever you have renamed yours
to.

`.ics` matters more than it looks: `VTODO` is iCalendar's own to-do component
and is what Apple Reminders, Thunderbird, and CalDAV clients export, which makes
it the nearest thing to a standard interchange format for tasks. Note that RFC
5545 priority runs 1 (highest) to 9 (lowest) - the opposite direction from most
apps' UI.

**A file it cannot read is refused**, with a message saying what is supported.
An earlier version guessed, and turned a Markdown heading into a task called
`## Work`; silently inventing tasks is a worse failure than saying no.

## Typing things in

The quick-add box takes a whole line and pulls the structure out of it. A
**task** is something you finish; an **event** is something that happens whether
or not you act. **A time range makes an event; a single time makes a task**,
because "call the lab at 3pm" is a thing to do, not an appointment:

```
Dinner sep 12 7pm-9:30pm        -> event, once, on 12 September
Teleclinic thursday 2pm-3pm     -> event, once, this Thursday
Clinic every tuesday 8am-12pm   -> event, every Tuesday
Call the lab friday 3pm         -> task, due Friday, at 3pm
Grand rounds every thursday 8am -> task, repeating weekly, at 8am
```

A pill beside the box shows which it decided on, and clicking it switches — so
the range rule is a default, not a trap. It also reads `#work` for the folder,
`p1`/`!!` for priority, `30m` for an estimate, and dates as `tomorrow`,
`next week`, `sep 12`, or a weekday. **`next thursday` means the Thursday of
next week**, not the one in two days; a bare `thursday` or `this thursday` means
the next one coming up.

An event with a date happens once and clears itself the day after it passes; an
event without one repeats weekly and stays until you remove it.

## The calendar feed

**Settings -> Subscribe from your calendar -> Create a calendar link.** Paste the
URL into any calendar app that takes a subscription.

**The link is the password.** There is no sign-in on it — that is what makes it
subscribable — so anyone holding it can read the calendar, and it will sit in
your calendar provider's servers for as long as the subscription does. It is off
by default, never travels in a backup, and **Regenerate** revokes the old link
immediately.

Three details that are easy to get wrong and are worth knowing:

- Recurring commitments are **expanded into individual dated entries**, not
  published as an `RRULE`. A recurrence anchored to a UTC instant drifts by an
  hour across a daylight-saving boundary; expanding sidesteps it.
- Rostered work uses **your assignment mapping rather than the feed's own
  window** — many rotas pad an assignment to a generic coverage block, and a
  calendar showing that is worse than no calendar.
- Tasks and zero-minute cover are published as **free**, not busy, so other
  people's scheduling tools do not treat your whole week as blocked.
- **Titles and times only.** Notes are never published. The feed leaves the
  building, and the warning shown when you create a link talks about titles, so
  titles are all it carries.

## Adding things by voice

**Settings -> Add by voice -> Create a token**, then build a Shortcut of three
actions: **Dictate Text**, **Get Contents of URL** POSTing `{"text": "..."}` to
`/api/quick?format=text`, and **Show Notification**.

`?format=text` answers with a bare sentence — *"Task: Call the lab — Fri 28 Aug,
3pm, Work"* — rather than JSON, so the Shortcut can put it straight into a
notification. That receipt exists because dictation is the one input with no
preview: it is where you catch a misheard word or a date a week out.

The folder can be spoken. A dictated `#` arrives as the literal word "hashtag",
so say `...for work` or `...hashtag work` at the end instead. It only counts as
the last thing said, so "sign the form for personal reasons" keeps its words.

The token is an ordinary session: it appears under signed-in devices, is revoked
with the same button as a phone, and its expiry slides forward each time it is
used.

## Fitting the list into the day

**Fit today's list into today's gaps**, under the workload line. It takes what
your commitments leave free and lays the ranked list into it using each task's
estimate.

- A task with a **time of day keeps that hour** — it is laid down first and
  everything else works around it. If that hour is already committed, the block
  is marked as clashing rather than quietly moved.
- Nothing is scheduled into time that has already passed.
- **What does not fit is named.** A planner that shows four things and silently
  omits six is telling you the day is fine when it is not.

Nothing is saved. The plan is recomputed every time you open it, so there is
never a stale schedule to reconcile — a plan that persists becomes a second list
to maintain.

## Deploying a change

```bash
npm run deploy
```

Not `wrangler deploy` directly. The npm script bumps the service worker cache
name first, and without that browsers keep serving the previously cached shell -
your change goes live on the server and nobody sees it. This is written down
because it happened: a hand-written `sed` bump silently matched nothing and a
dozen deploys shipped assets that no browser ever loaded.

## Camera capture (optional)

Settings aside, this one needs an [Anthropic API key](https://console.anthropic.com/settings/keys):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

The button stays hidden until that secret exists, so the feature is inert on an
install that has not configured it.

A photo is shrunk to 1568px in the browser, read once, and **discarded** - it is
never written to the database and so never reaches a backup. The reading is
shown to you with editable fields; a task is only created when you confirm it,
through the ordinary create endpoint with the ordinary validation.

**It costs real money.** Roughly 2-4c per photo on `claude-opus-5`, or about
0.5c on `claude-haiku-4-5` (`npx wrangler secret put VISION_MODEL`). A hard
daily ceiling is enforced server-side before the API is ever called -
`VISION_DAILY_LIMIT`, default 50, and 25 in demo mode. **If you put this on a
public demo, the ceiling is the only thing between a stranger with a script and
your card.**

### A word to clinical users

The extraction schema includes a `contains_personal_data` flag, instructed to
err towards true. If the reader believes the image shows any identifiable
person's details, the request is refused outright - no task, image discarded -
rather than offered for filing.

That is a safety net, not a permission slip. **Do not point this at anything on
a ward.** A census whiteboard behind a flyer, a chart number in the corner of a
printout, initials on a schedule - a camera makes accidental capture far easier
than typing does, and the image leaves your Worker to be read.

## Tests

```bash
npm test
```

Around 840 checks covering the push encryption against an independent
decryption, ranking, recurrence, the iCalendar parser, free-window maths, auth
and lockout, the restore path against a real SQLite database, backup encryption
including tamper detection, every import format including the ones that used to
produce silent garbage, the camera reader against a stubbed API, and a set of frontend structure assertions that
exist because each one caught a real bug once.

No network access, no fixtures to maintain. Run it before every deploy.

## A word on privacy

The server has to read your task titles to compose the morning digest, so
end-to-end encryption of the live data is not possible by design. Backups are a
different matter and *are* encrypted - see above. **Do not put anything
confidential in a task title** — for clinical users, that means no patient
identifiers.

Backups deliberately exclude push subscriptions, sign-in sessions, and the
calendar feed token. Those are credentials, they are recreated in a click, and
cloud storage is the wrong place for any of them. The feed token is also refused
on the way back in, so restoring an older backup cannot quietly revive a link you
had regenerated to revoke.

The calendar feed is the one thing that deliberately leaves, and only if you turn
it on. It is a read-only URL with no sign-in, which is what lets a calendar app
subscribe — and why the link is the password.

## Licence

MIT. See [LICENSE](LICENSE).
