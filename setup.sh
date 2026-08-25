#!/usr/bin/env bash
#
# One-time setup: creates the Cloudflare database, generates push keys,
# sets secrets, and deploys. Safe to re-run - it will not rotate keys that
# already exist (doing so would silently break every subscribed device).

set -euo pipefail

cd "$(dirname "$0")"

# Node was installed to ~/.local/node rather than system-wide.
export PATH="$HOME/.local/node/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not on PATH. Expected it at ~/.local/node/bin/node"
  exit 1
fi

WRANGLER="npx --yes wrangler"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

# GNU sed and BSD (macOS) sed disagree about in-place editing. Detect which.
sed_inplace() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

# ---------------------------------------------------------------------------
step "Checking your Cloudflare login"

if ! $WRANGLER whoami 2>&1 | grep -q "Account Name\|Account ID"; then
  info "Not logged in to Cloudflare. A browser window will open."
  info "Approve the request, then come back here."
  $WRANGLER login || true
fi

# Check again, and stop here if it did not take. Continuing without a login
# produces a confusing cascade of failures several steps later.
if ! $WRANGLER whoami 2>&1 | grep -q "Account Name\|Account ID"; then
  cat <<'EOF'

    Still not logged in to Cloudflare, so setup cannot continue.

    If you do not have a Cloudflare account yet, create a free one at
    https://dash.cloudflare.com/sign-up and then run:

        npx wrangler login

    That opens a browser to authorise this machine. Once it succeeds,
    run ./setup.sh again.

EOF
  exit 1
fi
$WRANGLER whoami 2>&1 | grep -E "Account Name|Account ID" | sed 's/^/    /'

# ---------------------------------------------------------------------------
step "Setting up the database"

UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
DB_ID="$(grep -Eo "$UUID_RE" wrangler.toml | head -1 || true)"

if [ -n "$DB_ID" ]; then
  info "wrangler.toml already points at database $DB_ID"
else
  CREATE_OUT="$($WRANGLER d1 create todo 2>&1 || true)"
  DB_ID="$(printf '%s' "$CREATE_OUT" | grep -Eo "$UUID_RE" | head -1 || true)"

  if [ -z "$DB_ID" ]; then
    # Most likely it already exists on the account - look up its id.
    DB_ID="$($WRANGLER d1 list --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          try{const db=JSON.parse(s).find(d=>d.name==="todo");process.stdout.write(db?db.uuid:"")}catch{}
        })' || true)"
  fi

  if [ -z "$DB_ID" ]; then
    echo "Could not create or find the D1 database. Wrangler said:"
    printf '%s\n' "$CREATE_OUT"
    exit 1
  fi

  sed_inplace "s/PLACEHOLDER_DATABASE_ID/$DB_ID/" wrangler.toml
  info "Created database $DB_ID and wrote it into wrangler.toml"
fi

# Default the digest to this machine's timezone rather than whatever the
# project shipped with. Changeable later in the app's Settings.
DETECTED_TZ=""
if [ -L /etc/localtime ]; then
  DETECTED_TZ="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"
fi
if [ -z "$DETECTED_TZ" ]; then
  DETECTED_TZ="$(node -e 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)' 2>/dev/null || true)"
fi
if [ -n "$DETECTED_TZ" ]; then
  sed_inplace "s|DEFAULT_TIMEZONE = \".*\"|DEFAULT_TIMEZONE = \"$DETECTED_TZ\"|" wrangler.toml
  info "Digest timezone set to $DETECTED_TZ"
fi

info "Applying the schema"
$WRANGLER d1 execute todo --remote --file=./schema.sql --yes >/dev/null

# Verify rather than assume. A database with no tables still deploys happily and
# then fails on the first request, which is very hard to diagnose from the app.
MISSING="$($WRANGLER d1 execute todo --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let names=[];
      try{
        const out=JSON.parse(s);
        const rows=(Array.isArray(out)?out:[out]).flatMap(r=>r.results||[]);
        names=rows.map(r=>r.name);
      }catch{}
      const need=["tasks","subscriptions","meta"];
      process.stdout.write(need.filter(t=>!names.includes(t)).join(","));
    })' || echo "check-failed")"

if [ -n "$MISSING" ]; then
  echo
  echo "    The schema did not apply. Missing tables: $MISSING"
  echo "    Try running this by hand to see the error:"
  echo "      npx wrangler d1 execute todo --remote --file=./schema.sql"
  exit 1
fi
info "Schema applied and verified (tasks, subscriptions, meta)"

# ---------------------------------------------------------------------------
step "Creating the Worker"

# Deploy before storing any secrets. "wrangler secret put" against a Worker that
# does not exist yet stops to ask whether to create it, and that question cannot
# be answered here because the secret value is already being piped into stdin.
node scripts/make-icons.mjs >/dev/null

# Stream the output to the screen AND keep a copy. Capturing it in a command
# substitution instead would mean that on failure `set -e` kills the script
# before the error is ever printed - which looks exactly like nothing happening.
DEPLOY_LOG="$(mktemp)"
set +e
$WRANGLER deploy 2>&1 | tee "$DEPLOY_LOG" | sed 's/^/    /'
DEPLOY_STATUS=${PIPESTATUS[0]}
set -e

if [ "$DEPLOY_STATUS" -ne 0 ]; then
  echo
  if grep -q "workers.dev subdomain" "$DEPLOY_LOG"; then
    ACCOUNT_ID="$($WRANGLER whoami 2>/dev/null | grep -Eo '[0-9a-f]{32}' | head -1 || true)"
    cat <<EOF
    Your Cloudflare account has no workers.dev subdomain yet. This is a
    one-time account setting, not a problem with the app.

    Open:

        https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages

    Look for "Subdomain" under Account Details on the right-hand side, and
    choose any unused name - something personal works well. It becomes part
    of your app's address:

        https://todo-app.YOUR-CHOICE.workers.dev

    Then run ./setup.sh again.
EOF
  else
    echo "    Deploy failed. The error is above."
  fi
  rm -f "$DEPLOY_LOG"
  exit 1
fi

APP_URL="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)"
rm -f "$DEPLOY_LOG"

# Remember the address so other scripts don't have to hardcode it.
[ -n "$APP_URL" ] && printf '%s\n' "$APP_URL" > .app-url

# ---------------------------------------------------------------------------
step "Push notification keys"

EXISTING_SECRETS="$($WRANGLER secret list 2>/dev/null || echo '[]')"

if printf '%s' "$EXISTING_SECRETS" | grep -q VAPID_PRIVATE_KEY; then
  info "VAPID keys already exist - leaving them alone."
  info "(Rotating them would unsubscribe every device.)"
else
  info "Generating a new VAPID key pair"
  VAPID_OUTPUT="$(node scripts/generate-vapid.mjs)"
  VAPID_PUBLIC_KEY="$(printf '%s' "$VAPID_OUTPUT" | grep '^VAPID_PUBLIC_KEY=' | cut -d= -f2-)"
  VAPID_PRIVATE_KEY="$(printf '%s' "$VAPID_OUTPUT" | grep '^VAPID_PRIVATE_KEY=' | cut -d= -f2-)"

  printf '%s' "$VAPID_PUBLIC_KEY"  | $WRANGLER secret put VAPID_PUBLIC_KEY  >/dev/null
  printf '%s' "$VAPID_PRIVATE_KEY" | $WRANGLER secret put VAPID_PRIVATE_KEY >/dev/null
  info "Keys stored as Worker secrets"
fi

if ! printf '%s' "$EXISTING_SECRETS" | grep -q VAPID_SUBJECT; then
  printf '\n    Push services want a contact address for your app.\n'
  read -r -p "    Email address [skip]: " CONTACT_EMAIL
  if [ -n "${CONTACT_EMAIL:-}" ]; then
    printf 'mailto:%s' "$CONTACT_EMAIL" | $WRANGLER secret put VAPID_SUBJECT >/dev/null
    info "Contact saved"
  fi
fi

# ---------------------------------------------------------------------------
step "App passphrase"

if printf '%s' "$EXISTING_SECRETS" | grep -q APP_PASSWORD; then
  info "A passphrase is already set. Leaving it as is."
  info "To change it: npx wrangler secret put APP_PASSWORD"
else
  info "This is what you'll type once on each device to unlock the app."
  while true; do
    read -r -s -p "    Choose a passphrase: " PASS1; echo
    read -r -s -p "    Confirm:            " PASS2; echo
    if [ "$PASS1" != "$PASS2" ]; then
      echo "    They don't match - try again."
    elif [ ${#PASS1} -lt 8 ]; then
      echo "    Use at least 8 characters."
    else
      break
    fi
  done
  printf '%s' "$PASS1" | $WRANGLER secret put APP_PASSWORD >/dev/null
  info "Passphrase stored"
fi

printf '\n\033[1m==> Done\033[0m\n'
if [ -n "$APP_URL" ]; then
  printf '\n    Your app:  \033[1m%s\033[0m\n' "$APP_URL"
fi
cat <<'EOF'

    Next, on each device:

      iPhone   Open the URL in Safari, tap Share -> Add to Home Screen,
               then open it from the new icon. Notifications will NOT work
               until you do this - that is an Apple restriction, not a bug.
               Open Settings in the app and tap "Enable notifications".

      Macs     Open the URL, unlock, then Settings -> "Enable notifications".
               Allow the browser prompt when it appears.

    Then use "Send a test notification now" in Settings to confirm it works
    before relying on the 6am digest.

EOF
