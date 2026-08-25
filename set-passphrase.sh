#!/usr/bin/env bash
#
# Set the app passphrase and immediately verify it against the live app.
#
# `wrangler secret put` on its own asks only once and shows nothing as you
# type, so a single mistyped character silently locks you out with no way to
# tell. This asks twice, then proves the stored value actually works.

set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$PATH"

WRANGLER="npx --yes wrangler"

# Work out this deployment's address rather than assuming one. setup.sh records
# it in .app-url; if that is missing, ask Cloudflare where the Worker lives.
APP_URL=""
[ -f .app-url ] && APP_URL="$(tr -d '[:space:]' < .app-url)"

if [ -z "$APP_URL" ]; then
  WORKER_NAME="$(grep -E '^name\s*=' wrangler.toml | head -1 | cut -d'"' -f2)"
  SUBDOMAIN="$($WRANGLER whoami 2>/dev/null | grep -Eo '[a-z0-9-]+\.workers\.dev' | head -1 || true)"
  if [ -n "$WORKER_NAME" ] && [ -n "$SUBDOMAIN" ]; then
    APP_URL="https://${WORKER_NAME}.${SUBDOMAIN}"
  fi
fi

if [ -z "$APP_URL" ]; then
  printf '\n  Could not work out your app address automatically.\n'
  read -r -p "  Paste it (https://....workers.dev): " APP_URL
  APP_URL="$(printf '%s' "$APP_URL" | tr -d '[:space:]')"
fi

if [ -z "$APP_URL" ]; then
  echo "  No address given - cannot verify the passphrase. Aborting."
  exit 1
fi

printf '%s\n' "$APP_URL" > .app-url
echo "  App: $APP_URL"

echo
echo "This is the passphrase you type on each device to unlock the app."
echo "Nothing appears as you type - that is normal."
echo

while true; do
  read -r -s -p "  Choose a passphrase: " PASS1; echo
  read -r -s -p "  Type it again:       " PASS2; echo

  if [ "$PASS1" != "$PASS2" ]; then
    echo "  Those don't match. Try again."
    echo
  elif [ ${#PASS1} -lt 8 ]; then
    echo "  Use at least 8 characters."
    echo
  else
    break
  fi
done

# Catch the mistakes that are invisible in a hidden prompt.
case "$PASS1" in
  ' '*|*' ') echo; echo "  Note: your passphrase starts or ends with a space. That counts."; echo ;;
esac

echo
echo "  Uploading a ${#PASS1}-character passphrase..."
printf '%s' "$PASS1" | $WRANGLER secret put APP_PASSWORD >/dev/null 2>&1
echo "  Uploaded. Waiting for it to roll out..."
sleep 6

# Build the JSON body with node so quotes and backslashes survive intact, and
# pass the value through the environment so it never appears in the process list.
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
PASSPHRASE_VALUE="$PASS1" node -e \
  'require("fs").writeFileSync(process.argv[1], JSON.stringify({passphrase: process.env.PASSPHRASE_VALUE}))' \
  "$BODY_FILE"

STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/api/auth" \
  -H 'Content-Type: application/json' --data-binary "@$BODY_FILE")"

echo
if [ "$STATUS" = "200" ]; then
  cat <<EOF
  ✅ Confirmed. The live app accepts this passphrase.

     Open $APP_URL and log in with it.

EOF
else
  cat <<EOF
  ❌ The app rejected it (HTTP $STATUS).

     That is unexpected, since it was just uploaded. Wait a few seconds and
     run this script again - secret changes occasionally take a moment to
     propagate. If it keeps failing, tell Claude the status code above.

EOF
  exit 1
fi
