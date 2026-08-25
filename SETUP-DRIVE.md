# Automatic backups to Google Drive

The app uploads a backup to Drive every Sunday morning and keeps the last
twelve. Setting it up is a one-time trip through the Google Cloud console.

It uses the `drive.file` scope, which means the app can only see files it
created itself. It cannot read the rest of your Drive, and neither can anyone
who gets hold of the token.

**This is the sequence that actually works**, which is not the sequence Google's
own documentation implies. Two steps below are missing from the official flow
and each one blocks publishing with an error that points at the wrong page.

## 1. Make a project

https://console.cloud.google.com/projectcreate — name it `todo-backup`, create.

Then check the project picker at the top left says `todo-backup`. Every later
step applies to whatever is selected there.

## 2. Turn on the Drive API

https://console.cloud.google.com/apis/library/drive.googleapis.com — **Enable**.

The button changes to **Manage** when it has worked.

## 3. Create the consent screen

Left nav -> **OAuth consent screen** -> **Get started**.

- App name `todo-backup`, support email your own
- Audience **External** (Internal is not offered on a personal account)
- Contact email your own
- Agree, create

## 4. Publish the app

This is the step that matters. In "Testing", Google expires the refresh token
after **seven days** and backups stop with no warning anywhere. Publishing an
app that only you will ever use requires no review, because `drive.file` is not
a sensitive scope.

Publishing is gated on three things, and the console's error message
("Your app's OAuth configuration is incomplete... visit the Branding page")
names none of them:

**4a. Declare the scope.** Left nav -> **Data Access** -> **Add or remove
scopes**. At the bottom of the panel, under **Manually add scopes**, paste:

```
https://www.googleapis.com/auth/drive.file
```

**Add to table** -> **Update** -> **Save**. It should land under *non-sensitive*
scopes. An app with zero declared scopes counts as incomplete.

**4b. Fill in the branding URLs.** Left nav -> **Branding** -> **App domain**.
All three are required for an External app in production:

| Field | Value |
|---|---|
| Application home page | `https://todo.example.com/about` |
| Application privacy policy link | `https://todo.example.com/privacy` |
| Application terms of service link | `https://todo.example.com/terms` |

Those pages are served by this Worker from `public/about.html`,
`public/privacy.html`, and `public/terms.html`. They must stay publicly
reachable without a sign-in.

**Leave App logo empty.** Uploading one forces a brand-verification review,
and nothing here needs it.

**4c. Add the authorized domain.** Same page, **Authorized domains** ->
**Add domain** -> `example.com`. Bare registrable domain: no `https://`,
no `todo.` prefix. Any domain used on the consent screen has to be pre-declared
here, so 4b cannot be saved without it.

**Save**, then **Audience** -> **Publish app** -> **Confirm**.

Status should read **In production**. The confirmation dialog says verification
is needed only for more than 10 domains, a logo, or sensitive scopes — we have
one domain, no logo, and a non-sensitive scope.

## 5. Create the credentials

Left nav -> **Clients** -> **Create client**.

- Application type **Desktop app** (this is what permits the `localhost`
  redirect the setup script listens on; Web application would need a
  registered redirect URI)
- Name `todo-cli`

Copy the **Client ID** and **Client secret** from the dialog.

## 6. Connect it

From this folder:

```bash
node scripts/google-auth.mjs
```

Paste the two values when asked. Your browser opens; choose your account and
allow it. Google warns that the app is unverified — that is your own project.
**Advanced** -> **Go to todo-backup**.

The script trades the code for a refresh token and pipes all three values into
`wrangler secret put` on stdin. Nothing is written to a file and nothing appears
in your shell history.

## 7. Deploy and check

```bash
npx wrangler deploy
```

Open the app, settings -> Housekeeping -> **Back up to Drive now**. A folder
called **To Do App Backups** appears in your Drive with one JSON file in it.

## What gets backed up

Tasks, events, workout plan and log, clinical schedule, service-hours mappings,
and settings. Deliberately excluded: push subscriptions and sign-in sessions —
device credentials, recreated by signing in again, and a bad thing to leave
sitting in cloud storage.

## If it stops working

Settings shows the result of the last run. `Google refused the refresh token`
means it was revoked — most often because the app went back to "Testing", or
the Google password changed. Re-run `node scripts/google-auth.mjs`.
