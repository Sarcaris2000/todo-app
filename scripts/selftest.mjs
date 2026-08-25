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
  check('the evening nudge exists', /sendEveningNudge/.test(indexJs));
  check('it reports what is still open rather than checking one task',
    /Nothing outstanding/.test(indexJs));
  check('nothing outstanding means nothing is sent',
    /if \(!outstanding\.length\) return \{ sent: 0, skipped: true/.test(indexJs));
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
  check('dictated text goes through the same parser',
    /parseQuickAdd\(text, today\)/.test(readFileSync(join(ROOT, 'src/index.js'), 'utf8')));
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

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
