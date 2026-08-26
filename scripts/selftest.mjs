// Self-test for the two things that fail silently in production:
//   1. RFC 8291 payload encryption - a bug here means the push service accepts
//      the message and the device quietly drops it.
//   2. RFC 8292 VAPID signing - a bug here means a 401 from the push service.
//
// The test plays the role of the browser: it generates a subscription key pair,
// lets src/push.js encrypt to it, then decrypts independently and compares.
//
// Run with:  npm test

import { webcrypto as crypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendPush } from '../src/push.js';
import { rankTasks, buildDigest, daysUntil } from '../src/rank.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${label}${detail && !condition ? ` - ${detail}` : ''}`);
}

// --- helpers ---------------------------------------------------------------

const toB64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s) => Buffer.from(
  s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4), 'base64',
);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

// --- 1. web push round trip -------------------------------------------------

async function testPushRoundTrip() {
  console.log('\nWeb Push (RFC 8291 + 8292)');

  // Stand in for the browser's subscription.
  const uaKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  // Stand in for the server's VAPID identity.
  const vapidPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const vapidPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey));
  const vapidJwk = await crypto.subtle.exportKey('jwk', vapidPair.privateKey);

  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-token',
    p256dh: toB64url(uaPublicRaw),
    auth: toB64url(authSecret),
  };

  const env = {
    VAPID_PUBLIC_KEY: toB64url(vapidPublicRaw),
    VAPID_PRIVATE_KEY: vapidJwk.d,
    VAPID_SUBJECT: 'mailto:test@example.com',
  };

  const payload = {
    title: "Today's focus - 2 overdue",
    body: '1. Ship the thing (2 days overdue)\n2. Call the bank (due today)',
    tag: 'digest-2026-08-15',
    url: '/',
  };

  // Intercept the outbound request instead of really contacting a push service.
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(null, { status: 201 });
  };

  let result;
  try {
    result = await sendPush(subscription, payload, env);
  } finally {
    globalThis.fetch = realFetch;
  }

  check('sendPush reports success on 201', result.ok === true);
  check('request went to the subscription endpoint', captured?.url === subscription.endpoint);
  check('Content-Encoding is aes128gcm',
    captured?.options.headers['Content-Encoding'] === 'aes128gcm');
  check('TTL header present', Boolean(captured?.options.headers.TTL));

  // -- verify the VAPID JWT the way a push service would --
  const authHeader = captured.options.headers.Authorization;
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader);
  check('Authorization header is well formed', Boolean(match));

  if (match) {
    const [, jwt, keyParam] = match;
    check('advertised key matches the VAPID public key', keyParam === env.VAPID_PUBLIC_KEY);

    const [headerB64, claimsB64, sigB64] = jwt.split('.');
    const header = JSON.parse(fromB64url(headerB64).toString());
    const claims = JSON.parse(fromB64url(claimsB64).toString());

    check('JWT alg is ES256', header.alg === 'ES256');
    check('JWT aud is the endpoint origin',
      claims.aud === 'https://fcm.googleapis.com', `got ${claims.aud}`);
    check('JWT sub carries the contact', claims.sub === 'mailto:test@example.com');

    const nowSeconds = Math.floor(Date.now() / 1000);
    check('JWT expiry is in the future and within 24h',
      claims.exp > nowSeconds && claims.exp <= nowSeconds + 86400);

    const verifyKey = await crypto.subtle.importKey(
      'raw', vapidPublicRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    const signatureValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      fromB64url(sigB64),
      new TextEncoder().encode(`${headerB64}.${claimsB64}`),
    );
    check('JWT signature verifies against the public key', signatureValid);
  }

  // -- decrypt the body exactly as the browser would --
  const body = new Uint8Array(captured.options.body);
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const keyIdLength = body[20];
  const asPublicRaw = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);

  check('record size header is 4096', recordSize === 4096, `got ${recordSize}`);
  check('ephemeral key is a 65-byte point', keyIdLength === 65, `got ${keyIdLength}`);

  const asPublicKey = await crypto.subtle.importKey(
    'raw', asPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: asPublicKey }, uaKeys.privateKey, 256,
  ));

  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw,
  );
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);

  let decrypted;
  try {
    decrypted = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext,
    ));
  } catch (error) {
    check('payload decrypts with the subscription keys', false, String(error));
    return;
  }

  check('payload decrypts with the subscription keys', true);
  check('final record delimiter is 0x02', decrypted[decrypted.length - 1] === 2);

  const recovered = JSON.parse(Buffer.from(decrypted.slice(0, -1)).toString('utf8'));
  check('title survives the round trip', recovered.title === payload.title);
  check('body survives the round trip', recovered.body === payload.body);
  check('tag survives the round trip', recovered.tag === payload.tag);

  // Two sends must not reuse the ephemeral key or salt.
  let secondBody = null;
  globalThis.fetch = async (url, options) => {
    secondBody = new Uint8Array(options.body);
    return new Response(null, { status: 201 });
  };
  try {
    await sendPush(subscription, payload, env);
  } finally {
    globalThis.fetch = realFetch;
  }
  check('each send uses a fresh salt',
    Buffer.compare(Buffer.from(salt), Buffer.from(secondBody.slice(0, 16))) !== 0);
  check('each send uses a fresh ephemeral key',
    Buffer.compare(Buffer.from(asPublicRaw), Buffer.from(secondBody.slice(21, 86))) !== 0);
}

// --- 2. ranking -------------------------------------------------------------

function testRanking() {
  console.log('\nRanking and digest');

  const today = '2026-08-15';
  const created = '2026-08-01T00:00:00.000Z';

  const tasks = [
    { id: 'a', title: 'Overdue tax form', notes: '', deadline: '2026-08-12', priority: 2, estimate_minutes: 60, status: 'open', created_at: created },
    { id: 'b', title: 'Due today: send invoice', notes: '', deadline: '2026-08-15', priority: 2, estimate_minutes: 20, status: 'open', created_at: created },
    { id: 'c', title: 'High priority, no deadline', notes: '', deadline: null, priority: 1, estimate_minutes: null, status: 'open', created_at: created },
    { id: 'd', title: 'Low priority, far off', notes: '', deadline: '2026-12-01', priority: 3, estimate_minutes: null, status: 'open', created_at: created },
    { id: 'e', title: 'Already finished', notes: '', deadline: '2026-08-14', priority: 1, estimate_minutes: null, status: 'done', created_at: created },
  ];

  const ranked = rankTasks(tasks, today);

  check('completed tasks are excluded', !ranked.some((t) => t.id === 'e'));
  check('overdue task ranks first', ranked[0]?.id === 'a', `got ${ranked[0]?.id}`);
  check('due-today ranks second', ranked[1]?.id === 'b', `got ${ranked[1]?.id}`);
  check('distant low-priority task ranks last', ranked[ranked.length - 1]?.id === 'd');
  check('overdue flag is set', ranked[0]?.overdue === true);
  check('overdue label reads naturally', ranked[0]?.due_label === '3 days overdue',
    `got ${ranked[0]?.due_label}`);
  check('due-today label reads naturally', ranked[1]?.due_label === 'due today');

  const digest = buildDigest(tasks, today);
  check('digest counts open tasks only', digest.count === 4, `got ${digest.count}`);
  check('digest title flags overdue work', digest.title.includes('overdue'), digest.title);
  check('digest lists the top three', digest.body.split('\n').filter((l) => /^\d\./.test(l)).length === 3);
  check('digest mentions the overflow', digest.body.includes('+1 more'), digest.body);

  // --- folders ---
  const mixed = [
    { id: 'w', title: 'Ship the release', deadline: '2026-08-15', priority: 1, status: 'open', category: 'work', created_at: created },
    { id: 'p', title: 'Book the dentist', deadline: '2026-08-16', priority: 2, status: 'open', category: 'personal', created_at: created },
  ];
  const mixedDigest = buildDigest(mixed, today);
  check('digest labels the folder when both are in play',
    /Work · Ship the release/.test(mixedDigest.body) && /Personal · Book the dentist/.test(mixedDigest.body),
    mixedDigest.body);

  const workOnly = [mixed[0], { ...mixed[1], category: 'work', id: 'w2' }];
  const workDigest = buildDigest(workOnly, today);
  check('digest omits the folder label when only one is in play',
    !/Work ·/.test(workDigest.body), workDigest.body);

  // A task written before folders existed has no category at all.
  const legacy = buildDigest([{ id: 'l', title: 'Old task', deadline: today, priority: 2, status: 'open', created_at: created }], today);
  check('tasks with no category do not break the digest', /Old task/.test(legacy.body), legacy.body);

  check('ranking carries the folder through',
    rankTasks(mixed, today).every((t) => typeof t.category === 'string'));

  const empty = buildDigest([], today);
  check('empty list produces a sensible message', empty.count === 0 && /No open tasks/.test(empty.body));

  const doneOnly = buildDigest([tasks[4]], today);
  check('all-done list reads as empty', doneOnly.count === 0);

  check('daysUntil handles overdue', daysUntil(today, '2026-08-12') === -3);
  check('daysUntil handles future', daysUntil(today, '2026-08-20') === 5);
  check('daysUntil rejects junk', daysUntil(today, 'not-a-date') === null);

  // A task made overdue by years must not permanently outrank today's work
  // by an unbounded margin.
  const ancient = [
    { id: 'x', title: 'Ancient', deadline: '2020-01-01', priority: 3, status: 'open', created_at: created },
    { id: 'y', title: 'Today high', deadline: today, priority: 1, status: 'open', created_at: created },
  ];
  const ancientRanked = rankTasks(ancient, today);
  check('very old overdue task is capped, not runaway',
    ancientRanked[0].score - ancientRanked[1].score < 100,
    `gap ${(ancientRanked[0].score - ancientRanked[1].score).toFixed(1)}`);
}

// --- 3. frontend ------------------------------------------------------------

function testFrontend() {
  console.log('\nFrontend');

  // The Worker tests never load public/, so a syntax error there would ship
  // silently - and a script that fails to parse attaches no event listeners,
  // which looks like buttons that simply do nothing.
  for (const file of ['public/app.js', 'public/sw.js']) {
    let ok = true;
    let detail = '';
    try {
      execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
    } catch (error) {
      ok = false;
      detail = String(error.stderr || error).split('\n').slice(0, 3).join(' ');
    }
    check(`${file} parses`, ok, detail);
  }

  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');

  // `hidden` is implemented as `display: none` in the UA stylesheet, so any
  // author rule setting `display` on the same element silently defeats it.
  // Everything the app shows and hides at runtime depends on this holding.
  const hiddenGuard = /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(css);
  check('[hidden] overrides author display rules', hiddenGuard,
    'add `[hidden] { display: none !important; }` to styles.css');

  // Find every element that starts out hidden, and flag any whose class also
  // sets `display` - those are exactly the ones the guard has to rescue.
  const hiddenEls = [...html.matchAll(/<(\w+)([^>]*\bhidden\b[^>]*)>/g)].map((m) => {
    const attrs = m[2];
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const cls = /class="([^"]+)"/.exec(attrs)?.[1] ?? '';
    return { id, classes: cls.split(/\s+/).filter(Boolean) };
  });

  check('found elements that start hidden', hiddenEls.length > 0,
    `found ${hiddenEls.length}`);

  const atRisk = hiddenEls.filter(({ classes }) => classes.some((c) => {
    const rule = new RegExp(`\\.${c}\\s*\\{[^}]*display\\s*:`, 'm');
    return rule.test(css);
  }));

  // This is not a failure by itself - the guard above is what makes it safe -
  // but it documents why the guard must never be removed.
  console.log(`  [info] ${atRisk.length} hidden element(s) have a class that sets display`
    + (atRisk.length ? `: ${atRisk.map((e) => `#${e.id}`).join(', ')}` : ''));
  check('those elements are rescued by the [hidden] guard',
    atRisk.length === 0 || hiddenGuard);

  // An HTML `step` counts from `min`, not from zero, so step="5" min="1"
  // silently rejects 30 and 60 - the browser blocks the submit and the app
  // shows nothing. Check every number input accepts the obvious values.
  const numberInputs = [...html.matchAll(/<input[^>]*type="number"[^>]*>/g)].map((m) => m[0]);
  check('found the number inputs', numberInputs.length > 0, `${numberInputs.length}`);

  for (const tag of numberInputs) {
    const id = /id="([^"]+)"/.exec(tag)?.[1] ?? 'unknown';
    const min = Number(/min="([^"]+)"/.exec(tag)?.[1] ?? 0);
    const stepAttr = /step="([^"]+)"/.exec(tag)?.[1] ?? '1';
    if (stepAttr === 'any') continue;

    const step = Number(stepAttr);
    const rejected = [15, 20, 30, 45, 60, 90, 120, 240].filter((value) => {
      if (value < min) return false;
      const steps = (value - min) / step;
      return Math.abs(steps - Math.round(steps)) > 1e-9;
    });

    check(`#${id} accepts round values`, rejected.length === 0,
      `min=${min} step=${step} rejects ${rejected.join(', ')}`);
  }

  const appJs = readFileSync(join(ROOT, 'public/app.js'), 'utf8');

  // --- one list, not two ---
  check('the duplicate focus panel is gone', !/id="focus-list"/.test(html));
  check('there is exactly one task list',
    (html.match(/id="task-list"/g) || []).length === 1);
  check('rows expose Edit and Complete actions',
    /data-edit=/.test(appJs) && /swipe-action complete/.test(appJs));
  check('tapping a row no longer opens the edit form',
    !/data-open=/.test(appJs), 'row-wide click-to-edit should be gone');

  // The drag distance in JS and the button strip width in CSS must agree, or
  // rows snap open to a position that does not line up with the buttons.
  const jsWidth = Number(/const ACTIONS_WIDTH = (\d+)/.exec(appJs)?.[1]);
  const cssWidth = Number(/--actions-width:\s*(\d+)px/.exec(css)?.[1]);
  check('swipe width matches between JS and CSS', jsWidth === cssWidth,
    `js=${jsWidth} css=${cssWidth}`);

  // Vertical scrolling must stay with the browser on touch devices.
  check('rows allow vertical panning', /touch-action:\s*pan-y/.test(css));

  // The buttons slide in over the row; the row itself must never move, or the
  // task text slides out of view exactly when you are reading it.
  check('the task card is never translated', !/card\.style\.transform/.test(appJs));
  check('the action strip is what moves', /actions\.style\.transform/.test(appJs));
  check('actions start parked off to the right',
    /\.task-actions\b[^}]*transform:\s*translateX\(100%\)/s.test(css));

  // The device must persist a session token, never the passphrase itself.
  check('device stores a session token, not the passphrase',
    /TOKEN_KEY\s*=\s*'todo\.session'/.test(appJs));
  check('passphrase is never written to localStorage',
    !/setItem\(TOKEN_KEY,\s*passphrase\)/.test(appJs));

  // A silent unlock failure was the single hardest bug to diagnose here.
  check('unlock failures are surfaced, not swallowed', /showLockError/.test(appJs));
}

// --- 4. auth hardening -------------------------------------------------------

async function testAuth() {
  console.log('\nAuth hardening');

  const { lockoutMs, newSessionToken, sha256Hex } = await import('../src/auth.js');

  // Honest typos must not lock you out immediately.
  check('first 4 attempts are free', [1, 2, 3, 4].every((n) => lockoutMs(n) === 0));
  check('5th attempt locks for 1 minute', lockoutMs(5) === 60_000, `${lockoutMs(5)}ms`);
  check('6th attempt locks for 2 minutes', lockoutMs(6) === 120_000);
  check('lockout doubles each time', lockoutMs(8) === lockoutMs(7) * 2);
  check('lockout caps at 24 hours', lockoutMs(50) === 24 * 60 * 60 * 1000);
  check('lockout is never negative', [0, -1, 1].every((n) => lockoutMs(n) >= 0));

  // Guessing at even 1 attempt/second becomes hopeless quickly.
  const hoursToTwentyGuesses = Array.from({ length: 20 }, (_, i) => lockoutMs(i + 1))
    .reduce((a, b) => a + b, 0) / 3_600_000;
  check('20 guesses would take over a day of lockouts', hoursToTwentyGuesses > 24,
    `${hoursToTwentyGuesses.toFixed(1)}h`);

  const a = newSessionToken();
  const b = newSessionToken();
  check('session tokens are unique', a !== b);
  check('session tokens are URL-safe', /^[A-Za-z0-9_-]+$/.test(a), a);
  check('session tokens carry 256 bits', a.length >= 43, `${a.length} chars`);

  const hash = await sha256Hex('a-token');
  check('token hashing is 64 hex chars', /^[0-9a-f]{64}$/.test(hash));
  check('hashing is deterministic', await sha256Hex('a-token') === hash);
  check('different tokens hash differently', await sha256Hex('b-token') !== hash);

  // The schema must actually contain the new tables, or the deploy half-works.
  const schema = readFileSync(join(ROOT, 'schema.sql'), 'utf8');
  check('schema defines sessions', /CREATE TABLE IF NOT EXISTS sessions/.test(schema));
  check('schema defines auth_attempts', /CREATE TABLE IF NOT EXISTS auth_attempts/.test(schema));

  // Only the hash is persisted - a database leak must not yield usable tokens.
  const authJs = readFileSync(join(ROOT, 'src/auth.js'), 'utf8');
  check('only the token hash is stored', /token_hash/.test(authJs) && !/INSERT INTO sessions[^;]*\btoken\b\s*\)/.test(authJs));

  // The passphrase must no longer be accepted as a bearer token.
  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check('passphrase is not accepted as a bearer token',
    !/safeEqual\(token,\s*env\.APP_PASSWORD\)/.test(indexJs));
  check('/api/auth is rate limited', /checkLockout/.test(indexJs) && /recordFailure/.test(indexJs));
  check('repeated failures raise an alert', /sendSecurityAlert/.test(indexJs));
}

// --- 5. workouts -------------------------------------------------------------

async function testWorkouts() {
  console.log('\nWorkout routine');

  const {
    cleanPlanEntry, workoutDigestLine, localDayOfWeek, dayOfWeekForISO, MODALITIES,
  } = await import('../src/workouts.js');

  check('modalities include rest', MODALITIES.includes('rest'));

  const entry = cleanPlanEntry({ title: '  Power Zone Ride  ', modality: 'bike', duration_minutes: '45', instructor: 'Matt Wilpers' });
  check('plan entry trims the title', entry.title === 'Power Zone Ride', entry.title);
  check('plan entry keeps the duration', entry.duration_minutes === 45);
  check('plan entry keeps the instructor', entry.instructor === 'Matt Wilpers');

  const junk = cleanPlanEntry({ title: '', modality: 'interpretive-dance', duration_minutes: -5 });
  check('empty title falls back to rest day', junk.title === 'Rest day');
  check('unknown modality falls back', junk.modality === 'strength', junk.modality);
  check('negative duration is dropped', junk.duration_minutes === null);

  // A rest day with a duration is contradictory and would show "Rest · 30 min".
  const rest = cleanPlanEntry({ title: 'Rest day', modality: 'rest', duration_minutes: 30 });
  check('rest days carry no duration', rest.duration_minutes === null);

  check('rest reads as rest in the digest',
    /Rest day/.test(workoutDigestLine({ title: 'Rest day', modality: 'rest' })));
  check('digest line names class, length and instructor',
    workoutDigestLine({ title: 'Power Zone Endurance', modality: 'bike', duration_minutes: 30, instructor: 'Matt Wilpers' })
      === 'Power Zone Endurance · 30 min · Matt Wilpers');
  check('digest line copes with no instructor',
    workoutDigestLine({ title: 'Long Ride', modality: 'bike', duration_minutes: 60 })
      === 'Long Ride · 60 min');

  // Day-of-week maths underpins which workout you are shown.
  check('2026-08-15 is a Saturday', dayOfWeekForISO('2026-08-15') === 6);
  check('2026-08-16 is a Sunday', dayOfWeekForISO('2026-08-16') === 0);
  check('junk dates do not throw', dayOfWeekForISO('nonsense') === 0);
  check('localDayOfWeek returns 0-6',
    [0,1,2,3,4,5,6].includes(localDayOfWeek('America/Chicago')));

  // The seeded week must be complete and balanced, or the routine has holes.
  const seed = readFileSync(join(ROOT, 'migrations/002-add-workouts.sql'), 'utf8');
  const days = [...seed.matchAll(/^\s*\((\d),/gm)].map((m) => Number(m[1]));
  check('the seeded plan covers all seven days',
    new Set(days).size === 7, `got ${days.length} rows`);
  check('the seeded plan includes a rest day', /'rest'/.test(seed));
  check('the seeded plan includes strength work',
    (seed.match(/'strength'/g) || []).length >= 2);

  // Fitness must be a real folder or the auto-created task lands nowhere.
  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check("'fitness' is an accepted folder", /CATEGORIES = \['personal', 'work', 'fitness'\]/.test(indexJs));
  check('the workout task id is derived from the date',
    /`workout-\$\{todayISO\}`/.test(indexJs));
  check('creating the workout task cannot duplicate',
    /INSERT OR IGNORE INTO tasks/.test(indexJs));
  check('rest days do not create a task',
    /modality === 'rest'\) return null/.test(indexJs));
  check('the digest carries a workout line', /Workout: \$\{workoutDigestLine/.test(indexJs));

  const appJs2 = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  check('the app knows the Fitness folder', /fitness: 'Fitness'/.test(appJs2));

  // --- high-impact spacing ---
  const { backToBackImpactDays } = await import('../src/workouts.js');
  const d = (day, modality) => ({ day_of_week: day, modality });

  const clash = backToBackImpactDays([
    d(0,'bike'), d(1,'strength'), d(2,'run'), d(3,'bike'),
    d(4,'rest'), d(5,'run'), d(6,'run'),
  ]);
  check('adjacent run days are flagged', clash.length === 1, `${clash.length}`);
  check('the flag names both days',
    clash[0]?.name === 'Friday' && clash[0]?.nextName === 'Saturday');

  check('well-spaced runs are not flagged', backToBackImpactDays([
    d(0,'bike'), d(1,'strength'), d(2,'run'), d(3,'bike'),
    d(4,'rest'), d(5,'strength'), d(6,'run'),
  ]).length === 0);

  // Saturday-into-Sunday wraps around the week boundary and is easy to miss.
  check('the week wraps when checking Saturday into Sunday', backToBackImpactDays([
    d(0,'run'), d(1,'strength'), d(2,'bike'), d(3,'bike'),
    d(4,'rest'), d(5,'strength'), d(6,'run'),
  ]).length === 1);

  // Riding twice in a row is fine - it is impact that needs the spacing.
  check('back-to-back rides are not flagged', backToBackImpactDays([
    d(0,'bike'), d(1,'bike'), d(2,'strength'), d(3,'rest'),
    d(4,'rest'), d(5,'strength'), d(6,'yoga'),
  ]).length === 0);

  // The plan shipped to other people must itself be well spaced.
  const seedRuns = [...seed.matchAll(/\((\d), '[^']*', '(\w+)'/g)]
    .map((m) => ({ day_of_week: Number(m[1]), modality: m[2] }));
  check('the shipped starter plan has no back-to-back runs',
    backToBackImpactDays(seedRuns).length === 0);

  check('the editor warns about it', /showPlanWarnings/.test(appJs2));
}

// --- 6. recurrence and snooze -------------------------------------------------

async function testRecurrence() {
  console.log('\nRecurring tasks and snooze');

  const { nextOccurrence, isSnoozed, snoozeDate, snoozeLabel, cleanRecur } =
    await import('../src/recurrence.js');

  const mon = '2026-08-24';

  check('daily advances one day', nextOccurrence('daily', mon, mon) === '2026-08-25');
  check('weekly advances seven days', nextOccurrence('weekly', mon, mon) === '2026-08-31');
  check('monthly advances one month', nextOccurrence('monthly', mon, mon) === '2026-09-24');

  // Friday + weekdays must land on Monday, not Saturday.
  check('weekdays skips the weekend',
    nextOccurrence('weekdays', '2026-08-28', '2026-08-28') === '2026-08-31');

  // Month-end is where naive date maths silently spills into the next month.
  check('Jan 31 monthly clamps to Feb', nextOccurrence('monthly', '2027-01-31', '2027-01-31') === '2027-02-28');
  check('Mar 31 monthly clamps to Apr 30', nextOccurrence('monthly', '2027-03-31', '2027-03-31') === '2027-04-30');

  // A task completed three weeks late must not be reborn already overdue.
  check('an overdue repeat schedules into the future',
    nextOccurrence('weekly', '2026-08-01', mon) > mon,
    nextOccurrence('weekly', '2026-08-01', mon));

  check('unknown repeat rules are rejected', cleanRecur('fortnightly') === null);
  check('no rule yields no occurrence', nextOccurrence(null, mon, mon) === null);

  check('tomorrow resolves', snoozeDate('tomorrow', mon) === '2026-08-25');
  check('nextweek lands on a Monday',
    new Date(`${snoozeDate('nextweek', mon)}T00:00:00Z`).getUTCDay() === 1);
  check('weekend lands on a Saturday',
    new Date(`${snoozeDate('weekend', mon)}T00:00:00Z`).getUTCDay() === 6);

  check('a future snooze hides the task', isSnoozed({ snoozed_until: '2026-08-26' }, mon));
  check('a snooze ending today does not hide it', !isSnoozed({ snoozed_until: mon }, mon));
  check('no snooze means visible', !isSnoozed({ snoozed_until: null }, mon));
  check('snooze reads naturally', snoozeLabel('2026-08-25', mon) === 'hidden until tomorrow');

  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check('snoozed tasks are kept out of the digest',
    /\.filter\(\(t\) => !isSnoozed\(t, todayISO\)\)/.test(indexJs));
  check('completing a repeat schedules the next one',
    /scheduleNextOccurrence\(env, existing, today\)/.test(indexJs));
  check('workout tasks do not double-schedule', /!workoutDate/.test(indexJs));
  check('the weekly review has its own guard key', /last_review_date/.test(indexJs));

  // --- evening nudge ---
  const { composeEveningNudge } = await import('../src/index.js');
  check('the evening nudge exists', /sendEveningNudge/.test(indexJs));
  check('it reports what is still open rather than checking one task',
    /Nothing outstanding/.test(indexJs));
  // The nudge used to list only what was still owed today. It now also says
  // what tomorrow holds, which is the last moment you can act on it - so
  // "nothing outstanding" alone is no longer a reason to stay silent.
  // Sunday-only was right when the nudge just tallied what was still open. A
  // look-ahead is only useful the night before, which is every night.
  check('the evening nudge defaults to every night',
    /getSetting\(env, 'evening_days', '0,1,2,3,4,5,6'\)/.test(indexJs));
  // A hide-until-due task is invisible on every other day, so the one night it
  // can appear it must not be pushed out by three stale overdue items.
  const SUNDAY = '2026-08-30';
  const pinned = composeEveningNudge({
    outstanding: [
      ...Array.from({ length: 5 }, (_, i) => ({ title: `Old ${i}`, deadline: `2026-08-2${i}`, hide_until_due: 0 })),
      { title: "Send Claude this week's calendar", deadline: SUNDAY, hide_until_due: 1 },
    ],
    ahead: [], dueTomorrow: [], todayISO: SUNDAY,
  });
  check('a task hidden until today leads the nudge',
    pinned.body.startsWith("• Send Claude this week's calendar"));
  check('and the backlog still fills the rest', /\+3 more$/.test(pinned.body));
  check('a hidden task due another day is not pinned',
    !composeEveningNudge({
      outstanding: [{ title: 'A', deadline: '2026-08-24', hide_until_due: 0 },
        { title: 'Later', deadline: '2026-09-05', hide_until_due: 1 }],
      ahead: [], dueTomorrow: [], todayISO: SUNDAY,
    }).body.startsWith('• Later'));

  check('a quiet night sends nothing',
    composeEveningNudge({ outstanding: [], ahead: [], dueTomorrow: [], todayISO: '2026-08-25' }) === null);
  const owedAndBusy = composeEveningNudge({
    outstanding: [{ title: 'Sign PFTs', deadline: '2026-08-25' },
      { title: 'Late one', deadline: '2026-08-20' }],
    ahead: ['PULMONARY CLINIC PM (5h 30m)'],
    dueTomorrow: [{}, {}],
    todayISO: '2026-08-25',
  });
  check('an overdue count leads the title', owedAndBusy.title === 'Still open — 1 overdue');
  check('what is owed comes first', owedAndBusy.body.startsWith('• Sign PFTs'));
  check('tomorrow follows, after a blank line',
    /\n\nTomorrow: PULMONARY CLINIC PM \(5h 30m\) · 2 due$/.test(owedAndBusy.body));
  const onlyTomorrow = composeEveningNudge({
    outstanding: [], ahead: ['ICU SERVICE (11h)'], dueTomorrow: [{}], todayISO: '2026-08-25',
  });
  check('a clear evening before a busy day still gets a nudge', onlyTomorrow !== null);
  check('and does not say "Tomorrow" twice',
    onlyTomorrow.title === 'Tomorrow' && !onlyTomorrow.body.includes('Tomorrow'));
  check('only the first three owed items are listed',
    composeEveningNudge({
      outstanding: Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, deadline: '2026-08-25' })),
      ahead: [], dueTomorrow: [], todayISO: '2026-08-25',
    }).body.endsWith('+3 more'));
  check('the workout is excluded from the nudge',
    /!\/\^workout-\/\.test\(t\.id\)/.test(indexJs));
  check('snoozed tasks do not trigger a nudge',
    /\.filter\(\(t\) => !isSnoozed\(t, todayISO\)\)/.test(indexJs));
  check('it only fires on chosen days', /wantsTonight/.test(indexJs));
  check('it has its own guard key', /last_evening_date/.test(indexJs));
  check('a nudge failure cannot break the morning brief',
    /Evening nudge failed/.test(indexJs));
  check('the nudge runs before the notify-hour gate',
    indexJs.indexOf('wantsTonight && hour === eveningHour')
      < indexJs.indexOf('if (hour !== notifyHour) return;'));
  check('a review failure cannot suppress the digest',
    /Weekly review failed/.test(indexJs));

  const appJs3 = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  check('swiping right offers Later', /data-later=/.test(appJs3));

  // --- transport and browser hardening ---
  check('HSTS is set', /Strict-Transport-Security/.test(indexJs));
  check('a content security policy is set', /Content-Security-Policy/.test(indexJs));
  // Check the policy itself, not the whole file - prose about CSP mentions
  // these strings and would otherwise fail the test that guards them.
  const cspBlock = /'Content-Security-Policy': \[([\s\S]*?)\]\.join/.exec(indexJs)?.[1] ?? '';
  check('the CSP was found in the source', cspBlock.length > 0);
  check('the CSP has no unsafe-inline', !/unsafe-inline/.test(cspBlock));
  check('the CSP has no unsafe-eval', !/unsafe-eval/.test(cspBlock));
  check('the CSP defaults to self', /default-src 'self'/.test(cspBlock));
  check('framing is denied', /frame-ancestors 'none'/.test(indexJs));
  check('MIME sniffing is off', /X-Content-Type-Options/.test(indexJs));
  check('plain HTTP redirects to HTTPS', /url\.protocol === 'http:'/.test(indexJs));
  // Assigning url.protocol is a no-op in this runtime and loops forever.
  check('the redirect target is built explicitly, not by assigning protocol',
    !/url\.protocol = 'https:'/.test(indexJs));
  check('headers are applied to assets as well as the API',
    (indexJs.match(/withSecurityHeaders/g) || []).length >= 3);

  // --- the Sunday review nags about both halves ---
  check('the review looks a week ahead', /weekAhead/.test(indexJs));
  check('it lists high priority work due this week',
    /High priority this week/.test(indexJs));
  check('only priority 1 qualifies',
    /Number\(t\.priority\) === 1/.test(indexJs));
  check('the window is bounded at both ends',
    /t\.deadline >= todayISO/.test(indexJs) && /t\.deadline <= weekAhead/.test(indexJs));
  check('it also nags about stale tasks', /Sitting too long/.test(indexJs));
  check('stale means at least a fortnight', /t\.age >= 14/.test(indexJs));
  check('a task is never listed in both sections',
    /named\.has\(t\.id\)/.test(indexJs));
  check('auto-created workout rows are excluded from the review',
    /!\/\^workout-\/\.test\(t\.id\)/.test(indexJs));
  check('a clean week says so', /Nothing overdue and nothing rotting/.test(indexJs));
  const jsLater = Number(/const LATER_WIDTH = (\d+)/.exec(appJs3)?.[1]);
  const cssLater = Number(/--later-width:\s*(\d+)px/.exec(readFileSync(join(ROOT, 'public/styles.css'), 'utf8'))?.[1]);
  check('Later strip width matches between JS and CSS', jsLater === cssLater, `js=${jsLater} css=${cssLater}`);
}

// --- 7. quick add, search, workload, subtasks ---------------------------------

async function testQuickAdd() {
  console.log('\nQuick add and new views');

  // One parser, imported the same way the Worker imports it.
  const { parseQuickAdd: parse } = await import('../public/parse.js');
  const mon = '2026-08-24'; // a Monday

  check('a plain sentence stays a plain task', (() => {
    const r = parse('Buy milk', mon);
    return r.title === 'Buy milk' && !r.deadline && r.priority === 2 && !r.recur;
  })());

  const full = parse('Call Riverside friday 3pm p1 #work 30m', mon);
  check('title is stripped of all metadata', full.title === 'Call Riverside', full.title);
  check('weekday resolves to the next one', full.deadline === '2026-08-28', full.deadline);
  check('p1 sets high priority', full.priority === 1);
  check('#work sets the folder', full.category === 'work');
  check('30m sets the estimate', full.estimate_minutes === 30);
  check('a time of day is consumed, not left in the title', !/3pm/.test(full.title));

  check('1.5h becomes 90 minutes', parse('Thing 1.5h', mon).estimate_minutes === 90);
  check('2h becomes 120 minutes', parse('Thing 2h', mon).estimate_minutes === 120);
  check('bang marks raise priority', parse('Thing !!!', mon).priority === 1);

  check('tomorrow resolves', parse('Thing tomorrow', mon).deadline === '2026-08-25');
  check('in N days resolves', parse('Thing in 3 days', mon).deadline === '2026-08-27');
  check('next week lands on Monday',
    new Date(`${parse('Thing next week', mon).deadline}T00:00:00Z`).getUTCDay() === 1);
  check('a month and day resolve', parse('Thing Aug 30', mon).deadline === '2026-08-30');
  check('an ISO date passes through', parse('Thing 2026-09-14', mon).deadline === '2026-09-14');

  // "every friday" must mean weekly AND set the first date - not just a date.
  const rep = parse('Reconcile invoices every friday', mon);
  check('every-weekday sets a repeat', rep.recur === 'weekly', String(rep.recur));
  check('every-weekday also sets the first date', rep.deadline === '2026-08-28', String(rep.deadline));
  check('every weekday is distinct from every week',
    parse('Standup every weekday', mon).recur === 'weekdays');

  // A month/day already past should roll to next year, not schedule in the past.
  check('a past month rolls to next year',
    parse('Taxes Jan 15', mon).deadline === '2027-01-15',
    parse('Taxes Jan 15', mon).deadline);

  // Metadata-only input must not produce an empty task.
  check('metadata-only input keeps something as the title',
    parse('tomorrow p1', mon).title.length > 0);

  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check('subtasks are sanitised server-side', /function cleanSubtasks/.test(indexJs));
  check('subtask text is length-capped', /slice\(0, 200\)/.test(indexJs));
  check('workload counts only what is due', /function workloadFor/.test(indexJs));
  check('unestimated tasks are counted separately, not as zero',
    /unestimated/.test(indexJs));
  check('the digest reports the day total', /of tasks`/.test(indexJs));
  check('the digest reports free time once a capacity is set', /free\.`/.test(indexJs));

  const appJs4 = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  check('search spans title, notes and steps', /function matchesSearch/.test(appJs4));
  check('search ignores the folder and status filters',
    /search\s*\n?\s*\?\s*tasks\.filter\(matchesSearch\)/.test(appJs4));
  // Upcoming is its own section, not a filter on the task list - a rostered
  // clinic is not a task and should not sit in a list of things to complete.
  check('upcoming is a section, not a task filter',
    /function renderUpcoming/.test(appJs4) && !/filter === 'upcoming'/.test(appJs4));
  check('the task tabs are back to open, done and all',
    !/data-filter="upcoming"/.test(readFileSync(join(ROOT, 'public/index.html'), 'utf8')));
  check('upcoming shows clinical work and task deadlines',
    /upcomingClinical/.test(appJs4) && /clinical-row/.test(appJs4) && /upcoming-task/.test(appJs4));
  check('the horizon is adjustable and remembered',
    /todo\.upcomingDays/.test(appJs4));
  check('the parse preview is shown before adding', /renderQuickPreview/.test(appJs4));

  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  check('parse.js loads before app.js',
    html.indexOf('/parse.js') < html.indexOf('/app.js'));
  // Module scripts execute before DOMContentLoaded, and app.js only calls the
  // parser from inside DOMContentLoaded handlers, so the ordering holds.
  check('parse.js is loaded as a module so its export runs',
    /<script type="module" src="\/parse\.js">/.test(html));
  check('the Worker and the browser share one parser',
    /from '\.\.\/public\/parse\.js'/.test(readFileSync(join(ROOT, 'src/index.js'), 'utf8')));
  // The dictated line is `spoken`, not `text`: `text` is now the plain-text
  // response helper, and one of them had to give way.
  check('dictated text goes through the same parser',
    /parseQuickAdd\(spoken, today\)/.test(readFileSync(join(ROOT, 'src/index.js'), 'utf8')));
}

// --- 8. weekly events ---------------------------------------------------------

async function testEvents() {
  console.log('\nWeekly events');

  const { cleanTime, cleanEvent, eventMinutes, eventLabel, eventsDigestLine } =
    await import('../src/events.js');

  check('HH:MM is accepted', cleanTime('08:30') === '08:30');
  check('single-digit hours are padded', cleanTime('8:30') === '08:30');
  check('nonsense times are rejected', cleanTime('25:00') === null);
  check('bad minutes are rejected', cleanTime('08:75') === null);
  check('empty means no time', cleanTime('') === null);

  const clinic = cleanEvent({ day_of_week: 2, title: '  Clinic  ', start_time: '8:00', end_time: '12:00' });
  check('title is trimmed', clinic.title === 'Clinic');
  check('times are normalised', clinic.start_time === '08:00' && clinic.end_time === '12:00');
  check('duration is computed', eventMinutes(clinic) === 240);

  // An end before its start would produce negative time in the totals.
  const backwards = cleanEvent({ day_of_week: 1, title: 'Odd', start_time: '17:00', end_time: '09:00' });
  check('a backwards end time is dropped', backwards.end_time === null);
  check('a dropped end means zero duration, never negative', eventMinutes(backwards) === 0);

  // An untimed event must not be counted as occupying the whole day.
  check('an untimed event occupies no measured time',
    eventMinutes(cleanEvent({ day_of_week: 3, title: 'Admin' })) === 0);

  let threw = false;
  try { cleanEvent({ day_of_week: 9, title: 'Nope' }); } catch { threw = true; }
  check('an impossible day is rejected', threw);

  threw = false;
  try { cleanEvent({ day_of_week: 1, title: '   ' }); } catch { threw = true; }
  check('a nameless event is rejected', threw);

  check('a timed event reads naturally', eventLabel(clinic) === 'Clinic 8am-12pm', eventLabel(clinic));
  check('an untimed event is just its name',
    eventLabel(cleanEvent({ day_of_week: 3, title: 'Admin' })) === 'Admin');
  check('a clear day produces no line', eventsDigestLine([]) === null);

  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check('the digest lists commitments', /Today: \$\{lines\.join/.test(indexJs));
  check('clinical assignments and personal events share one line',
    /scheduleDigestLine\(clinical, mappings\)[\s\S]{0,120}eventsDigestLine\(todayEvents\)/.test(indexJs));
  check('commitments are deducted from capacity', /capacity - committed/.test(indexJs));
  check('events never enter the task ranking',
    !/rankTasks\([^)]*event/i.test(indexJs));
  check('an events failure cannot break the digest', /safeEventsForToday/.test(indexJs));

  // --- archiving ---
  check('archiving is opt-outable with 0', /keep everything forever/.test(indexJs));
  check('only completed tasks are ever deleted',
    /DELETE FROM tasks WHERE status = 'done'/.test(indexJs));
  check('tasks with no completion date are never deleted',
    /completed_at IS NOT NULL AND completed_at < \?/.test(indexJs));
  check('a lifetime count survives the deletion', /archived_count/.test(indexJs));
  check('the archive runs from the daily cron', /Archive pass failed/.test(indexJs));
  check('an archive failure cannot break the digest',
    /try \{[\s\S]{0,400}runArchive[\s\S]{0,400}catch/.test(indexJs));
  check('a preview is available before deleting', /previewArchive/.test(indexJs));

  const appJs5 = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  check('the destructive action is confirmed first',
    /confirm\(`Permanently delete completed tasks/.test(appJs5));
}

// --- 9. clinical schedule -----------------------------------------------------

async function testSchedule() {
  console.log('\nClinical schedule (ICS)');

  const { parseIcs, parseIcsDate, minutesBetween } = await import('../src/ics.js');
  const { minutesForTitle, entryMinutes, scheduleDigestLine } = await import('../src/schedule.js');

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'SUMMARY:Pulmonary Clinic',
    'DTSTART;TZID=America/Chicago:20260824T080000',
    'DTEND;TZID=America/Chicago:20260824T120000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:MICU Service',
    'DTSTART;VALUE=DATE:20260825', 'DTEND;VALUE=DATE:20260826', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Consult Week',
    'DTSTART;VALUE=DATE:20260831', 'DTEND;VALUE=DATE:20260907', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Very long assignment name that the feed has fol',
    ' ded across two lines',
    'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260902', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcs(ics, { timeZone: 'America/Chicago' });

  check('timed assignments keep their hours',
    events.some((e) => e.date === '2026-08-24' && e.start_time === '08:00' && e.end_time === '12:00'));

  // The classic iCalendar trap: DTEND on an all-day event is exclusive.
  check('a one-day all-day block does not leak into the next day',
    events.filter((e) => e.title === 'MICU Service').length === 1);
  check('and it lands on the right day',
    events.find((e) => e.title === 'MICU Service').date === '2026-08-25');

  check('a week-long block becomes seven days',
    events.filter((e) => e.title === 'Consult Week').length === 7);

  check('folded lines are rejoined, not truncated',
    events.some((e) => e.title.includes('folded across two lines')));

  // A UTC instant must be converted, or every Zulu event shows at the wrong hour.
  check('UTC converts into the local zone',
    parseIcsDate('20260828T140000Z', {}, 'America/Chicago').time === '09:00');
  check('UTC conversion can move the date',
    parseIcsDate('20260828T020000Z', {}, 'America/Chicago').date === '2026-08-27');

  check('malformed dates are rejected', parseIcsDate('garbage') === null);
  check('a feed with no events parses to nothing', parseIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR').length === 0);
  check('junk input does not throw', Array.isArray(parseIcs('not a calendar at all')));

  // --- service hours mapping ---
  const maps = [
    { pattern: 'micu', minutes: 600 },
    { pattern: 'micu nights', minutes: 720 },
    { pattern: 'clinic', minutes: 240 },
  ];
  check('a matching pattern supplies hours', minutesForTitle('MICU Service', maps) === 600);
  check('matching is case-insensitive', minutesForTitle('micu service', maps) === 600);
  check('the most specific pattern wins',
    minutesForTitle('MICU Nights - Attending', maps) === 720);
  check('an unmapped assignment yields nothing', minutesForTitle('Grand Rounds', maps) === null);

  // The mapping beats the feed: real feeds pad assignments to generic coverage
  // windows, so an afternoon clinic arrives as a twelve-hour block.
  check('an explicit mapping overrides the feed times',
    entryMinutes({ title: 'Clinic', start_time: '06:00', end_time: '18:00' }, maps) === 240);
  check('feed times are used when nothing is mapped',
    entryMinutes({ title: 'Grand Rounds', start_time: '08:00', end_time: '09:00' }, maps) === 60);
  check('the mapping supplies hours for all-day entries',
    entryMinutes({ title: 'MICU Service', start_time: null, end_time: null }, maps) === 600);
  check('an unmapped all-day entry costs nothing rather than guessing',
    entryMinutes({ title: 'Unknown', start_time: null, end_time: null }, maps) === 0);

  // The brief must agree with the workload: mapping first, feed times second.
  check('a mapped assignment shows its mapped hours, not the feed window',
    scheduleDigestLine([{ title: 'Clinic', start_time: '06:00', end_time: '18:00' }], maps)
      === 'Clinic (4h)');
  check('an unmapped assignment falls back to the feed window',
    /Grand Rounds 8am-9am/.test(scheduleDigestLine(
      [{ title: 'Grand Rounds', start_time: '08:00', end_time: '09:00' }], maps)));
  check('a zero-hour mapping is listed without implying any hours',
    scheduleDigestLine([{ title: 'Back-up', start_time: '06:00', end_time: '18:00' }],
      [...maps, { pattern: 'back-up', minutes: 0 }]) === 'Back-up');
  check('the brief shows mapped hours for all-day work',
    /MICU Service \(10h\)/.test(scheduleDigestLine(
      [{ title: 'MICU Service', start_time: null, end_time: null }], maps)));
  check('a clear day produces no line', scheduleDigestLine([], maps) === null);

  // --- concurrency ---
  const { clinicalMinutesForDay } = await import('../src/schedule.js');
  const grouped = [
    { pattern: 'icu service', minutes: 660, concurrency_group: 'inpatient' },
    { pattern: 'pager cover', minutes: 660, concurrency_group: 'inpatient' },
    { pattern: 'consult b/u', minutes: 0, concurrency_group: 'inpatient' },
    { pattern: 'cam clinic', minutes: 330, concurrency_group: null },
  ];
  const day = (...titles) => titles.map((t) => ({ title: t, start_time: null, end_time: null }));

  check('one inpatient assignment counts once',
    clinicalMinutesForDay(day('WEEKEND CALL ICU SERVICE'), grouped) === 660);
  check('concurrent inpatient cover is not double counted',
    clinicalMinutesForDay(day('WEEKEND CALL ICU SERVICE', 'WEEKEND PAGER COVER CALL'), grouped) === 660);
  check('a shift split across midnight counts once',
    clinicalMinutesForDay(day('WEEKEND PAGER COVER CALL', 'WEEKEND PAGER COVER CALL'), grouped) === 660);

  // Clinic on top of an inpatient service is a real second commitment.
  check('clinic adds on top of inpatient service',
    clinicalMinutesForDay(day('ICU SERVICE', 'CAM CLINIC PM'), grouped) === 990);
  check('back-up inside the inpatient group adds nothing',
    clinicalMinutesForDay(day('ICU SERVICE', 'CONSULT B/U'), grouped) === 660);
  check('pager cover alone still counts its full hours',
    clinicalMinutesForDay(day('WEEKEND PAGER COVER CALL'), grouped) === 660);
  check('an empty day is zero', clinicalMinutesForDay([], grouped) === 0);

  const indexJs = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  check('the day total respects concurrency, not a plain sum',
    /clinicalMinutesForDay\(clinical, mappings\)/.test(indexJs));
  check('the feed URL is a secret, never a stored field',
    /env\.QGENDA_ICS_URL/.test(indexJs) && !/QGENDA_ICS_URL.*INSERT/.test(indexJs));
  check('a sync failure cannot break the digest', /Schedule refresh failed/.test(indexJs));
  check('the feed refreshes through the day, not only at digest time',
    /hour % REFRESH_HOURS === 0/.test(indexJs));
  check('the periodic refresh runs before the notify-hour gate',
    indexJs.indexOf('hour % REFRESH_HOURS === 0') < indexJs.indexOf('if (hour !== notifyHour) return;'));
  check('a manual sync forces a rewrite', /\{ force: true \}/.test(indexJs));

  const scheduleJs2 = readFileSync(join(ROOT, 'src/schedule.js'), 'utf8');
  check('an unchanged feed skips the database rewrite',
    /schedule_feed_hash/.test(scheduleJs2) && /unchanged: true/.test(scheduleJs2));
  check('the refresh interval matches what the feed asks for', /REFRESH_HOURS = 4/.test(scheduleJs2));
  check('clinical hours count toward committed time',
    /entryMinutes\(e, mappings\)/.test(indexJs));

  const scheduleJs = readFileSync(join(ROOT, 'src/schedule.js'), 'utf8');
  check('webcal is rewritten to https', /webcal:\/\//.test(scheduleJs));
  check('a login page is not mistaken for a calendar',
    /BEGIN:VCALENDAR/.test(scheduleJs));
  check('only future dates are replaced, history is kept',
    /DELETE FROM schedule_days WHERE date >= \?/.test(scheduleJs));
  // Hand-entered series share the table and must survive a feed refresh.
  check('the sync only deletes rows it owns',
    /source = 'qgenda'/.test(scheduleJs));
  check('synced rows are tagged as coming from the feed',
    /'qgenda'\)`/.test(scheduleJs));
}

// --- 10. free time ------------------------------------------------------------

async function testFreeTime() {
  console.log('\nFree time');

  const { toMinutes, toClock, parseBlocks, mergeIntervals, freeWindows, longestFreeWindow } =
    await import('../src/freetime.js');

  check('clock times parse', toMinutes('08:30') === 510);
  check('bad clock times are rejected', toMinutes('99:99') === null);
  check('minutes render back', toClock(510) === '8:30am' && toClock(720) === '12pm');

  const split = parseBlocks('[["08:00","12:00"],["17:00","19:00"]]');
  check('split blocks parse', split.length === 2);
  check('malformed blocks are rejected', parseBlocks('[["nope"]]') === null);
  check('a backwards block is dropped', parseBlocks('[["17:00","09:00"]]') === null);
  check('junk is rejected rather than thrown', parseBlocks('not json') === null);

  check('overlapping intervals merge',
    mergeIntervals([{ start: 420, end: 600 }, { start: 540, end: 720 }]).length === 1);
  // Back-to-back blocks are one stretch of busy, not two with a zero gap.
  check('touching intervals merge',
    mergeIntervals([{ start: 420, end: 600 }, { start: 600, end: 720 }]).length === 1);

  // The whole point: a split day has a usable gap in the middle.
  const pftFree = freeWindows(split);
  check('a split day leaves a real gap', pftFree.some((w) => w.end - w.start === 300));
  const longest = longestFreeWindow(split);
  check('the longest gap is found', longest.start === 720 && longest.end === 1020,
    `${toClock(longest.start)}-${toClock(longest.end)}`);

  // A full service day should not report a fictitious free afternoon.
  const icu = parseBlocks('[["07:00","18:00"]]');
  check('a full day leaves only the evening',
    longestFreeWindow(icu).start === 1080);
  check('a day covering the bounds leaves nothing free',
    longestFreeWindow(parseBlocks('[["06:00","20:00"]]')) === null);

  const scheduleJs3 = readFileSync(join(ROOT, 'src/schedule.js'), 'utf8');
  check('explicit blocks beat a flat minute count', /parseBlocks\(mapping\?\.blocks\)/.test(scheduleJs3));
  check('back-up cover occupies no clock time', /mapping\.minutes === 0\) continue/.test(scheduleJs3));
  check('tentative meetings occupy no clock time', /event\.tentative\) continue/.test(scheduleJs3));
}

// --- 11. Drive backup ---------------------------------------------------------

async function testDriveBackup() {
  console.log('\nGoogle Drive backup');

  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const gdrive = read('src/gdrive.js');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');
  const authScript = read('scripts/google-auth.mjs');

  // The narrow scope is the whole security story here. A stray edit to `drive`
  // would hand a stored token read access to every file in the account.
  check('uses the drive.file scope, not full Drive access',
    /auth\/drive\.file/.test(gdrive) && !/auth\/drive['"\s]/.test(gdrive));
  check('the setup script requests the same narrow scope',
    /auth\/drive\.file/.test(authScript));

  // access_type=offline and prompt=consent together are what make Google
  // return a refresh token. Drop either and setup appears to work, then the
  // backup dies the moment the first access token expires.
  check('the consent request asks for offline access',
    /access_type: 'offline'/.test(authScript));
  check('the consent request forces a fresh grant',
    /prompt: 'consent'/.test(authScript));
  check('the setup script never writes the token to disk',
    !/writeFile|appendFile|createWriteStream/.test(authScript));
  check('secrets reach wrangler on stdin, not as arguments',
    /input: value/.test(authScript) && !/secret', 'put', name, value/.test(authScript));

  check('a missing configuration is reported, not thrown',
    /isConfigured\(env\)\) \{\s*\n\s*return \{ ok: false/.test(gdrive));
  check('old backups are pruned so the folder stays bounded',
    /files\.slice\(keep\)/.test(gdrive));
  check('upload failures come back as a reason rather than an exception',
    /catch \(error\) \{\s*\n\s*return \{ ok: false, reason/.test(gdrive));

  // The export shape is shared so a restored backup matches what the download
  // button produces. Two builders would drift.
  check('one export builder serves both the download and the upload',
    /async function buildExport/.test(indexSrc)
    && (indexSrc.match(/buildExport\(env/g) || []).length >= 2);
  check('backups still exclude device credentials',
    !/'subscriptions'|'sessions'|'auth_attempts'/.test(
      indexSrc.slice(indexSrc.indexOf('async function buildExport'),
        indexSrc.indexOf('async function buildExport') + 600)));

  // Every optional cron step is independently guarded. A Google outage must
  // cost a backup, not the morning digest.
  // Bounded by the next cron step rather than a character count: a fixed
  // window silently stops covering the block as soon as the block grows.
  const cronStart = indexSrc.indexOf('Weekly backup to Drive');
  const cronSlice = indexSrc.slice(cronStart, indexSrc.indexOf('Housekeeping:', cronStart));
  check('the weekly backup is wrapped in its own try/catch',
    /try \{/.test(cronSlice) && /catch \(error\)/.test(cronSlice));
  check('the weekly backup runs on Sundays only',
    /localDayOfWeek\(timezone\) === 0 && driveConfigured\(env\)/.test(indexSrc));
  check('a guard key stops the backup repeating within the day',
    /backup_guard_date/.test(indexSrc));
  check('the cron skips the upload entirely when Drive is not connected',
    /driveConfigured\(env\)/.test(cronSlice) || /&& driveConfigured\(env\)/.test(indexSrc));

  check('a failed backup returns a reason the client can display',
    /error: result\.reason/.test(indexSrc));

  // Settings must show whether the last run worked; a silent backup is
  // indistinguishable from no backup at all.
  check('settings has a place to report backup status',
    /id="backup-status"/.test(htmlSrc));
  check('settings has a manual backup button', /id="backup-now"/.test(htmlSrc));
  check('opening settings refreshes the backup status',
    /await refreshBackupStatus\(\)/.test(appSrc));
  check('the status helper is reachable from openSettings',
    appSrc.indexOf('async function refreshBackupStatus')
      < appSrc.indexOf('async function openSettings'));
  check('the status call uses the api helper prefix correctly',
    /api\('\/backup'/.test(appSrc) && !/api\('\/api\/backup'/.test(appSrc));

  // Exercise the real upload path against a stubbed Google. The failure branch
  // is the one that matters and the one that never runs in practice until the
  // day it does.
  const { backupToDrive } = await import('../src/gdrive.js');
  const env = {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh',
  };
  const realFetch = globalThis.fetch;

  const stub = (routes) => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      calls.push({ href, method: options.method || 'GET' });
      for (const [match, reply] of routes) {
        if (href.includes(match)) return reply(calls.length);
      }
      return new Response('{}', { status: 404 });
    };
    return calls;
  };
  const ok = (body) => () => new Response(JSON.stringify(body), { status: 200 });

  try {
    // A revoked refresh token - the realistic failure.
    stub([['oauth2.googleapis.com/token', () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
      { status: 400 },
    )]]);
    const revoked = await backupToDrive(env, 'b.json', '{}');
    check('a revoked token fails without throwing', revoked.ok === false);
    check('the revoked-token reason is human readable',
      /revoked/i.test(revoked.reason), revoked.reason);

    // Google up, no folder yet: token, search, create folder, upload, list.
    const calls = stub([
      ['oauth2.googleapis.com/token', ok({ access_token: 'at' })],
      ['drive/v3/files/', () => new Response(null, { status: 204 })],
      ['upload/drive/v3/files', ok({ id: 'f1', name: 'b.json', size: '2048' })],
      // Real Drive rows always carry a name, and pruning is scoped by it.
      ['drive/v3/files?q=', (n) => (n === 2
        ? new Response(JSON.stringify({ files: [] }), { status: 200 })
        : new Response(JSON.stringify({
          files: [
            { id: 'f1', name: 'todo-backup-2026-08-30.json' },
            { id: 'old1', name: 'todo-backup-2026-08-23.json' },
            { id: 'old2', name: 'todo-backup-2026-08-16.json' },
          ],
        }), { status: 200 }))],
      ['drive/v3/files?fields=id', ok({ id: 'folder1' })],
    ]);
    const good = await backupToDrive(env, 'todo-backup-2026-08-30.json', '{}', { keep: 1 });
    check('a good run reports success', good.ok === true, good.reason);
    check('the uploaded filename comes back', good.file === 'b.json');
    check('pruning is scoped to the series it just wrote', good.kept === 1);
    check('the folder is created when absent',
      calls.some((c) => c.method === 'POST' && c.href.includes('drive/v3/files?fields=id')));
    check('surplus backups are deleted', good.removed === 2, `removed ${good.removed}`);
    check('the upload is multipart', calls.some((c) => c.href.includes('uploadType=multipart')));

    // A 500 mid-upload must not be reported as a successful backup.
    stub([
      ['oauth2.googleapis.com/token', ok({ access_token: 'at' })],
      ['drive/v3/files?q=', ok({ files: [{ id: 'folder1' }] })],
      ['upload/drive/v3/files', () => new Response(
        JSON.stringify({ error: { message: 'Backend Error' } }), { status: 500 },
      )],
    ]);
    const broken = await backupToDrive(env, 'b.json', '{}');
    check('an upload failure is not reported as success', broken.ok === false);
    check('the upload failure names the cause', /Backend Error/.test(broken.reason), broken.reason);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Alerting.
  check('a failed scheduled backup pushes a notification',
    /if \(!backup\.ok\) await alertBackupFailure/.test(indexSrc));
  check('the alert is scheduled-only, not fired by the manual button',
    (indexSrc.match(/await alertBackupFailure\(env/g) || []).length === 1);
  check('the failure streak resets on a good run',
    /backup_fail_streak', result\.ok \? 0 : streak \+ 1/.test(indexSrc));
  check('the alert carries its own notification tag',
    /tag: 'backup-failure'/.test(indexSrc));
  check('the alert says when the last good backup was',
    /Last good backup/.test(indexSrc));
}


// --- 12. hide until due -------------------------------------------------------

async function testHideUntilDue() {
  console.log('\nHide until due');

  const { isSnoozed, deferredUntil } = await import('../src/recurrence.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');

  const due = (deadline, flag = 1) => ({ deadline, hide_until_due: flag, snoozed_until: null });

  check('a flagged task is hidden before its deadline',
    isSnoozed(due('2026-08-30'), '2026-08-24') === true);
  check('it becomes visible on the day itself',
    isSnoozed(due('2026-08-30'), '2026-08-30') === false);
  check('it stays visible once overdue',
    isSnoozed(due('2026-08-30'), '2026-09-02') === false);
  check('an unflagged task with a future deadline is unaffected',
    isSnoozed(due('2026-08-30', 0), '2026-08-24') === false);
  check('the flag without a deadline hides nothing',
    isSnoozed(due(null), '2026-08-24') === false);

  // An explicit snooze has to win, or snoozing a flagged task past its
  // deadline would silently do nothing.
  check('an explicit snooze overrides the flag',
    deferredUntil({ deadline: '2026-08-30', hide_until_due: 1, snoozed_until: '2026-09-15' })
      === '2026-09-15');
  check('the flag supplies the date when there is no snooze',
    deferredUntil(due('2026-08-30')) === '2026-08-30');
  check('a visible task defers to nothing', deferredUntil(due('2026-08-30', 0)) === null);

  // The whole point: the next occurrence must inherit it, or the task
  // reappears early one week later and the fix looks like it did not take.
  const recurBlock = indexSrc.slice(indexSrc.indexOf('async function scheduleNextOccurrence'),
    indexSrc.indexOf('The backup payload'));
  check('a recurring task carries the flag to its next occurrence',
    /hide_until_due/.test(recurBlock));

  check('creating a task accepts the flag', /hide_until_due: input\.hide_until_due \? 1 : 0/.test(indexSrc));
  check('editing a task can turn the flag off',
    /hide_until_due = \?/.test(indexSrc));
  check('the All tab labels a flagged task by its deadline',
    /snoozeLabel\(deferredUntil\(t\), today\)/.test(indexSrc));

  check('the form has the checkbox', /id="f-hide-until-due"/.test(htmlSrc));
  check('the form loads the current value',
    /\$\('f-hide-until-due'\)\.checked = Boolean/.test(appSrc));
  check('the form submits the value', /hide_until_due: \$\('f-hide-until-due'\)\.checked/.test(appSrc));

  // Every list goes through isSnoozed, which is why one change covers the
  // ranked list, the digest, the workload total, Upcoming and the evening nudge.
  check('all task lists still funnel through the one visibility check',
    (indexSrc.match(/isSnoozed\(t, /g) || []).length >= 6);
}

// --- 13. restore --------------------------------------------------------------

/**
 * A D1-shaped wrapper over a real in-memory SQLite database.
 *
 * Mocking the database would only prove restore.js calls the methods it calls.
 * Running the actual SQL is what catches a column that does not exist, a bad
 * placeholder count, or a DELETE that hits the wrong table.
 */
function fakeD1(sqlite) {
  const touched = [];
  const prepare = (sql) => {
    touched.push(sql);
    let bound = [];
    const self = {
      bind: (...args) => { bound = args; return self; },
      all: async () => ({ results: sqlite.prepare(sql).all(...bound) }),
      first: async () => sqlite.prepare(sql).get(...bound) ?? null,
      run: async () => { sqlite.prepare(sql).run(...bound); return { success: true }; },
    };
    return self;
  };
  return {
    prepare,
    batch: async (stmts) => Promise.all(stmts.map((st) => st.run())),
    statements: touched,
  };
}

async function testRestore() {
  console.log('\nRestore');

  const { DatabaseSync } = await import('node:sqlite');
  const { inspectExport, restoreExport, RESTORABLE } = await import('../src/restore.js');

  // --- validation, which is the only thing standing between a stray JSON
  // --- file and the destruction of every task.
  check('a non-object is rejected', inspectExport('nope').ok === false);
  check('null is rejected', inspectExport(null).ok === false);
  check('a foreign JSON file is rejected',
    inspectExport({ some: 'other app' }).ok === false);
  check('a backup with no data section is rejected',
    inspectExport({ app: 'todo' }).ok === false);
  check('an empty backup is rejected',
    inspectExport({ app: 'todo', data: { tasks: [] } }).ok === false);
  check('a table that is not a list is rejected',
    inspectExport({ app: 'todo', data: { tasks: { nope: 1 } } }).ok === false);
  check('the rejection explains itself',
    /not produced by this app/.test(inspectExport({ app: 'other', data: {} }).errors.join(' ')));

  const good = {
    app: 'todo',
    exported_at: '2026-08-30T11:00:00.000Z',
    schema_version: 10,
    data: {
      tasks: [
        { id: 't1', title: 'Kept', status: 'open', deadline: '2026-09-01', hide_until_due: 1 },
        { id: 't2', title: 'Done one', status: 'done', deadline: '2026-08-02' },
      ],
      meta: [
        { key: 'timezone', value: 'America/Chicago' },
        { key: 'notify_hour', value: '6' },
        { key: 'backup_guard_date', value: '2026-08-30' },
        { key: 'last_digest_date', value: '2026-08-30' },
      ],
    },
  };

  const seen = inspectExport(good);
  check('a real backup passes inspection', seen.ok === true, seen.errors.join(' '));
  check('the summary counts open tasks', seen.summary.openTasks === 1);
  check('the summary reports the export date',
    seen.summary.exportedAt.startsWith('2026-08-30'));
  check('the summary spans the deadlines',
    seen.summary.deadlineRange.first === '2026-08-02'
    && seen.summary.deadlineRange.last === '2026-09-01');

  // --- restoring into a live schema.
  const build = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT,
             deadline TEXT, hide_until_due INTEGER DEFAULT 0);`);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
    db.exec('CREATE TABLE subscriptions (id TEXT PRIMARY KEY, endpoint TEXT);');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, hash TEXT);');
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run('old', 'Should vanish', 'open', null, 0);
    db.prepare('INSERT INTO subscriptions VALUES (?,?)').run('dev1', 'https://push');
    db.prepare('INSERT INTO sessions VALUES (?,?)').run('s1', 'abc');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('daily_capacity', '480');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('backup_guard_date', '2026-09-06');
    return db;
  };

  // Dry run must not write. This is what the confirm dialog relies on.
  const dry = build();
  const dryEnv = { DB: fakeD1(dry) };
  const preview = await restoreExport(dryEnv, good, { dryRun: true });
  check('a dry run reports what it would do', preview.restored.tasks === 2);
  check('a dry run writes nothing',
    dry.prepare('SELECT COUNT(*) n FROM tasks').get().n === 1);
  check('a dry run issues no DELETE',
    !dryEnv.DB.statements.some((sql) => /^DELETE/.test(sql)));

  const live = build();
  const result = await restoreExport({ DB: fakeD1(live) }, good);
  check('the restore reports success', result.ok === true, JSON.stringify(result.errors));

  const tasks = live.prepare('SELECT * FROM tasks ORDER BY id').all();
  check('pre-existing tasks are replaced, not merged', tasks.length === 2);
  check('the backup rows are actually there', tasks[0].id === 't1' && tasks[1].id === 't2');
  check('column values survive the round trip', tasks[0].hide_until_due === 1);
  check('the old row is gone',
    live.prepare("SELECT COUNT(*) n FROM tasks WHERE id='old'").get().n === 0);

  // The whole reason restore is safe to offer: it cannot sign you out or stop
  // the 6am notification.
  check('push subscriptions are never touched',
    live.prepare('SELECT COUNT(*) n FROM subscriptions').get().n === 1);
  check('sessions are never touched',
    live.prepare('SELECT COUNT(*) n FROM sessions').get().n === 1);
  check('subscriptions and sessions are not even restorable',
    !RESTORABLE.includes('subscriptions') && !RESTORABLE.includes('sessions'));

  // meta merges rather than replaces, and runtime keys stay put.
  check('user settings come back from the backup',
    live.prepare("SELECT value FROM meta WHERE key='timezone'").get().value === 'America/Chicago');
  check('settings absent from the backup are preserved',
    live.prepare("SELECT value FROM meta WHERE key='daily_capacity'").get().value === '480');
  check('runtime guard keys are not overwritten by stale ones',
    live.prepare("SELECT value FROM meta WHERE key='backup_guard_date'").get().value === '2026-09-06');
  check('the skipped runtime keys are reported', result.skippedMetaKeys === 2);

  // Schema drift, both directions.
  const older = new DatabaseSync(':memory:');
  older.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, deadline TEXT);');
  older.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  const drift = await restoreExport({ DB: fakeD1(older) }, good);
  check('a newer backup restores into an older schema', drift.ok === true,
    JSON.stringify(drift.errors));
  check('the unknown column is dropped, not fatal',
    drift.skippedColumns.tasks?.includes('hide_until_due') === true);
  check('the rows still land',
    older.prepare('SELECT COUNT(*) n FROM tasks').get().n === 2);

  // --- the endpoint contract.
  const indexSrc = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  check('restoring requires an explicit confirmation',
    /body\?\.confirm !== true/.test(indexSrc));
  check('the current state is snapshotted before being destroyed',
    /'pre-restore'/.test(indexSrc));
  check('the client asks twice - summary, then a confirm dialog',
    /confirm\(/.test(appSrc) && /confirm: true/.test(appSrc));
  check('the destructive button is marked as such', /btn full danger/.test(
    readFileSync(join(ROOT, 'public/index.html'), 'utf8')));

  // The pre-restore snapshot lives in the same Drive folder as the weekly
  // backups. Pruning them as one series meant a few restores could evict
  // months of real backups.
  const gdriveSrc = readFileSync(join(ROOT, 'src/gdrive.js'), 'utf8');
  check('retention is scoped to one filename series',
    /startsWith\(prefix\)/.test(gdriveSrc));
  check('pre-restore snapshots keep their own small budget',
    /prefix === 'pre-restore' \? 3 : 12/.test(indexSrc));
  check('a stale schedule hash cannot survive a restore',
    /schedule_feed_hash/.test(readFileSync(join(ROOT, 'src/restore.js'), 'utf8')));

  // Prove the scoping with the real upload code against a stubbed Drive.
  const { backupToDrive } = await import('../src/gdrive.js');
  const driveEnv = {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'r',
  };
  const realFetch = globalThis.fetch;
  const deleted = [];
  const folder = [
    { id: 'w1', name: 'todo-backup-2026-08-23.json' },
    { id: 'w2', name: 'todo-backup-2026-08-16.json' },
    { id: 'w3', name: 'todo-backup-2026-08-09.json' },
    { id: 'p1', name: 'pre-restore-2026-08-24.json' },
  ];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    }
    if (href.includes('upload/drive/v3/files')) {
      return new Response(JSON.stringify({ id: 'new', name: 'x', size: '10' }), { status: 200 });
    }
    if ((options.method || 'GET') === 'DELETE') {
      deleted.push(href.split('/').pop());
      return new Response(null, { status: 204 });
    }
    if (href.includes('drive/v3/files?q=')) {
      return new Response(JSON.stringify({ files: folder }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  try {
    await backupToDrive(driveEnv, 'pre-restore-2026-08-25.json', '{}',
      { keep: 3, prefix: 'pre-restore' });
    check('a pre-restore snapshot never deletes a weekly backup',
      deleted.every((id) => id.startsWith('p')), `deleted ${deleted.join(',') || 'nothing'}`);

    deleted.length = 0;
    await backupToDrive(driveEnv, 'todo-backup-2026-08-30.json', '{}', { keep: 2 });
    check('weekly pruning ignores the pre-restore series',
      !deleted.includes('p1'), `deleted ${deleted.join(',')}`);
    check('weekly pruning still trims its own series', deleted.includes('w3'));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 14. folder names ---------------------------------------------------------

async function testFolderNames() {
  console.log('\nFolder names');

  const { buildDigest, DEFAULT_FOLDER_LABELS } = await import('../src/rank.js');
  const { cleanFolderLabel, MAX_FOLDER_LABEL, CATEGORIES } = await import('../src/index.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');

  // --- validation. A blank name must never reach a tab.
  check('a name is trimmed', cleanFolderLabel('  Family  ', 'Personal') === 'Family');
  check('an empty name falls back', cleanFolderLabel('', 'Personal') === 'Personal');
  check('whitespace only falls back', cleanFolderLabel('   ', 'Personal') === 'Personal');
  check('null falls back', cleanFolderLabel(null, 'Fitness') === 'Fitness');
  check('inner whitespace collapses', cleanFolderLabel('Side  Projects', 'Work') === 'Side Projects');
  check('a long name is capped',
    cleanFolderLabel('x'.repeat(50), 'Work').length === MAX_FOLDER_LABEL);
  check('the ids themselves never change',
    CATEGORIES.join(',') === 'personal,work,fitness');

  // --- the digest. This is the bug that already existed: anything that was
  // --- not 'work' got labelled "Personal", so fitness tasks lied.
  const today = '2026-08-24';
  const mixed = [
    { id: 'a', title: 'Sign reports', category: 'work', deadline: today, priority: 1, status: 'open' },
    { id: 'b', title: 'Endurance ride', category: 'fitness', deadline: today, priority: 2, status: 'open' },
    { id: 'c', title: 'Call home', category: 'personal', deadline: today, priority: 2, status: 'open' },
  ];

  const plain = buildDigest(mixed, today);
  check('a fitness task is no longer called Personal in the digest',
    /Fitness . Endurance ride/.test(plain.body), plain.body.replace(/\n/g, ' | '));

  const renamed = buildDigest(mixed, today, { work: 'Clinical', personal: 'Home', fitness: 'Training' });
  check('the digest uses the renamed folders',
    /Clinical . Sign reports/.test(renamed.body) && /Training . Endurance ride/.test(renamed.body),
    renamed.body.replace(/\n/g, ' | '));
  check('renaming does not change the task titles',
    /Sign reports/.test(renamed.body) && /Call home/.test(renamed.body));

  // A single-folder day still omits the prefix - renaming must not turn that on.
  const workOnly = buildDigest([mixed[0]], today, { work: 'Clinical' });
  check('one folder in play still means no prefix', !/Clinical . /.test(workOnly.body),
    workOnly.body);

  check('the defaults are still the three original names',
    DEFAULT_FOLDER_LABELS.work === 'Work'
    && DEFAULT_FOLDER_LABELS.personal === 'Personal'
    && DEFAULT_FOLDER_LABELS.fitness === 'Fitness');

  // --- storage semantics.
  check('names are stored as one blob, not three keys',
    /setSetting\(env, 'folder_labels', JSON\.stringify\(next\)\)/.test(indexSrc));
  check('a partial update keeps the other two names',
    /incoming\[id\] === undefined\s*\n\s*\? current\[id\]/.test(indexSrc));
  check('corrupt stored JSON falls back rather than throwing',
    /catch \{\s*\n\s*stored = \{\};/.test(indexSrc));
  check('a non-object payload is rejected',
    /folderLabels must be an object/.test(indexSrc));
  check('the names reach the client through config',
    /folderLabels: await folderLabels\(env\)/.test(indexSrc));
  check('saving echoes back what was actually stored',
    /\.\.\.\(await settings\(env\)\), folderLabels: await folderLabels\(env\)/.test(indexSrc));

  // Names are a preference, so a restore should bring them back.
  check('folder names are restored from a backup, not treated as runtime state',
    !/folder_labels/.test(read('src/restore.js')));

  // --- the client.
  check('the tabs carry a nameable span', /id="tab-name-work"/.test(htmlSrc)
    && /id="tab-name-personal"/.test(htmlSrc) && /id="tab-name-fitness"/.test(htmlSrc));
  check('the new-task menu is nameable too', /id="opt-fitness"/.test(htmlSrc));
  check('settings has the three inputs', /id="s-folder-work"/.test(htmlSrc)
    && /id="s-folder-personal"/.test(htmlSrc) && /id="s-folder-fitness"/.test(htmlSrc));
  check('the inputs cap length in the browser as well as the server',
    (htmlSrc.match(/maxlength="14"/g) || []).length >= 3);
  check('the labels are applied on load', /applyFolderLabels\(config\.folderLabels\)/.test(appSrc));
  check('the tabs and the menu are both updated',
    /tab-name-\$\{id\}/.test(appSrc) && /opt-\$\{id\}/.test(appSrc));
  check('saving sends the three names', /folderLabels: \{/.test(appSrc));
  check('the width warning exists', /checkFolderWidth/.test(appSrc)
    && /id="folder-width-warning"/.test(htmlSrc));

  // The threshold comes from a measurement, not a guess: three nine-letter
  // names overflowed the row in the mockup, "Work/Personal/Fitness" did not.
  check('the width warning triggers above 24 characters',
    /total <= 24/.test(appSrc));
  check('the default names sit under the warning threshold',
    'Work'.length + 'Personal'.length + 'Fitness'.length <= 24);

  // Folder names are a preference you set once and then live with, so they
  // belong near the top - above device management, not buried by it.
  const headings = [...htmlSrc.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  check('folder names sit above both device sections',
    headings.indexOf('Folder names') < headings.indexOf('Devices')
    && headings.indexOf('Folder names') < headings.indexOf('Signed-in devices'),
    headings.join(' > '));
  check('the morning notification stays first',
    headings.indexOf('Morning notification') === 0, headings.join(' > '));

  check('the demo ships renamed, so the feature is visible',
    /folder_labels: JSON\.stringify\(\{ work: 'Clinical'/.test(read('src/demo.js')));
}

// --- 15. demo lock screen -----------------------------------------------------

async function testDemoLock() {
  console.log('\nDemo lock screen');

  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const appSrc = read('public/app.js');
  const indexSrc = read('src/index.js');

  // The prefill is cosmetic by design. If it ever becomes an auth bypass, the
  // demo stops being a faithful copy and the real app inherits the branch.
  check('the passphrase is prefilled only on the demo hostname',
    /location\.hostname\.split\('\.'\)\[0\] !== 'demo'\) return;/.test(appSrc));
  check('the prefill does not overwrite something already typed',
    /if \(input && !input\.value\) input\.value = 'demo';/.test(appSrc));
  check('the lock screen is still shown, not skipped',
    /\$\('lock'\)\.hidden = false;/.test(appSrc));
  check('nothing bypasses authorize()',
    !/DEMO_MODE[^\n]*authorize|authorize[^\n]*DEMO_MODE/.test(indexSrc));
  check('the demo passphrase is never hard-coded server-side',
    !/APP_PASSWORD\s*=\s*'demo'|'demo'\s*===\s*env\.APP_PASSWORD/.test(indexSrc));

  // A public passphrase makes a failed attempt meaningless, and the alert
  // would reach demo visitors rather than the owner.
  check('the lockout alert is suppressed on the demo',
    /failure\.shouldAlert && env\.DEMO_MODE !== 'true'/.test(indexSrc));
  check('the real app still gets the alert',
    /sendSecurityAlert\(env, ip, failure\.failures/.test(indexSrc));
  // Public demo, public passphrase: anyone can fill it with nonsense, so the
  // only real control is how long that nonsense survives.
  check('the demo reseeds every six hours, not once a day',
    /env\.DEMO_MODE === 'true' && hour % 6 === 0/.test(indexSrc));
  check('the reseed guard is per window, so the half-hourly cron cannot double up',
    /const window = `\$\{date\}-\$\{hour\}`/.test(indexSrc));
  check('demo bookkeeping keys are not restored from a backup',
    /'demo_reset_window', 'demo_reset_date', 'demo_seeded_at'/.test(read('src/restore.js')));

  // Without a real file the SPA fallback answers /robots.txt with HTML, which
  // is worse than nothing - crawlers get a page instead of a directive.
  const robots = read('public/robots.txt');
  check('a real robots.txt exists', /User-agent: \*/.test(robots));
  check('it disallows everything', /Disallow: \/\s*$/m.test(robots));

  // Rate limiting is only as good as the identity it counts against.
  const authSrc = read('src/auth.js');
  // Matches the header being *read*, not the comment explaining why it is not.
  // A bare /X-Forwarded-For/ here passed on the prose and failed on the code.
  check('the client IP cannot be supplied by the client',
    !/headers\.get\(['"]X-Forwarded-For/.test(authSrc),
    'X-Forwarded-For is caller-controlled');
  check('it falls back to one shared bucket, not to a forgeable value',
    /'CF-Connecting-IP'\) \|\| 'unknown'/.test(authSrc));

  check('lockout itself still applies on the demo',
    /const lockout = await checkLockout\(env, ip\);/.test(indexSrc)
    && !/checkLockout[^\n]*DEMO_MODE/.test(indexSrc));
}

// --- 16. backup encryption ----------------------------------------------------

async function testBackupEncryption() {
  console.log('\nBackup encryption');

  const {
    encryptBackup, decryptBackup, isEncryptedBackup, toBase64, fromBase64,
    MAGIC, DEFAULT_ITERATIONS,
  } = await import('../src/backup-crypto.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');

  const pass = 'anchor-bramble-cinder-dapple-ember-fathom';
  const payload = JSON.stringify({
    app: 'todo', exported_at: '2026-08-30T11:00:00.000Z',
    data: { tasks: [{ id: 't1', title: 'Sign outstanding PFT reports' }] },
  });

  const sealed = await encryptBackup(pass, payload);

  check('a sealed backup round-trips', await decryptBackup(pass, sealed) === payload);
  check('it is recognisable as ours', isEncryptedBackup(sealed));
  check('plain JSON is not mistaken for sealed',
    !isEncryptedBackup(new TextEncoder().encode(payload)));

  // The whole point: the storage provider holds something it cannot read.
  const asText = Buffer.from(sealed).toString('latin1');
  check('no task title survives in the ciphertext',
    !asText.includes('PFT reports') && !asText.includes('todo'));
  check('base64 armour also leaks nothing',
    !toBase64(sealed).includes(Buffer.from('PFT').toString('base64').slice(0, 4)));

  await (async () => {
    let refused = false;
    try { await decryptBackup('wrong', sealed); } catch { refused = true; }
    check('the wrong passphrase is refused', refused);
  })();

  // AES-GCM is authenticated, so a single flipped bit must fail rather than
  // quietly restoring corrupted data over everything you own.
  await (async () => {
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 5] ^= 1;
    let refused = false;
    try { await decryptBackup(pass, tampered); } catch { refused = true; }
    check('a single altered byte is detected', refused);
  })();

  await (async () => {
    // A corrupt header must not be able to ask for hours of key derivation.
    const bomb = new Uint8Array(sealed);
    new DataView(bomb.buffer).setUint32(8, 4_000_000_000, false);
    let refused = false;
    try { await decryptBackup(pass, bomb); } catch (e) { refused = /implausible/.test(e.message); }
    check('an absurd iteration count is rejected, not attempted', refused);
  })();

  check('base64 survives a round trip',
    toBase64(fromBase64(toBase64(sealed))) === toBase64(sealed));
  check('the iteration count meets the OWASP floor', DEFAULT_ITERATIONS >= 600_000);
  check('the format is versioned', MAGIC === 'TODOBK02');

  // Cloudflare rejects a single PBKDF2 call above 100,000 iterations, and
  // local workerd does NOT enforce that - so this only ever failed in
  // production. The target is reached by chaining rounds under the cap.
  const cryptoSrc = read('src/backup-crypto.js');
  check('no single PBKDF2 call exceeds the platform cap',
    /iterations: perRound/.test(cryptoSrc) && /MAX_ITERATIONS_PER_ROUND = 100_000/.test(cryptoSrc));
  check('rounds are chained, each feeding the next',
    /material = new Uint8Array\(await crypto\.subtle\.deriveBits/.test(cryptoSrc));
  check('the per-round count stays within the cap',
    Math.ceil(DEFAULT_ITERATIONS / Math.ceil(DEFAULT_ITERATIONS / 100_000)) <= 100_000);
  check('the comment records why, so nobody "simplifies" it back',
    /iteration counts above 100000/.test(cryptoSrc));

  // A passphrase guarding a file in cloud storage faces offline guessing, so
  // it needs real entropy - the first version of this shipped ~34 bits.
  const setterSrc = read('scripts/set-backup-passphrase.mjs');
  check('the generator produces at least 100 bits',
    /const CHARS = 24;/.test(setterSrc) && /ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'/.test(setterSrc));
  check('the weak word-list generator is gone', !/WORDS = \[/.test(setterSrc));

  // Every parameter needed to open the file must live in the file.
  const iterations = new DataView(sealed.buffer, sealed.byteOffset + 8, 4).getUint32(0, false);
  check('the header carries its own iteration count', iterations === DEFAULT_ITERATIONS);
  check('each backup gets a fresh salt and iv', await (async () => {
    const second = await encryptBackup(pass, payload);
    return toBase64(sealed.slice(8, 40)) !== toBase64(second.slice(8, 40));
  })());

  // --- wiring.
  check('the Worker seals before uploading, not after',
    /body = toBase64\(await encryptBackup\(env\.BACKUP_PASSPHRASE, body\)\)/.test(indexSrc));
  check('a sealed file is named so you can tell', /filename \+= '\.enc'/.test(indexSrc));
  check('backups still work with no passphrase set',
    /if \(env\.BACKUP_PASSPHRASE\) \{/.test(indexSrc));
  check('restore accepts a sealed file', /if \(body\?\.encrypted\)/.test(indexSrc));
  check('restore explains itself when the server has no passphrase',
    /no BACKUP_PASSPHRASE is set on the server/.test(indexSrc));
  check('settings reports whether backups are sealed',
    /encrypted: Boolean\(env\.BACKUP_PASSPHRASE\)/.test(indexSrc));
  check('the client detects a sealed file before parsing it as JSON',
    /TODOBK01/.test(appSrc));

  // The escape hatch. A backup only the app can open is not a backup.
  const tool = read('scripts/decrypt-backup.mjs');
  check('a standalone decrypt tool exists', /decryptBackup/.test(tool));
  check('it shares the Worker’s implementation rather than copying it',
    /from '\.\.\/src\/backup-crypto\.js'/.test(tool));
  check('it never writes the passphrase anywhere', !/writeFile\(.*passphrase/i.test(tool));

  const setter = read('scripts/set-backup-passphrase.mjs');
  check('the passphrase setter pipes to wrangler on stdin',
    /input: passphrase/.test(setter));
  check('it makes you confirm you saved it', /"saved"/.test(setter));
  check('it warns that loss is unrecoverable', /cannot be opened/.test(setter));
}

// --- 17. import and export ----------------------------------------------------

async function testInterchange() {
  console.log('\nImport and export');

  const { tasksToCsv, tasksToMarkdown, parseCsv, rowsToTasks, CSV_COLUMNS,
    importTasks, detectFormat, sniffDelimiter } = await import('../src/interchange.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');

  const labels = { work: 'Clinical', personal: 'Home', fitness: 'Training' };
  const tasks = [
    { title: 'Call Smith, then Jones', notes: 'Says "urgent"', category: 'work',
      deadline: '2026-09-01', priority: 1, estimate_minutes: 30, status: 'open',
      recur: null, subtasks: '[{"text":"Find number","done":true}]' },
    { title: 'Line\nbreak', notes: '', category: 'personal', deadline: null,
      priority: 2, estimate_minutes: null, status: 'done', recur: 'weekly', subtasks: '[]' },
  ];

  // --- the values that break naive CSV code.
  const csv = tasksToCsv(tasks, labels);
  const back = rowsToTasks(parseCsv(csv), { labels });
  check('a comma inside a title survives', back.tasks[0].title === 'Call Smith, then Jones');
  check('a quote inside notes survives', back.tasks[0].notes === 'Says "urgent"');
  check('a newline inside a title survives', back.tasks[1].title === 'Line\nbreak');
  check('folder labels map back to ids', back.tasks[0].category === 'work');
  check('completed status survives', back.tasks[1].status === 'done');
  check('subtask done-state survives',
    back.tasks[0].subtasks[0].done === true && back.tasks[0].subtasks[0].text === 'Find number');
  check('the header names every column', parseCsv(csv)[0].join(',') === CSV_COLUMNS.join(','));

  // --- other people's exports.
  const todoist = rowsToTasks(parseCsv(
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,DATE\ntask,Renew licence,Board paperwork,1,2026-09-15\n'));
  check('a Todoist-shaped export maps by column name',
    todoist.tasks[0].title === 'Renew licence' && todoist.tasks[0].deadline === '2026-09-15');
  check('its description becomes notes', todoist.tasks[0].notes === 'Board paperwork');

  const human = rowsToTasks(parseCsv('title,due\nBook flights,Sep 20 2026\n'));
  check('a human-written date is understood', human.tasks[0].deadline === '2026-09-20');

  const bare = rowsToTasks(parseCsv('Mow the lawn\nCall the plumber\n'));
  check('a bare list with no header works', bare.tasks.length === 2
    && bare.tasks[0].title === 'Mow the lawn');

  // --- one bad row must not cost the whole file.
  const messy = rowsToTasks(parseCsv('title,due\nGood,2026-09-01\n,2026-09-02\nAlso good,\n'));
  check('a row with no title is skipped, not fatal', messy.tasks.length === 2);
  check('the skip reports its line number', messy.skipped[0].line === 3);

  check('an unknown folder falls back rather than inventing one',
    rowsToTasks(parseCsv('title,folder\nX,Nonsense\n')).tasks[0].category === 'personal');
  check('an absurd estimate is dropped',
    rowsToTasks(parseCsv('title,estimate\nX,not a number\n')).tasks[0].estimate_minutes === null);

  // --- markdown is for reading, not round-tripping.
  const md = tasksToMarkdown(tasks, labels, '2026-08-25');
  check('markdown groups by folder', /## Clinical/.test(md));
  check('markdown lists open tasks as checkboxes', /- \[ \] Call Smith/.test(md));
  check('markdown separates completed', /## Completed \(1\)/.test(md));
  check('markdown nests subtasks', /  - \[x\] Find number/.test(md));

  // --- the endpoints, and the distinction that matters.
  check('export serves csv and markdown', /format === 'markdown'/.test(indexSrc)
    && /text\/csv; charset=utf-8/.test(indexSrc));
  check('importing tasks INSERTs rather than deleting',
    /INSERT INTO tasks \(id, title, notes, category, deadline, start_time, priority, estimate_minutes,\s*\n\s*status, recur, subtasks, hide_until_due/.test(indexSrc));
  const importBlock = indexSrc.slice(indexSrc.indexOf("path === '/api/import/tasks'"),
    indexSrc.indexOf("// --- restore"));
  check('the task import never issues a DELETE', !/DELETE/.test(importBlock));
  check('it previews before writing', /body\.confirm !== true/.test(importBlock));
  check('recurrence from a foreign file is validated',
    /cleanRecur\(t\.recur\)/.test(importBlock));

  check('settings offers both exports', /id="export-csv"/.test(htmlSrc)
    && /id="export-md"/.test(htmlSrc));
  check('settings offers the additive import', /id="import-file"/.test(htmlSrc));
  check('the UI says import adds rather than replaces',
    /adds<\/strong> tasks, it never/.test(htmlSrc));
  check('the client confirms before importing', /confirm: true/.test(appSrc));

  // --- formats beyond comma-separated. Each of these silently produced
  // --- garbage tasks before detection existed: a Markdown heading became a
  // --- task called "## Work", and a tab-separated file became one column.
  check('a semicolon file is detected', sniffDelimiter('title;due\nX;2026-01-01') === ';');
  check('a tab file is detected', sniffDelimiter('title\tdue\nX\t2026-01-01') === '\t');
  check('a comma inside quotes does not win the sniff',
    sniffDelimiter('"Smith, Jones";due') === ';');

  check('markdown is recognised',
    detectFormat('## Work\n- [ ] Renew licence\n- [x] Sign reports') === 'markdown');
  check('json is recognised', detectFormat('[{"title":"X"}]') === 'json');
  check('a spreadsheet with one stray checkbox is still csv',
    detectFormat('title,notes\nA,b\nC,d\nE,f\nG,- [ ] h') === 'csv');

  const semi = importTasks('title;due\nMow lawn;2026-09-01\nCall plumber;', { labels });
  check('a semicolon export imports correctly',
    semi.tasks.length === 2 && semi.tasks[0].title === 'Mow lawn');

  const mdIn = importTasks('# Tasks\n\n## Clinical\n\n- [ ] Renew licence _(due 2026-09-15, 30m, high)_\n'
    + '  - [x] Find form\n- [x] Sign reports\n\n## Completed (1)\n\n- [x] Old thing', { labels });
  check('markdown headings become folders, not tasks',
    mdIn.tasks.every((t) => !t.title.startsWith('#')));
  check('markdown yields the right task count', mdIn.tasks.length === 3, `got ${mdIn.tasks.length}`);
  check('a markdown folder heading is applied', mdIn.tasks[0].category === 'work');
  check('markdown metadata is read back',
    mdIn.tasks[0].deadline === '2026-09-15' && mdIn.tasks[0].estimate_minutes === 30
    && mdIn.tasks[0].priority === 1);
  check('an indented checkbox becomes a subtask',
    mdIn.tasks[0].subtasks.length === 1 && mdIn.tasks[0].subtasks[0].done === true);
  check('a completed markdown item keeps its status', mdIn.tasks[1].status === 'done');

  const json = importTasks('[{"title":"Renew licence","deadline":"2026-09-15"}]', { labels });
  check('a JSON array imports', json.tasks.length === 1 && json.tasks[0].deadline === '2026-09-15');
  const wrapped = importTasks('{"app":"todo","data":{"tasks":[{"title":"From backup"}]}}', { labels });
  check('our own backup shape is accepted as JSON', wrapped.tasks[0].title === 'From backup');

  // Refusing is a feature. Guessing produced nonsense tasks nobody asked for.
  await (async () => {
    let refused = false;
    try { importTasks('lorem {} <<>> ;;;\n{"nope":1}\n### heading'); } catch { refused = true; }
    check('an unreadable file is refused, not guessed at', refused);
  })();
  await (async () => {
    let refused = false;
    try { importTasks('[{"nope":1}]'); } catch { refused = true; }
    check('JSON objects with no title are refused', refused);
  })();

  // Both exports must survive a round trip, estimate included - the alias
  // table normalised headers but not itself, so estimates were silently lost.
  const one = { title: 'Renew licence', notes: '', category: 'work', deadline: '2026-09-15',
    priority: 1, estimate_minutes: 30, status: 'open', recur: null,
    subtasks: '[{"text":"Find form","done":true}]' };
  for (const [name, text] of [
    ['csv', tasksToCsv([one], labels)],
    ['markdown', tasksToMarkdown([one], labels, '2026-08-25')],
  ]) {
    const t = importTasks(text, { labels }).tasks[0];
    check(`${name} round-trips the estimate`, t.estimate_minutes === 30);
    check(`${name} round-trips the deadline`, t.deadline === '2026-09-15');
    check(`${name} round-trips the folder`, t.category === 'work');
    check(`${name} round-trips the subtask`, t.subtasks.length === 1);
  }

  check('the endpoint refuses unreadable files with a 400',
    /A file we cannot read is refused outright/.test(indexSrc));
  check('the picker accepts every supported extension',
    /\.csv,\.tsv,\.txt,\.md,\.markdown,\.json,\.ics/.test(htmlSrc));

  // --- iCalendar. VTODO is the standard's own to-do component and is what
  // --- Apple Reminders and any CalDAV client export.
  const ics = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');

  const todoFile = ics(
    'BEGIN:VTODO', 'UID:1', 'SUMMARY:Renew board certification',
    'DESCRIPTION:Gather CME first', 'DUE;VALUE=DATE:20260915', 'PRIORITY:1',
    'CATEGORIES:Clinical', 'STATUS:NEEDS-ACTION', 'END:VTODO',
    'BEGIN:VTODO', 'UID:2', 'SUMMARY:Buy milk', 'STATUS:COMPLETED',
    'PERCENT-COMPLETE:100', 'END:VTODO',
    'BEGIN:VTODO', 'UID:3', 'SUMMARY:Low thing', 'PRIORITY:9', 'END:VTODO');

  check('an ics file is detected', detectFormat(todoFile) === 'ics');
  const todos = importTasks(todoFile, { labels });
  check('VTODO is preferred over events', todos.icsKind === 'VTODO');
  check('VTODO summary becomes the title', todos.tasks[0].title === 'Renew board certification');
  check('VTODO description becomes notes', todos.tasks[0].notes === 'Gather CME first');
  check('a VALUE=DATE due date is read', todos.tasks[0].deadline === '2026-09-15');
  check('CATEGORIES maps to a renamed folder', todos.tasks[0].category === 'work');
  // RFC 5545 runs 1 (highest) to 9 (lowest), which is neither our scale nor
  // any app's UI - getting this backwards would silently invert priorities.
  check('RFC priority 1 is high', todos.tasks[0].priority === 1);
  check('RFC priority 9 is low', todos.tasks[2].priority === 3);
  check('STATUS:COMPLETED becomes done', todos.tasks[1].status === 'done');

  const eventFile = ics(
    'BEGIN:VEVENT', 'UID:e1', 'SUMMARY:Grand Rounds', 'DTSTART;VALUE=DATE:20260901',
    'DTEND;VALUE=DATE:20260902', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e2', 'SUMMARY:Teaching', 'DTSTART:20260903T120000Z',
    'DTEND:20260903T130000Z', 'END:VEVENT');
  const events = importTasks(eventFile, { labels });
  check('a calendar with no to-dos falls back to events', events.icsKind === 'VEVENT');
  check('each event becomes one task', events.tasks.length === 2);
  check('the event date becomes the deadline', events.tasks[0].deadline === '2026-09-01');

  await (async () => {
    let refused = false;
    try { importTasks(ics()); } catch { refused = true; }
    check('an empty calendar is refused, not imported as nothing', refused);
  })();

  // The schedule sync must keep ignoring VTODOs - a feed's to-dos are not
  // clinical assignments.
  const { parseIcs: parseEvents } = await import('../src/ics.js');
  check('the schedule parser still ignores VTODO',
    parseEvents(todoFile).length === 0);
}

// --- 18. camera capture -------------------------------------------------------

async function testVision() {
  console.log('\nCamera capture');

  const { readImage, DEFAULT_MODEL, MAX_IMAGE_BYTES } = await import('../src/vision.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const visionSrc = read('src/vision.js');
  const indexSrc = read('src/index.js');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');

  const env = { ANTHROPIC_API_KEY: 'test-key' };
  const realFetch = globalThis.fetch;
  const args = { base64: 'AAAA', mediaType: 'image/jpeg', todayISO: '2026-08-25', timezone: 'America/Chicago' };

  const stub = (handler) => { globalThis.fetch = handler; };
  const toolReply = (input) => new Response(JSON.stringify({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'record_what_you_see', input }],
  }), { status: 200 });

  const FULL = {
    found: true, kind: 'event', title: 'Grand Rounds - ILD', date: '2026-09-15',
    time: '08:00', end_time: '09:00', location: 'Moore Auditorium', notes: '',
    confidence: 'high', contains_personal_data: false,
  };

  try {
    // --- request shape. Getting these wrong fails only in production.
    let sent = null;
    stub(async (url, opts) => { sent = { url, opts: JSON.parse(opts.body), headers: opts.headers }; return toolReply(FULL); });
    const ok = await readImage(env, args);

    check('a clean reading comes back ok', ok.ok === true, ok.error);
    check('the title is carried through', ok.data.title === 'Grand Rounds - ILD');
    check('the date is carried through', ok.data.date === '2026-09-15');
    check('it posts to the messages endpoint',
      sent.url === 'https://api.anthropic.com/v1/messages');
    check('the api version header is sent', sent.headers['anthropic-version'] === '2023-06-01');
    check('the key travels in x-api-key, not Authorization',
      sent.headers['x-api-key'] === 'test-key' && !sent.headers.Authorization);
    check('the model defaults to Opus 5', sent.opts.model === 'claude-opus-5' && DEFAULT_MODEL === 'claude-opus-5');
    check('the tool is forced, so the reply is always structured',
      sent.opts.tool_choice.type === 'tool' && sent.opts.tool_choice.name === 'record_what_you_see');
    check('the tool schema is strict', sent.opts.tools[0].strict === true);
    check('strict schemas must close additionalProperties',
      sent.opts.tools[0].input_schema.additionalProperties === false);
    // Disabling thinking on Opus 5 can put a tool call into visible text
    // instead of a tool_use block; low effort is the supported way to keep it
    // cheap.
    check('thinking is left on, with effort lowered instead',
      !('thinking' in sent.opts) && sent.opts.output_config.effort === 'low');

    // Haiku 4.5 and Sonnet 4.5 reject `effort` outright, and the demo runs on
    // Haiku - so sending it unconditionally broke the demo's camera entirely
    // while the owner's own app (on Opus) worked fine.
    stub(async (url, opts) => { sent = { opts: JSON.parse(opts.body) }; return toolReply(FULL); });
    await readImage({ ...env, VISION_MODEL: 'claude-haiku-4-5' }, args);
    check('effort is omitted for a model that rejects it',
      !('output_config' in sent.opts), JSON.stringify(sent.opts.output_config));
    check('the model itself is still honoured', sent.opts.model === 'claude-haiku-4-5');

    await readImage({ ...env, VISION_MODEL: 'claude-sonnet-4-6' }, args);
    check('effort is still sent to a model that accepts it',
      sent.opts.output_config?.effort === 'low');
    check('the image is sent as base64 with its media type',
      sent.opts.messages[0].content[0].source.media_type === 'image/jpeg');
    check("today's date is given so relative dates resolve",
      /2026-08-25/.test(sent.opts.messages[0].content[1].text));

    // --- the guardrail this feature exists under.
    stub(async () => toolReply({ ...FULL, contains_personal_data: true }));
    const flagged = await readImage(env, args);
    check('an image with personal details is flagged', flagged.data.containsPersonalData === true);
    check('the endpoint refuses a flagged image rather than filing it',
      /blocked: true/.test(indexSrc) && /image has been discarded/.test(indexSrc));
    check('the schema tells the reader to err towards flagging',
      /Err towards true/.test(visionSrc));
    check('a flagged reading is never transcribed into other fields',
      /do not transcribe such/i.test(visionSrc));

    // --- failure modes.
    stub(async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 }));
    const refused = await readImage(env, args);
    check('a safety refusal is handled, not treated as success', refused.ok === false);

    stub(async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 }));
    const failed = await readImage(env, args);
    check('an API error surfaces its message', failed.ok === false && /overloaded/.test(failed.error));

    stub(async () => { throw new Error('network down'); });
    const offline = await readImage(env, args);
    check('a network failure does not throw', offline.ok === false && /Could not reach/.test(offline.error));

    stub(async () => toolReply({ ...FULL, found: false, kind: 'none', title: '' }));
    const nothing = await readImage(env, args);
    check('an unreadable photo reports found=false', nothing.data.found === false);

    // --- never trust the returned shape, even under strict tool use.
    stub(async () => toolReply({ ...FULL, date: 'next Tuesday', time: '25:99', confidence: 'certain' }));
    const junk = await readImage(env, args);
    check('a non-ISO date is dropped rather than stored', junk.data.date === null);
    check('an impossible time is dropped', junk.data.time === null);
    check('an unknown confidence falls back to low', junk.data.confidence === 'low');

    const noKey = await readImage({}, args);
    check('a missing API key is reported clearly',
      noKey.ok === false && /ANTHROPIC_API_KEY/.test(noKey.error));

    const huge = await readImage(env, { ...args, base64: 'A'.repeat(MAX_IMAGE_BYTES * 2) });
    check('an oversized image is rejected before the call', huge.ok === false);

    const wrongType = await readImage(env, { ...args, mediaType: 'application/pdf' });
    check('a non-image type is rejected', wrongType.ok === false);
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- wiring and privacy posture.
  check('the endpoint creates nothing itself',
    !/INSERT INTO tasks/.test(indexSrc.slice(indexSrc.indexOf("path === '/api/vision'"),
      indexSrc.indexOf('// --- import / export'))));
  check('the photo is never written to the database',
    /never\s*\n?\s*\/\/\s*written to the database/.test(indexSrc)
    || /held only for the duration of this request/.test(indexSrc));

  // app.js wires listeners onto these at load; a missing one throws and takes
  // the whole app down. The camera markup silently failed to insert once
  // already, so assert every id the client reaches for.
  for (const id of ['camera-row', 'camera-input', 'camera-result', 'camera-status',
    'camera-fields', 'cam-title', 'cam-date', 'cam-category', 'cam-notes',
    'cam-save', 'cam-cancel']) {
    check(`the markup defines #${id}`, htmlSrc.includes(`id="${id}"`));
  }
  check('the camera button only appears where a key is set',
    /camera: Boolean\(env\.ANTHROPIC_API_KEY\)/.test(indexSrc) && /if \(config\.camera\)/.test(appSrc));
  check('capture opens the camera rather than the photo library',
    /capture="environment"/.test(htmlSrc));
  check('the photo is shrunk before upload', /createImageBitmap/.test(appSrc)
    && /1568/.test(appSrc));
  check('the confirmed task goes through the ordinary create path',
    /api\('\/tasks', \{\s*\n\s*method: 'POST'/.test(appSrc));
  check('a low-confidence reading is called out', /hard to read/.test(appSrc));

  // --- the reader classifies; the client used to throw that answer away and
  // --- file everything as a task, so a Grand Rounds poster became a to-do.
  check('the schema asks which kind it is',
    /An "event" happens at a time; a "task" is something to do by a date/.test(visionSrc));
  check('the classification survives normalisation',
    /kind: \['event', 'task', 'none'\]\.includes\(input\.kind\)/.test(visionSrc));
  check('the client honours it', /\$\('cam-is-event'\)\.checked = r\.kind === 'event'/.test(appSrc));
  check('an event photo posts to the events endpoint',
    /if \(asEvent\) \{[\s\S]{0,120}api\('\/events'/.test(appSrc));
  check('a task photo still posts to tasks',
    /\} else \{[\s\S]{0,160}api\('\/tasks'/.test(appSrc));
  check('the times the reader found are carried over',
    /\$\('cam-start'\)\.value = r\.time \|\| ''/.test(appSrc));
  check('the guess is correctable before saving', /id="cam-is-event"/.test(htmlSrc));
  // A task can be pinned to an hour now, so the start time is offered for
  // both kinds. Only the end time is event-only - a task with an end time
  // would just be an event.
  check('the end time is event-only, the folder is task-only',
    /\$\('cam-end'\)\.closest\('\.field'\)\.hidden = !isEvent;[\s\S]{0,140}\$\('cam-category'\)\.closest\('\.field'\)\.hidden = isEvent/.test(appSrc));
  check('a photographed task keeps the time it was read from',
    /deadline: \$\('cam-date'\)\.value \|\| null,\s*\n\s*start_time: \$\('cam-start'\)\.value \|\| null/.test(appSrc));
  check('the toast says which was created',
    /asEvent \? 'Event added from photo' : 'Added from photo'/.test(appSrc));

  // Zero runtime dependencies is a property of this project, not an accident.
  check('no SDK dependency was introduced',
    !/@anthropic-ai\/sdk/.test(read('package.json')));

  // --- the spend ceiling. Every reading costs money on a real card, and the
  // --- demo is public, so this is the difference between a feature and a bill.
  const capBlock = indexSrc.slice(indexSrc.indexOf("path === '/api/vision'"),
    indexSrc.indexOf('// --- import / export'));
  check('a daily limit is enforced before the API is called',
    capBlock.indexOf('used >= limit') < capBlock.indexOf('readImage(env'));
  check('the counter resets on a new day', /usedDay === today \? Number/.test(capBlock));
  check('exceeding the limit returns 429, not a silent failure',
    /is the daily limit[\s\S]{0,80}429/.test(capBlock));
  check('the demo gets a lower ceiling by default',
    /env\.DEMO_MODE === 'true' \? 25 : 50/.test(capBlock));
  // The published repo ships wrangler.demo.example.toml; a live install renames
  // it. Read whichever exists rather than crashing the suite on a clone.
  const demoConfig = ['wrangler.demo.toml', 'wrangler.demo.example.toml']
    .map((f) => { try { return read(f); } catch { return null; } })
    .find(Boolean) ?? '';
  check('a demo config is present to check', demoConfig.length > 0);
  check('the demo reads on the cheaper model',
    /VISION_MODEL = "claude-haiku-4-5"/.test(demoConfig));
  check('the demo ceiling is set explicitly too',
    /VISION_DAILY_LIMIT = "25"/.test(demoConfig));
  check('the usage counter is not restored from a backup',
    /'vision_day', 'vision_used'/.test(read('src/restore.js')));

  // --- every row action must be reachable with a mouse.
  //
  // Hover revealed only the right-hand strip, so "Later" was unreachable
  // without a touchscreen: the action existed, was styled, was wired to a
  // working handler, and no amount of hovering brought it in.
  const css = read('public/styles.css');
  check('the row has a left-edge hover target', /class="later-zone"/.test(appSrc));
  check('the zone is positioned down the left edge',
    /\.later-zone \{[\s\S]{0,140}inset: 0 auto 0 0;[\s\S]{0,60}width: 56px/.test(css));
  // Above the card so it catches the pointer, below the strips (z-index 2) so
  // the Later button is clickable once it slides in over the zone.
  check('the zone sits below the action strips',
    /\.later-zone \{[\s\S]{0,180}z-index: 1;/.test(css));
  check('hovering the zone opens the Later strip',
    /\.later-zone:hover ~ \.task-later/.test(css));
  check('hovering the strip keeps it open, so the two cannot flicker',
    /\.task-later:hover \{[\s\S]{0,60}transform: translateX\(0\)/.test(css)
    || /\.task-later:hover \{/.test(css) || /\.task-later:hover,?/.test(css));
  check('the main actions stay out while the left edge is hovered',
    /:hover:not\(:has\(\.later-zone:hover\)\) \.task-actions/.test(css));
  check('all of this is gated to pointer devices',
    css.indexOf('@media (hover: hover) and (pointer: fine)') < css.indexOf('.later-zone:hover ~ .task-later'));
  check('the duplicate third button is gone', !/swipe-action later/.test(appSrc));
  check('the touch swipe strip is untouched', /class="task-later"/.test(appSrc));

  // "Later" named no duration and silently meant tomorrow, so nobody could
  // tell what it would do. Each option now says so.
  for (const [preset, label] of [['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'],
    ['nextweek', 'Next week']]) {
    check(`snooze offers "${label}"`,
      new RegExp(`data-preset="${preset}">${label}<`).test(appSrc));
  }
  check('the vague "Later" wording is gone', !/>Later</.test(appSrc));
  check('a snoozed row still offers Unhide', /data-later="\$\{task\.id\}">Unhide</.test(appSrc));
  check('every preset the UI offers is one the server understands',
    ['tomorrow', 'weekend', 'nextweek'].every((p) =>
      new RegExp(`preset === '${p}'`).test(read('src/recurrence.js'))));
  check('the strip widened to hold three options', /--later-width: 210px/.test(css));

  // Two rows: a label saying what the strip is, then the durations. Without
  // the label the three buttons said "Tomorrow / Weekend / Next week" with no
  // indication of what would happen to the task.
  check('the strip is labelled "Snooze"', /class="later-title">\$\{task\.snoozed \? 'Snoozed' : 'Snooze'\}/.test(appSrc));
  check('the label is not clickable', /<span class="later-title"/.test(appSrc)
    && !/<button class="later-title"/.test(appSrc));
  check('the strip stacks label over options', /\.task-later \{[\s\S]{0,220}flex-direction: column;/.test(css));
  check('the options sit in their own row', /\.later-options \{ flex: 1; display: flex;/.test(css));
  check('the options are visually separated',
    /\.task-later button \+ button \{ box-shadow: inset/.test(css));
  check('the hint no longer says "hide until later"', !/hide until later/.test(htmlSrc));
  check('one handler still serves it',
    (appSrc.match(/closest\('\[data-later\]'\)/g) || []).length === 1);

  // A silent no-op sed left the service worker at v22 through a dozen deploys,
  // so every one of them shipped assets that browsers kept serving from cache.
  const sw = read('public/sw.js');
  const bump = read('scripts/bump-cache.mjs');
  check('the cache name is still parseable', /todo-shell-v(\d+)/.test(sw));
  check('a script owns the bump rather than a hand-written sed',
    /todo-shell-v\\d\+/.test(bump));
  check('deploying bumps the cache first',
    /bump-cache\.mjs && wrangler deploy/.test(read('package.json')));

  // --- the systemic version of the bug above.
  //
  // app.js reaches for elements by id at load. One that does not exist returns
  // null, the listener call throws, start() dies, and the user sees a blank
  // screen with no error - the same failure mode as the lock overlay months
  // ago. Checking every id is cheap; discovering this in the app is not.
  const referenced = [...appSrc.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1]);
  // Some ids are rendered by app.js itself and then queried back, which is
  // fine; only ids that exist in neither place are the bug.
  const createdByClient = new Set(
    [...appSrc.matchAll(/id="([a-z0-9-]+)"/gi)].map((m) => m[1]),
  );
  const missing = [...new Set(referenced)]
    .filter((id) => !htmlSrc.includes(`id="${id}"`) && !createdByClient.has(id));
  check('every element app.js reaches for exists in the markup',
    missing.length === 0, missing.join(', '));
}

// --- 19. events by typing -----------------------------------------------------

async function testTypedEvents() {
  console.log('\nEvents by typing');

  const { parseQuickAdd } = await import('../public/parse.js');
  const { cleanEvent, cleanEventDate } = await import('../src/events.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const appSrc = read('public/app.js');
  const eventsSrc = read('src/events.js');
  const indexSrc = read('src/index.js');

  const T = '2026-08-25';
  const p = (s) => parseQuickAdd(s, T);

  // --- a time RANGE is what marks something as occupying the day. A single
  // --- time must stay a task, or every "call the lab 3pm" habit breaks.
  const oneOff = p('Dinner with the Harrisons sept 12 7-9pm');
  check('a dated time range is a one-off event', oneOff.kind === 'event');
  check('its date is read', oneOff.date === '2026-09-12');
  check('its times are read', oneOff.time === '19:00' && oneOff.endTime === '21:00');
  check('it does not repeat', oneOff.repeatsWeekly === false);

  const weekly = p('Grand Rounds every thursday 8-9am');
  check('"every <weekday>" plus a range is a weekly event', weekly.kind === 'event');
  check('the weekday is resolved', weekly.repeatsWeekly === true && weekly.dayOfWeek === 4);
  check('24h conversion is right', weekly.time === '08:00' && weekly.endTime === '09:00');

  check('a 24-hour range works too',
    p('Journal club every tuesday 12:00-13:00').time === '12:00');

  // The behaviour that must NOT change.
  const timedTask = p('Call the lab friday 3pm');
  check('a single time is still a task', timedTask.kind !== 'event');
  check('but the time is no longer thrown away', timedTask.time === '15:00');
  const recurTask = p('Sign reports every thursday');
  check('recurring with no time stays a task', recurTask.kind !== 'event');
  check('and keeps its weekly recurrence', recurTask.recur === 'weekly');
  check('a plain line is still a task', p('Buy milk').kind !== 'event');
  check('a date with no time is still a task', p('Renew licence sept 15').kind !== 'event');

  // --- storage. A dated row is a one-off; a dateless one recurs.
  check('a valid date is accepted', cleanEventDate('2026-09-12') === '2026-09-12');
  check('nonsense is rejected', cleanEventDate('next tuesday') === null);
  check('an empty date means weekly', cleanEventDate('') === null);

  const dated = cleanEvent({ title: 'Dinner', date: '2026-09-12', start_time: '19:00' });
  check('a dated event keeps its date', dated.date === '2026-09-12');
  // 12 Sept 2026 is a Saturday; day_of_week is derived so the two cannot disagree.
  check('its weekday is derived, not supplied', dated.day_of_week === 6);
  const supplied = cleanEvent({ title: 'X', date: '2026-09-12', day_of_week: 1 });
  check('a supplied weekday cannot contradict the date', supplied.day_of_week === 6);
  check('a weekly event still has no date',
    cleanEvent({ title: 'Rounds', day_of_week: 4 }).date === null);

  // --- the day lookup must return both kinds, and a one-off must not recur.
  check('the day query matches weekly rows by weekday',
    /date IS NULL AND day_of_week = \?/.test(eventsSrc));
  check('and one-off rows by exact date',
    /date IS NOT NULL AND date = \?/.test(eventsSrc));
  check('the date reaches the query', /eventsForDay\(env, dayOfWeek, dateISO/.test(eventsSrc));
  // The invariant is that no caller omits the date - counting them meant the
  // check went stale the moment a third one was added, which is the opposite
  // of what a regression test is for.
  const eventCalls = indexSrc.match(/safeEventsForToday\([^)]*\)/g) || [];
  check(`every safeEventsForToday call passes a date (${eventCalls.length} call sites)`,
    eventCalls.length >= 2
    && eventCalls.every((c) => /safeEventsForToday\(env, timezone, (todayISO|today)\)/.test(c)
      || /todayISO = null/.test(c)));
  check('the insert stores the date', /INSERT INTO events \(id, date, day_of_week/.test(eventsSrc));

  // --- the client routes by kind, and the guess is correctable.
  check('an event posts to the events endpoint', /api\('\/events', \{/.test(appSrc));
  check('a weekly event sends a weekday, a one-off a date',
    /p\.repeatsWeekly\s*\n?\s*\? \{ day_of_week: p\.dayOfWeek \}\s*\n?\s*: \{ date:/.test(appSrc));
  check('the preview says which it will create', /\$\{isEvent \? 'Event' : 'Task'\}/.test(appSrc));
  check('and offers to flip it', /id="quick-flip"/.test(appSrc));
  check('the override wins over the guess',
    /quickKindOverride \|\| \(p\.kind === 'event'/.test(appSrc));
  check('typing again re-makes the guess',
    /quickKindOverride = null;\s*\n\s*renderQuickPreview\(\);/.test(appSrc));
  check('the flip listener is delegated, since the preview is rebuilt',
    /\$\('quick-preview'\)\.addEventListener\('click'/.test(appSrc));

  // --- an event added for Thursday must be visible before Thursday. Upcoming
  // --- showed only the rostered schedule, so a typed appointment vanished
  // --- until the morning brief on the day itself.
  check('the server sends one-off events ahead of today',
    /upcomingEvents: \(await upcomingEvents\(env, today, 21\)/.test(indexSrc));
  check('the query returns only dated rows',
    /date IS NOT NULL AND date > \? AND date <= \?/.test(eventsSrc));
  check('weekly commitments are not repeated into every future day',
    /Weekly commitments are deliberately excluded/.test(eventsSrc));
  check('the client keeps them', /let upcomingEvents = \[\]/.test(appSrc));
  check('and renders them in Upcoming', /clinical-row is-event/.test(appSrc));
  // Within a day the order runs from what cannot move to what can.
  check('ordering puts rostered work first, then appointments, then tasks',
    /KIND_ORDER = \{ clinical: 0, event: 1, task: 2 \}/.test(appSrc));

  // --- "next clear day" read only the roster, so it once announced a day as
  // --- clear while the same screen listed an appointment on it.
  const schedSrc = read('src/schedule.js');
  check('free-day detection loads events', /SELECT date, day_of_week, start_time, end_time, tentative FROM events/.test(schedSrc));
  check('a day is only clear when nothing occupies it',
    /clinicalMinutesForDay\(byDate\.get\(iso\) \?\? \[\], mappings\) === 0\s*\n\s*&& eventMinutesOn\(iso, weekday\) === 0/.test(schedSrc));
  check('both weekly and one-off events are counted',
    /weekly\.get\(weekday\) \?\? \[\]/.test(schedSrc) && /oneOff\.get\(iso\) \?\? \[\]/.test(schedSrc));
  check('the weekend check passes the right weekdays',
    /isClear\(iso, 6\) && isClear\(sunday, 0\)/.test(schedSrc));
  // A tentative commitment reports zero minutes, so it must not block a day.
  check('tentative commitments still leave a day clear',
    /tentative commitment reports zero minutes/.test(schedSrc));

  // --- every row in Coming up must read as the same family. The restyle put
  // --- the panel on --surface-2, which left task rows on --surface standing
  // --- out as white cards among grey ones.
  const upcomingCss = read('public/styles.css');
  check('a task row shares the recessed background',
    /\.upcoming-task \{[\s\S]{0,220}background: var\(--surface-2\)/.test(upcomingCss));
  check('and the same padding as a rostered row',
    /\.upcoming-task \{[\s\S]{0,220}padding: 9px 13px/.test(upcomingCss));
  check('every row carries a dot, so titles line up',
    (appSrc.match(/class="clinical-dot"/g) || []).length === 3);
  // Solid = fixed commitment, hollow = a task, legible before the chip is read.
  check('a task dot is hollow',
    /\.upcoming-task \.clinical-dot \{[\s\S]{0,120}background: transparent/.test(upcomingCss));
  check('an appointment dot is the event hue',
    /\.clinical-row\.is-event \.clinical-dot \{ background: var\(--hue-slate\)/.test(upcomingCss));
}

/**
 * The second audit pass: six things that were individually small and all had
 * the same shape - the app knew something and then failed to say it, or said
 * something it did not mean.
 */
async function testSecondPass() {
  console.log('\nSecond pass');

  const { cleanEvent } = await import('../src/events.js');
  const { buildDigest, timeLabel } = await import('../src/rank.js');
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');
  const cssSrc = read('public/styles.css');
  const eventsSrc = read('src/events.js');
  const indexSrc = read('src/index.js');
  const demoSrc = read('src/demo.js');

  // --- 1. a one-off must never read as a weekly commitment -------------------
  check('the calendar list separates the two kinds',
    /Every week/.test(appSrc) && /Just once/.test(appSrc));
  check('a one-off is stamped with its date, not its weekday',
    /const when = e\.date \? shortDate\(e\.date\) : EV_DAYS\[e\.day_of_week\]/.test(appSrc));
  check('shortDate says which one it is', /Thu 27 Aug/.test(appSrc) || /getUTCDate\(\)/.test(appSrc));
  // Matching a spent appointment on weekday alone lit it up every week after.
  check('today is matched by date for a one-off, weekday for a weekly',
    /once\.map\(\(e\) => eventRow\(e, e\.date === today\.date\)\)/.test(appSrc)
    && /weekly\.map\(\(e\) => eventRow\(e, e\.day_of_week === today\.day_of_week\)\)/.test(appSrc));
  check('the server sends today’s date, not only its weekday',
    /today: \{ day_of_week: localDayOfWeek\(timezone\), date: today \}/.test(indexSrc));
  check('the one-off stamp gets room for a date', /\.event-day\.is-once \{/.test(cssSrc));

  // --- past one-offs are spent, and must not accumulate ----------------------
  check('past one-offs are purged', /export async function purgePastEvents/.test(eventsSrc));
  check('the purge only ever touches dated rows',
    /DELETE FROM events WHERE date IS NOT NULL AND date < \?/.test(eventsSrc));
  check('a weekly commitment is never purged by it',
    !/DELETE FROM events WHERE date IS NULL/.test(eventsSrc));
  check('housekeeping runs it daily', /const gone = await purgePastEvents\(env, date\)/.test(indexSrc));
  check('the list hides them even before the purge runs',
    /WHERE date IS NULL OR \? IS NULL OR date >= \?/.test(eventsSrc));
  // Weekly rows in weekday order, one-offs in date order. Sorting a one-off by
  // its derived weekday was what scattered it through the weekly pattern.
  check('the two kinds are ordered by different things',
    /ORDER BY \(date IS NOT NULL\),\s*\n\s*CASE WHEN date IS NULL THEN day_of_week END,\s*\n\s*date,/.test(eventsSrc));

  // --- 2. Settings can create a one-off, not only a weekly commitment --------
  check('the day list offers a one-off first',
    /<option value="once">Just once/.test(appSrc));
  check('and labels the rest as repeating', /Every \$\{d\}/.test(appSrc));
  check('a date field exists for it', /id="ev-date"/.test(htmlSrc));
  check('it is shown only for a one-off',
    /const once = \$\('ev-day'\)\.value === 'once';\s*\n\s*\$\('ev-date'\)\.hidden = !once/.test(appSrc));
  check('a one-off will not post without a date',
    /if \(once && !\$\('ev-date'\)\.value\)/.test(appSrc));
  // Sending both would create a way for the date and the weekday to disagree.
  check('it sends a date or a weekday, never both',
    /\.\.\.\(once \? \{ date: \$\('ev-date'\)\.value \} : \{ day_of_week: Number\(\$\('ev-day'\)\.value\) \}\)/.test(appSrc));

  // --- 3. the date is an editable field like any other ----------------------
  check('updateEvent sets the date',
    /UPDATE events SET date = \?, day_of_week = \?/.test(eventsSrc));
  check('and binds it', /\.bind\(e\.date, e\.day_of_week, e\.title/.test(eventsSrc));

  // --- 4. a task keeps a time it was told ------------------------------------
  check('timeLabel reads a time as a person would',
    timeLabel('15:00') === '3pm' && timeLabel('09:30') === '9:30am'
    && timeLabel('00:00') === '12am' && timeLabel('12:00') === '12pm');
  check('and refuses nonsense rather than inventing',
    timeLabel(null) === null && timeLabel('25:00') === null && timeLabel('bad') === null);
  check('the schema has somewhere to put it',
    /start_time\s+TEXT,\s+-- HH:MM, optional time of day/.test(read('schema.sql')));
  check('there is a migration for existing databases',
    /ALTER TABLE tasks ADD COLUMN start_time TEXT;/.test(read('migrations/013-task-time.sql')));
  check('cleanTask validates it the same way an event does',
    /start_time: cleanTime\(input\.start_time\)/.test(indexSrc));
  // The preview showed the time back as confirmation and the request dropped
  // it - claiming to have understood something and then discarding it.
  check('quick add sends the time it showed you',
    /start_time: p\.time \|\| null,\s*\n\s*priority: p\.priority/.test(appSrc));
  check('the full form has a time field', /id="f-start"/.test(htmlSrc));
  check('it round-trips through the form',
    /\$\('f-start'\)\.value = task\?\.start_time \|\| ''/.test(appSrc)
    && /start_time: \$\('f-start'\)\.value \|\| null/.test(appSrc));
  check('it is editable over the API',
    /'deadline', 'start_time', 'priority'/.test(indexSrc));
  check('the task row shows it', /const at = timeLabel\(task\.start_time\)/.test(appSrc));
  check('the chip is styled quietly beside the deadline', /\.chip\.at-time \{/.test(cssSrc));
  // A weekly 3pm task that came back at no particular time would be a silent
  // downgrade of something you set deliberately.
  check('a repeating task keeps its time on the next occurrence',
    /nextDeadline, task\.start_time \?\? null,/.test(indexSrc));
  const digest = buildDigest([
    { id: 'a', status: 'open', title: 'Call the lab', deadline: '2026-08-25',
      start_time: '15:00', priority: 2, category: 'work', created_at: '2026-08-25' },
  ], '2026-08-25');
  check('the morning brief announces the time', /\(due today, 3pm\)/.test(digest.body));
  const plain = buildDigest([
    { id: 'b', status: 'open', title: 'Read the paper', deadline: null,
      priority: 2, category: 'work', created_at: '2026-08-25' },
  ], '2026-08-25');
  check('and says nothing extra when there is no time', /^1\. Read the paper$/m.test(plain.body));
  // An event still owns the end time; a task with one would just be an event.
  check('a task has no end time', !/end_time: \$\('f-/.test(appSrc));

  // --- a time that dies on export is the same bug one step later ------------
  const { tasksToCsv, tasksToMarkdown, importTasks, CSV_COLUMNS } = await import('../src/interchange.js');
  const timed = [{
    title: 'Call the lab', notes: '', category: 'work', deadline: '2026-08-28',
    start_time: '15:00', priority: 2, estimate_minutes: 10, status: 'open',
    recur: null, subtasks: '[]', completed_at: null,
  }];
  check('csv exports the time', CSV_COLUMNS.includes('start_time')
    && /,15:00,/.test(tasksToCsv(timed, { work: 'Work' })));
  const roundTripped = importTasks(tasksToCsv(timed, { work: 'Work' })).tasks[0];
  check('and reads it back unchanged', roundTripped.start_time === '15:00'
    && roundTripped.deadline === '2026-08-28');
  check('markdown shows it', /at 15:00/.test(tasksToMarkdown(timed, { work: 'Work' }, '2026-08-25')));
  // Another app's export will not use our column name or our clock format.
  const foreign = importTasks('Task,Due,Start\nDrop off the form,2026-09-01,3pm\n').tasks[0];
  check('a foreign header and a 12-hour clock still land',
    foreign.start_time === '15:00' && foreign.deadline === '2026-09-01');
  // parseIcsDate always resolved this; there was nowhere to put it.
  const fromIcs = importTasks(
    ['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'SUMMARY:Renew licence',
      'DUE:20260901T150000', 'END:VTODO', 'END:VCALENDAR'].join('\r\n')).tasks[0];
  check('a VTODO due time becomes the task time', fromIcs.start_time === '15:00');
  check('an unreadable time is refused, not guessed',
    importTasks('title,start\nX,half past three\n').tasks[0].start_time === null);
  check('a task with no time is unaffected',
    importTasks('title,due\nY,2026-09-01\n').tasks[0].start_time === null);

  // --- 5. the demo shows what the app can actually do ------------------------
  check('the demo seeds one-off dates', /const DEMO_ONE_OFFS = \[/.test(demoSrc));
  check('they are relative to when it was seeded',
    /const date = shift\(todayISO, e\.in_days\)/.test(demoSrc));
  check('their weekday is derived, never supplied',
    /const dow = new Date\(`\$\{date\}T00:00:00Z`\)\.getUTCDay\(\)/.test(demoSrc));
  check('a demo task carries a time', /start_time: '15:00'/.test(demoSrc));
  // seedDemo wipes before it inserts, so a duplicate id does not merely skip a
  // row - the INSERT throws partway and the demo is left half-empty until the
  // next reset six hours later. A reused 'demo-9' did exactly that.
  const demoIds = [...demoSrc.matchAll(/id: '(demo-[a-z0-9-]+)'/g)].map((m) => m[1]);
  const duplicated = demoIds.filter((id, i) => demoIds.indexOf(id) !== i);
  check(`every demo id is unique${duplicated.length ? ` (reused: ${[...new Set(duplicated)].join(', ')})` : ''}`,
    duplicated.length === 0 && demoIds.length > 15);

  // --- the README documents a rule; the parser must actually follow it -------
  // A README example that stopped being true is the same failure as a preview
  // that shows a time and drops it: the app claiming something it does not do.
  const { parseQuickAdd } = await import('../public/parse.js');
  const TUE = '2026-08-25';
  const kindOf = (line) => {
    const r = parseQuickAdd(line, TUE);
    return { kind: r.kind === 'event' ? 'event' : 'task', ...r };
  };
  const range = kindOf('Dinner sep 12 7pm-9:30pm');
  check('a time range makes a one-off event',
    range.kind === 'event' && range.repeatsWeekly === false
    && range.date === '2026-09-12' && range.time === '19:00' && range.endTime === '21:30');
  const everyWeek = kindOf('Clinic every tuesday 8am-12pm');
  check('"every" plus a range makes a weekly commitment',
    everyWeek.kind === 'event' && everyWeek.repeatsWeekly === true && everyWeek.dayOfWeek === 2);
  const single = kindOf('Call the lab friday 3pm');
  check('a single time stays a task and keeps the time',
    single.kind === 'task' && single.deadline === '2026-08-28' && single.time === '15:00');
  const repeating = kindOf('Grand rounds every thursday 8am');
  check('a repeating task keeps both its rule and its time',
    repeating.kind === 'task' && repeating.recur === 'weekly' && repeating.time === '08:00');
  const readme = read('README.md');
  check('the README documents the rule it actually implements',
    /A time range makes an event; a\s*\n?single time makes a task/.test(readme));
  for (const example of ['Dinner sep 12 7pm-9:30pm', 'Clinic every tuesday 8am-12pm',
    'Call the lab friday 3pm', 'Grand rounds every thursday 8am']) {
    check(`the README example "${example}" is in the README`, readme.includes(example));
  }

  // --- 6. no unreachable endpoints that still fire real pushes ---------------
  check('the unwired test endpoints are gone',
    !/'\/api\/test-evening'/.test(indexSrc) && !/'\/api\/test-review'/.test(indexSrc));
  check('the digests they fired are still sent by cron',
    /await sendEveningNudge\(env, date\)/.test(indexSrc)
    && /await sendWeeklyReview\(env, date\)/.test(indexSrc));
  check('the one endpoint with a button behind it stays',
    /path === '\/api\/test-push'/.test(indexSrc));

  // --- third pass: what the live app showed once it was actually looked at ---

  // Four renderings of the same fact on one screen read as four kinds of fact.
  check('one helper renders every time span', /function timeRange\(start, end\)/.test(appSrc));
  const tr = new Function(
    appSrc.match(/function timeLabel[\s\S]*?\n}/)[0]
    + appSrc.match(/function timeRange[\s\S]*?\n}/)[0] + '; return timeRange;')();
  check('a span reads as one 12-hour range',
    tr('08:00', '12:00') === '8am-12pm' && tr('19:00', '21:30') === '7pm-9:30pm'
    && tr('15:00', null) === '3pm' && tr(null, null) === null);
  check('nothing still formats a raw 24-hour span by hand',
    !/\$\{e\.start_time\}\$\{e\.end_time/.test(appSrc)
    && !/\$\{c\.start_time\}[–-]\$\{c\.end_time\}/.test(appSrc));
  // eventLabel writes the notification text and already spoke 12-hour; the
  // screen now agrees with the lock screen.
  check('the notification and the screen agree',
    /`\$\{event\.title\} \$\{start\}\$\{end \? `-\$\{end\}` : ''\}/.test(eventsSrc));

  // Copy that quietly stopped being true.
  check('the open count no longer claims there are two folders',
    /open across all folders/.test(appSrc) && !/open across both folders/.test(appSrc));
  check('the calendar section is not called weekly any more',
    /<h3>Calendar<\/h3>/.test(htmlSrc) && !/<h3>Weekly schedule<\/h3>/.test(htmlSrc));

  // The date field defaulted to config.today during wiring, before sign-in,
  // when config.today is still ''. And loadEvents returned early on an empty
  // calendar - exactly when someone is adding their first event.
  check('the date default uses the server’s day',
    /const today = todayFromServer \|\| config\.today;/.test(appSrc));
  check('and is applied before the empty-calendar return',
    /todayFromServer = today\.date \|\| todayFromServer;\s*\n\s*syncEventKind\(\);[\s\S]{0,200}if \(!events\.length\)/.test(appSrc));

  // Resetting the demo deletes the sessions table, including the caller's.
  check('the demo reset hands back a usable session',
    /const token = await createSession\(env, 'demo'\);\s*\n\s*return json\(\{ ok: true, token/.test(indexSrc));
  check('and the client adopts it before reloading',
    /if \(result\?\.token\) \{[\s\S]{0,120}localStorage\.setItem\(TOKEN_KEY, token\)/.test(appSrc));

  // --- a repeating task is the one most likely to need its checklist again ---
  check('the next occurrence is given a checklist column',
    /subtasks, hide_until_due, created_at, updated_at\)\s*\n\s*VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'open', \?, \?, \?, \?, \?\)/.test(indexSrc));
  check('and it is filled from the completed one',
    /nextSubtasks\(task\.subtasks\)/.test(indexSrc));
  const nextSubtasks = new Function(
    indexSrc.match(/function nextSubtasks\(raw\)[\s\S]*?\n}/)[0] + '; return nextSubtasks;')();
  check('the steps carry over',
    JSON.parse(nextSubtasks('[{"text":"A","done":true},{"text":"B","done":false}]')).length === 2);
  check('but every box starts unticked',
    JSON.parse(nextSubtasks('[{"text":"A","done":true}]')).every((x) => x.done === false));
  check('malformed or empty checklists do not throw',
    nextSubtasks(null) === '[]' && nextSubtasks('not json') === '[]'
    && nextSubtasks('{"not":"an array"}') === '[]'
    && nextSubtasks('[{"done":true}]') === '[]');

  // Removing a commitment was a single unconfirmed click, with no undo.
  check('removing a calendar entry asks first',
    /if \(!confirm\(`Remove \$\{name \? `"\$\{name\}"` : 'this'\} from your calendar\?`\)\) return;/.test(appSrc));

  // --- the invariant the whole one-off design rests on -----------------------
  const dated = cleanEvent({ title: 'Dinner', date: '2026-09-12', start_time: '19:00' });
  check('a dated event derives its own weekday', dated.day_of_week === 6 && dated.date === '2026-09-12');
  const weekly = cleanEvent({ title: 'Clinic', day_of_week: 3, start_time: '08:00' });
  check('a dateless event stays weekly', weekly.date === null && weekly.day_of_week === 3);
  // A supplied weekday must never win over the date, or the two can disagree.
  const conflicting = cleanEvent({ title: 'Dinner', date: '2026-09-12', day_of_week: 1 });
  check('a date always beats a contradicting weekday', conflicting.day_of_week === 6);
}

/**
 * The four things the app could not do that the good calendar and planning
 * apps can: publish itself, look ahead at bedtime, take dictation, and put the
 * list into the day.
 */
async function testNewFeatures() {
  console.log('\nCalendar feed, look-ahead, voice, day plan');

  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const appSrc = read('public/app.js');
  const htmlSrc = read('public/index.html');
  const indexSrc = read('src/index.js');

  // --- 1. the calendar feed -------------------------------------------------
  const ics = await import('../src/ics-out.js');
  const TZ = 'America/Chicago';

  check('a summer wall time becomes the right instant',
    ics.utcStamp(ics.zonedToUtc('2026-08-27', '14:00', TZ)) === '20260827T190000Z');
  // The same wall time in winter is an hour further from UTC. Getting this
  // wrong is the classic recurring-event bug, and why nothing here uses RRULE.
  check('and so does a winter one',
    ics.utcStamp(ics.zonedToUtc('2026-12-15', '14:00', TZ)) === '20261215T200000Z');
  check('midnight is not special-cased wrongly',
    ics.utcStamp(ics.zonedToUtc('2026-08-27', '00:00', TZ)) === '20260827T050000Z');

  // A display string reaching the converter used to yield a confident 00:00.
  let threw = false;
  try { ics.zonedToUtc('2026-08-27', '7am', TZ); } catch { threw = true; }
  check('a non-clock time is refused rather than coerced to midnight', threw);
  check('and a bad date too', (() => {
    try { ics.zonedToUtc('not-a-date', '14:00', TZ); return false; } catch { return true; }
  })());
  check('toHHMM is a clock, not a label',
    ics.toHHMM(420) === '07:00' && ics.toHHMM(1080) === '18:00' && ics.toHHMM(0) === '00:00');
  check('nothing in the feed reaches for the display helper',
    !/\btoClock\s*\(/.test(read('src/feed.js')));

  // Written with String.raw and char codes: the expectation is a string full of
  // backslashes, and spelling it as a normal literal is how you end up asserting
  // something subtly different from what you meant.
  const BS = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  // Built from characters rather than written as a literal: the expectation is
  // a string of backslashes, and spelling it out is exactly how you end up
  // asserting something subtly different from what you meant.
  check('text is escaped in the RFC 5545 order, backslash first',
    ics.escapeText(`a;b,c${BS}d${NL}e`)
      === ['a', BS + ';', 'b', BS + ',', 'c', BS + BS + 'd', BS + 'n', 'e'].join(''));
  const folded = ics.foldLine(`SUMMARY:${'café–naïve '.repeat(12)}`);
  check('long lines fold to 75 octets',
    folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  check('and never mid-character', !folded.includes('�'));

  const stamp = ics.utcStamp(Date.parse('2026-08-25T00:00:00Z'));
  const timed = ics.vevent({ uid: 'u', title: 'Dinner', dateISO: '2026-08-27',
    start: '19:00', end: '21:30', timeZone: TZ, stamp }).join('\r\n');
  check('a timed entry carries both ends',
    /DTSTART:20260828T000000Z/.test(timed) && /DTEND:20260828T023000Z/.test(timed));
  const allDay = ics.vevent({ uid: 'u', title: 'Back-up', dateISO: '2026-08-27',
    start: null, timeZone: TZ, busy: false, stamp }).join('\r\n');
  check('an untimed entry is all-day and transparent',
    /DTSTART;VALUE=DATE:20260827/.test(allDay) && /TRANSP:TRANSPARENT/.test(allDay));
  // A malformed row must degrade to an honest all-day entry, not a midnight lie.
  const junk = ics.vevent({ uid: 'u', title: 'X', dateISO: '2026-08-27',
    start: 'half past three', timeZone: TZ, stamp }).join('\r\n');
  check('an unreadable time degrades to all-day', /DTSTART;VALUE=DATE:/.test(junk));

  check('the feed lives outside /api, so no session is needed',
    /url\.pathname\.startsWith\('\/feed\/'\)/.test(indexSrc));
  check('an unconfigured feed cannot be opened with an empty token',
    /if \(!stored \|\| !safeEqual\(presented, stored\)\)/.test(indexSrc));
  check('the token is compared in constant time', /safeEqual\(presented, stored\)/.test(indexSrc));
  check('the token is long enough to be un-guessable',
    /crypto\.getRandomValues\(new Uint8Array\(32\)\)/.test(indexSrc));
  check('crawlers are told to stay away', /'X-Robots-Tag': 'noindex, nofollow'/.test(indexSrc));
  // A cached copy outlives the token, so revoking would not be immediate.
  check('the feed is never cached', /'Cache-Control': 'no-store',/.test(indexSrc));
  check('it is served as calendar text', /'text\/calendar; charset=utf-8'/.test(indexSrc));
  check('regenerating replaces, which is the revoke',
    /const feedToken = newFeedToken\(\);\s*\n\s*await setSetting\(env, 'feed_token', feedToken\)/.test(indexSrc));
  check('the UI says the link is the password', /The link is the password/.test(htmlSrc));
  check('and warns before regenerating', /will stop updating until you give it the new one/.test(appSrc));

  // The token lives in meta for storage reasons, but it is a credential: a
  // backup gets downloaded, emailed to yourself and left in Downloads, and
  // anyone holding this string reads your calendar without signing in.
  check('the feed token is excluded from exports',
    /const EXPORT_EXCLUDED_META = new Set\(\['feed_token'\]\);/.test(indexSrc)
    && /data\.meta = data\.meta\.filter\(\(row\) => !EXPORT_EXCLUDED_META\.has\(String\(row\?\.key\)\)\);/.test(indexSrc));
  // Backups written before that fix still carry one, and restoring it would
  // turn "revoked" into "revoked until the next restore".
  check('and refused on the way back in',
    /'feed_token',/.test(read('src/restore.js')));

  // The client detected encrypted backups by magic - against the WRONG magic,
  // TODOBK01, while the writer had long since moved to TODOBK02. Two bugs in
  // one line: the check could never fire, and atob() threw outright on a plain
  // JSON file, so restoring an unencrypted backup died with "Invalid
  // character" before it ever reached the server.
  const { MAGIC, encryptBackup, toBase64 } = await import('../src/backup-crypto.js');
  const detect = (raw, name) => {
    let sealed = name.endsWith('.enc');
    try {
      sealed = /^TODOBK\d{2}/.test(atob(raw.slice(0, 24).replace(/\s+/g, '')).slice(0, 8)) || sealed;
    } catch { /* not base64, so not an encrypted backup */ }
    return sealed;
  };
  const armoured = toBase64(await encryptBackup('pw', JSON.stringify({ a: 1 })));
  const plainBackup = JSON.stringify({ exported_at: '2026-08-25T00:00:00Z', app: 'todo', data: {} });

  // Tested against the regex literal, not the file text: the comment above it
  // names the old magic while explaining the bug, and asserting on prose is
  // how a check ends up measuring the wrong thing.
  check('the client matches the magic by prefix, not by version',
    /\/\^TODOBK\\d\{2\}\//.test(appSrc) && !/\/\^TODOBK01\//.test(appSrc));
  check('the writer and the format comment agree',
    MAGIC === 'TODOBK02' && /magic       8 bytes   "TODOBK02"/.test(read('src/backup-crypto.js')));
  check('an encrypted backup is detected by its contents, not its name',
    detect(armoured, 'renamed.json') === true);
  check('and still by name when it has one', detect(armoured, 'b.json.enc') === true);
  check('a plain JSON backup is not mistaken for an encrypted one',
    detect(plainBackup, 'todo-backup.json') === false);
  check('and reading one no longer throws', (() => {
    try { detect(plainBackup, 'todo-backup.json'); return true; } catch { return false; }
  })());
  check('the atob guard is actually present',
    /\} catch \{\s*\n\s*\/\/ Not base64 at all/.test(appSrc));

  // --- 2. the evening nudge looks ahead -------------------------------------
  check('it reads tomorrow’s commitments',
    /eventsForDay\(env, tomorrowDay, tomorrowISO\)/.test(indexSrc)
    && /scheduleForDate\(env, tomorrowISO\)/.test(indexSrc));
  check('and what is due tomorrow', /t\.deadline === tomorrowISO/.test(indexSrc));

  // --- 3. voice capture -----------------------------------------------------
  // The token is shown once and is 43 characters. On a phone that is unusable
  // without a copy button - which the feed URL had and this did not.
  check('the token can be copied in one tap', /id="shortcut-copy"/.test(htmlSrc));
  check('both secrets share one copier',
    /copyField\('feed-url', 'feed-status'\)/.test(appSrc)
    && /copyField\('shortcut-token', 'shortcut-status'\)/.test(appSrc));
  check('a refused clipboard selects instead of failing',
    /setSelectionRange\(0, value\.length\)/.test(appSrc));
  check('a Shortcut token is an ordinary revocable session',
    /createSession\(env, 'Siri Shortcut'\)/.test(indexSrc));
  check('quick add keeps the time it parsed', /start_time: parsed\.time,/.test(indexSrc));
  check('and can create an event, not only a task',
    /const wantsEvent = body\.kind \? body\.kind === 'event' : parsed\.kind === 'event';/.test(indexSrc));
  check('a weekly dictation becomes a weekly commitment',
    /\.\.\.\(parsed\.repeatsWeekly[\s\S]{0,120}day_of_week: parsed\.dayOfWeek/.test(indexSrc));

  const { parseQuickAdd } = await import('../public/parse.js');
  const TUE = '2026-08-25';
  // "next monday" resolved the date and left the word in the title.
  check('"next monday" is consumed, not half-consumed',
    parseQuickAdd('Renew the licence next monday', TUE).title === 'Renew the licence');
  check('so are "this" and "on"',
    parseQuickAdd('Call John on friday', TUE).title === 'Call John'
    && parseQuickAdd('Dinner this thursday 7pm-9pm', TUE).title === 'Dinner');
  check('a bare weekday still works',
    parseQuickAdd('Sign reports friday', TUE).deadline === '2026-08-28');
  // "next" that is not a date must survive untouched.
  check('an unrelated "next" is left alone',
    parseQuickAdd('Buy a next generation monitor', TUE).title === 'Buy a next generation monitor');

  // A spoken "#" is transcribed as the literal word "hashtag", so the only
  // folder syntax the parser had was unreachable by voice and every dictated
  // task landed in the fallback folder.
  const cat = (line) => parseQuickAdd(line, TUE).category;
  const titleOf = (line) => parseQuickAdd(line, TUE).title;
  check('a dictated hash sets the folder',
    cat('Call the lab friday 3pm hashtag work') === 'work'
    && titleOf('Call the lab friday 3pm hashtag work') === 'Call the lab');
  check('so does a trailing "for <folder>"',
    cat('Call the lab friday 3pm for work') === 'work'
    && cat('Peloton tomorrow for fitness') === 'fitness'
    && cat('Book the flights for personal') === 'personal');
  // The trailing match runs after dates are lifted out, or "friday" is still
  // in the way when we ask what the last words are.
  check('and still reads it when a date follows',
    cat('Prep the talk for work friday') === 'work'
    && titleOf('Prep the talk for work friday') === 'Prep the talk');
  check('the typed hash is unchanged', cat('Call the lab friday 3pm #work') === 'work');
  // Anchoring is the whole defence against eating ordinary words.
  check('"for <folder>" mid-sentence is left alone',
    cat('Sign the form for personal reasons') === null
    && titleOf('Sign the form for personal reasons') === 'Sign the form for personal reasons');
  check('and so is an incidental mention of a folder name',
    cat('Bring the laptop to work') === null && cat('Order a new work phone') === null);

  // "next thursday" said on a Tuesday means nine days away, not two. It used
  // to resolve the same as a bare weekday - tolerable when the stray "next"
  // was left in the title as a hint, indefensible once it was swallowed, and
  // dangerous by voice where there is no preview at all.
  const due = (line, today) => parseQuickAdd(line, today).deadline;
  check('"next <weekday>" is the following week',
    due('X next thursday', '2026-08-25') === '2026-09-03');
  check('"this <weekday>" and a bare one are the next one coming',
    due('X this thursday', '2026-08-25') === '2026-08-27'
    && due('X thursday', '2026-08-25') === '2026-08-27'
    && due('X on thursday', '2026-08-25') === '2026-08-27');
  // Weeks run Monday-Sunday: with a Sunday start, "next Thursday" said on a
  // Sunday would land ten days out.
  check('a Sunday does not send it ten days away',
    due('X next thursday', '2026-08-30') === '2026-09-03');
  check('and on the day itself it still means next week',
    due('X next thursday', '2026-08-27') === '2026-09-03');
  check('"next monday" and "next week" never disagree',
    ['2026-08-25', '2026-08-27', '2026-08-30', '2026-08-31'].every(
      (d) => due('X next monday', d) === due('X next week', d)));

  // Dictation has no preview, so the endpoint can hand back a receipt.
  const { captureSummary } = await import('../src/index.js');
  check('a task receipt names the day, the time and the folder',
    captureSummary('task', { title: 'Call the lab', deadline: '2026-08-28',
      start_time: '15:00', category: 'work' }) === 'Task: Call the lab — Fri 28 Aug, 3pm, Work');
  check('an undated task still reads sensibly',
    captureSummary('task', { title: 'Buy milk', category: 'personal' }) === 'Task: Buy milk — Personal');
  check('a one-off event names its date',
    captureSummary('event', { title: 'Dinner', date: '2026-08-27',
      start_time: '19:00', end_time: '21:30' }) === 'Event: Dinner — Thu 27 Aug, 7pm-9:30pm');
  check('a weekly commitment says which day it repeats',
    captureSummary('event', { title: 'Clinic', date: null, day_of_week: 2,
      start_time: '08:00', end_time: '12:00' }) === 'Event: Clinic — every Tuesday, 8am-12pm');
  check('a renamed folder is used in the receipt',
    /Training/.test(captureSummary('task', { title: 'X', category: 'fitness' }, { fitness: 'Training' })));
  check('?format=text returns the bare sentence',
    /const wantsText = url\.searchParams\.get\('format'\) === 'text';/.test(indexSrc)
    && /if \(wantsText\) return text\(taskSummary, 201\);/.test(indexSrc));
  check('and JSON callers still get the whole object plus the summary',
    /return json\(\{ ok: true, kind: 'task', summary: taskSummary, task \}, 201\);/.test(indexSrc));

  // --- 4. the day plan ------------------------------------------------------
  const { planDay, carve, DEFAULT_MINUTES } = await import('../src/dayplan.js');
  const windows = [{ start: 7 * 60, end: 12 * 60 }, { start: 17.5 * 60, end: 19 * 60 }];

  const morning = planDay({ windows, nowMinutes: 7 * 60, tasks: [
    { title: 'A', estimate_minutes: 45 }, { title: 'B', estimate_minutes: 90 },
    { title: 'C', estimate_minutes: 300 }, { title: 'D' },
  ] });
  check('tasks are laid into the gaps in order',
    morning.blocks.map((b) => b.task.title).join('') === 'ABD');
  check('blocks do not overlap',
    morning.blocks.every((b, i, all) => i === 0 || b.start >= all[i - 1].end));
  check('a task with no estimate gets the default',
    morning.blocks.find((b) => b.task.title === 'D').end
    - morning.blocks.find((b) => b.task.title === 'D').start === DEFAULT_MINUTES);
  check('what does not fit is reported, not dropped',
    morning.unplaced.length === 1 && morning.unplaced[0].task.title === 'C');

  const pinnedPlan = planDay({ windows, nowMinutes: 7 * 60, tasks: [
    { title: 'Lab', start_time: '15:00', estimate_minutes: 15 },
    { title: 'Reports', estimate_minutes: 45 },
  ] });
  const lab = pinnedPlan.blocks.find((b) => b.task.title === 'Lab');
  check('a pinned task keeps the hour you chose', lab.start === 15 * 60 && lab.pinned);
  // Placed anyway, because moving it silently would be worse - but flagged.
  check('and a clash with committed time is flagged, not hidden',
    lab.conflict === true && pinnedPlan.conflicts === 1);

  const late = planDay({ windows, nowMinutes: 14 * 60, tasks: [
    { title: 'Missed', start_time: '09:00', estimate_minutes: 20 },
    { title: 'Later', estimate_minutes: 45 },
  ] });
  check('nothing is scheduled into time that has gone',
    late.blocks.every((b) => b.start >= 14 * 60));
  check('a pinned hour already past is reported as past',
    late.unplaced.some((u) => u.reason === 'already past'));

  check('a full day plans nothing and says so',
    planDay({ windows: [], nowMinutes: 7 * 60, tasks: [{ title: 'X' }] }).blocks.length === 0);
  check('carve leaves no useless slivers',
    carve([{ start: 0, end: 100 }], [{ start: 5, end: 95 }]).length === 0);
  check('spare is measured from what is left, not by subtraction',
    pinnedPlan.spare === pinnedPlan.blocks
      .filter((b) => !b.conflict)
      .reduce((n) => n, windows.reduce((n, w) => n + (w.end - w.start), 0) - 45));

  check('the plan is never stored', !/INSERT INTO day_plan|day_plan/.test(indexSrc));
  check('it is recomputed each time the panel opens',
    /if \(opening\) await loadPlan\(\);/.test(appSrc));
  check('what did not fit is shown to you', /Did not fit: \$\{named\.join/.test(appSrc));
  // On a day with no working time left, every task "did not fit" - repeating
  // the whole list back is noise, and the summary already said why.
  check('but not when there was no time to begin with',
    /plan\.unplaced\.length && plan\.available > 0/.test(appSrc));
  check('and a long list is truncated', /and \$\{rest\} more/.test(appSrc));
}

// --- run --------------------------------------------------------------------

await testPushRoundTrip();
testRanking();
testFrontend();
await testAuth();
await testWorkouts();
await testRecurrence();
await testQuickAdd();
await testEvents();
await testSchedule();
await testFreeTime();
await testDriveBackup();
await testHideUntilDue();
await testRestore();
await testFolderNames();
await testDemoLock();
await testBackupEncryption();
await testInterchange();
await testVision();
await testTypedEvents();
await testSecondPass();
await testNewFeatures();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
