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
- **Weekly backups to your own Google Drive**, and a restore path that has been
  tested rather than assumed.

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

## Tests

```bash
npm test
```

Around 420 checks covering the push encryption against an independent
decryption, ranking, recurrence, the iCalendar parser, free-window maths, auth
and lockout, the restore path against a real SQLite database, and a set of
frontend structure assertions that exist because each one caught a real bug once.

No network access, no fixtures to maintain. Run it before every deploy.

## A word on privacy

The server has to read your task titles to compose the morning digest, so
end-to-end encryption is not possible by design. **Do not put anything
confidential in a task title** — for clinical users, that means no patient
identifiers.

Backups deliberately exclude push subscriptions and sign-in sessions. Those are
device credentials, they are recreated by signing in again, and cloud storage is
the wrong place for them.

## Licence

MIT. See [LICENSE](LICENSE).
