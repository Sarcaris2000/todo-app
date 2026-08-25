#!/usr/bin/env node
//
// One-time Google Drive authorisation.
//
//   node scripts/google-auth.mjs
//
// Opens a consent screen in your browser, catches the code on localhost, and
// trades it for a refresh token. Nothing is written to disk: the token is
// handed straight to `wrangler secret put`, so it exists in Cloudflare and in
// your terminal scrollback and nowhere else.

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q);

function page(title, message) {
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:32rem;
margin:20vh auto;padding:0 1.5rem;color:#1a1a1a}h1{font-size:1.3rem}</style>
<h1>${title}</h1><p>${message}</p>`;
}

/** Serve one request, return the ?code, then shut down. */
function awaitCode(state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      const done = (title, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(title, msg));
        server.close();
      };

      if (error) {
        done('Authorisation declined', `Google said: ${error}. You can close this tab.`);
        reject(new Error(error));
      } else if (url.searchParams.get('state') !== state) {
        // Guards against a stray request landing on this port mid-flow.
        done('Mismatched request', 'That did not come from the link we opened.');
        reject(new Error('state mismatch'));
      } else if (code) {
        done('Connected', 'Google Drive is authorised. You can close this tab and return to the terminal.');
        resolve(code);
      } else {
        res.writeHead(404).end();
      }
    });

    server.on('error', (err) => reject(
      err.code === 'EADDRINUSE'
        ? new Error(`Port ${PORT} is busy. Close whatever is using it and try again.`)
        : err,
    ));
    server.listen(PORT);
  });
}

async function main() {
  console.log('\nGoogle Drive backup - one-time setup\n');
  console.log('You need an OAuth client of type "Desktop app" from');
  console.log('https://console.cloud.google.com/apis/credentials, with');
  console.log(`the Drive API enabled and ${REDIRECT} as an authorised redirect URI.\n`);

  const clientId = (await ask('Client ID: ')).trim();
  const clientSecret = (await ask('Client secret: ')).trim();
  if (!clientId || !clientSecret) {
    console.error('\nBoth values are required. Nothing was changed.');
    process.exit(1);
  }

  const state = randomBytes(16).toString('hex');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // Both are needed to be handed a refresh token rather than only an access
    // token; without `prompt=consent` a repeat run silently returns neither.
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  console.log('\nOpening your browser. If nothing happens, paste this in yourself:\n');
  console.log(authUrl.toString(), '\n');

  const pending = awaitCode(state);
  spawn('open', [authUrl.toString()], { stdio: 'ignore', detached: true }).unref();

  const code = await pending;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenResponse.json();
  if (!tokens.refresh_token) {
    console.error('\nGoogle did not return a refresh token.');
    console.error(tokens.error_description || tokens.error || JSON.stringify(tokens));
    console.error('\nIf you have authorised this app before, revoke it at');
    console.error('https://myaccount.google.com/permissions and run this again.');
    process.exit(1);
  }

  console.log('\nGot a refresh token. Storing three secrets in Cloudflare...\n');

  const secrets = {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
  };

  for (const [name, value] of Object.entries(secrets)) {
    // Piped on stdin rather than passed as an argument, so the value never
    // appears in the process list or your shell history.
    const result = spawnSync('npx', ['wrangler', 'secret', 'put', name],
      { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.status !== 0) {
      console.error(`\nCould not store ${name}. Set it by hand:`);
      console.error(`  npx wrangler secret put ${name}`);
      process.exit(1);
    }
  }

  console.log('\nDone. Deploy, then open Settings and press "Back up to Drive now".');
  console.log('After that it runs itself every Sunday morning.\n');
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
