// Session tokens and brute-force protection.
//
// Before this, the passphrase itself was the bearer token: sent on every
// request and parked in localStorage on each device forever. Now the
// passphrase is exchanged once for a random session token, and only a hash of
// that token is stored server-side - so a database leak cannot be replayed,
// and a lost device can be revoked without changing the passphrase everywhere.

const encoder = new TextEncoder();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Sessions last this long without being used. */
export const SESSION_DAYS = 180;

/** Typos happen; the first few failures cost nothing. */
const FREE_ATTEMPTS = 4;

/** Failure counters decay, so an honest typo today isn't held against you next week. */
const FAILURE_DECAY_MS = 6 * HOUR_MS;

/** Warn after this many failures, at most once an hour. */
const ALERT_THRESHOLD = 5;

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 256 bits of randomness, URL-safe. */
export function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * How long to lock out after `failures` consecutive misses.
 * Doubles each time past the free allowance, capped at a day:
 * 5th -> 1m, 6th -> 2m, 7th -> 4m ... 16th -> 24h.
 */
export function lockoutMs(failures) {
  if (failures <= FREE_ATTEMPTS) return 0;
  const over = failures - FREE_ATTEMPTS;
  return Math.min(2 ** (over - 1) * 60_000, DAY_MS);
}

// --------------------------------------------------------------------------
// rate limiting
// --------------------------------------------------------------------------

export function clientIp(request) {
  // CF-Connecting-IP only. Cloudflare sets it on every request that reaches a
  // Worker and a caller cannot forge it.
  //
  // X-Forwarded-For used to be a fallback here, and that was a latent hole:
  // it is whatever the caller typed. Anyone who could reach the Worker without
  // CF-Connecting-IP set could present a fresh "address" on every request,
  // giving each guess its own clean lockout record and turning the rate limit
  // into a no-op. Falling back to a single shared bucket is the safe failure:
  // worst case everyone shares one limit, rather than nobody having one.
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function readAttempts(env, ip) {
  return env.DB.prepare('SELECT * FROM auth_attempts WHERE ip = ?').bind(ip).first();
}

/**
 * Is this IP currently locked out?
 * Returns { blocked, retryAfter } with retryAfter in whole seconds.
 */
export async function checkLockout(env, ip, now = Date.now()) {
  const row = await readAttempts(env, ip);
  if (!row?.locked_until) return { blocked: false, retryAfter: 0 };

  const until = Date.parse(row.locked_until);
  if (Number.isNaN(until) || until <= now) return { blocked: false, retryAfter: 0 };

  return { blocked: true, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
}

/**
 * Record a failed attempt and apply the next lockout.
 * Returns { failures, retryAfter, shouldAlert }.
 */
export async function recordFailure(env, ip, now = Date.now()) {
  const row = await readAttempts(env, ip);

  // Let an old, isolated mistake fade rather than accumulate forever.
  const lastFailure = row?.last_failure ? Date.parse(row.last_failure) : 0;
  const stale = lastFailure > 0 && now - lastFailure > FAILURE_DECAY_MS;
  const previous = stale ? 0 : (row?.failures ?? 0);

  const failures = previous + 1;
  const lockMs = lockoutMs(failures);
  const lockedUntil = lockMs > 0 ? new Date(now + lockMs).toISOString() : null;
  const nowISO = new Date(now).toISOString();

  const alertedAt = row?.alerted_at ? Date.parse(row.alerted_at) : 0;
  const shouldAlert = failures >= ALERT_THRESHOLD && (now - alertedAt > HOUR_MS);

  await env.DB.prepare(
    `INSERT INTO auth_attempts (ip, failures, first_failure, last_failure, locked_until, alerted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       failures = excluded.failures,
       first_failure = COALESCE(auth_attempts.first_failure, excluded.first_failure),
       last_failure = excluded.last_failure,
       locked_until = excluded.locked_until,
       alerted_at = excluded.alerted_at`,
  ).bind(
    ip,
    failures,
    nowISO,
    nowISO,
    lockedUntil,
    shouldAlert ? nowISO : (row?.alerted_at ?? null),
  ).run();

  return {
    failures,
    retryAfter: lockMs > 0 ? Math.ceil(lockMs / 1000) : 0,
    shouldAlert,
  };
}

/** A correct passphrase wipes the slate for that IP. */
export async function clearFailures(env, ip) {
  await env.DB.prepare('DELETE FROM auth_attempts WHERE ip = ?').bind(ip).run();
}

// --------------------------------------------------------------------------
// sessions
// --------------------------------------------------------------------------

/** Mint a session and return the raw token - the only time it exists server-side. */
export async function createSession(env, deviceLabel, now = Date.now()) {
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);

  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, device_label, created_at, last_seen, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    tokenHash,
    String(deviceLabel || 'device').slice(0, 60),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    new Date(now + SESSION_DAYS * DAY_MS).toISOString(),
  ).run();

  return token;
}

/**
 * Look up a presented token. Returns the session row, or null.
 * `last_seen` is only rewritten once an hour - a write on every request would
 * be a lot of database traffic for a timestamp nobody reads that precisely.
 */
export async function resolveSession(env, token, now = Date.now()) {
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .bind(tokenHash).first();
  if (!row) return null;

  if (Date.parse(row.expires_at) <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
    return null;
  }

  const lastSeen = row.last_seen ? Date.parse(row.last_seen) : 0;
  if (now - lastSeen > HOUR_MS) {
    await env.DB.prepare(
      'UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?',
    ).bind(
      new Date(now).toISOString(),
      new Date(now + SESSION_DAYS * DAY_MS).toISOString(), // sliding expiry
      row.id,
    ).run();
  }

  return row;
}

export async function listSessions(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, device_label, created_at, last_seen, expires_at FROM sessions ORDER BY created_at',
  ).all();
  return results ?? [];
}

export async function deleteSession(env, id) {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/** Sign out everything except the session making the request. */
export async function deleteOtherSessions(env, keepId) {
  await env.DB.prepare('DELETE FROM sessions WHERE id != ?').bind(keepId).run();
}

/** Housekeeping, called from the cron. */
export async function pruneExpired(env, now = Date.now()) {
  const nowISO = new Date(now).toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(nowISO).run();
  await env.DB.prepare(
    'DELETE FROM auth_attempts WHERE (locked_until IS NULL OR locked_until <= ?) AND last_failure <= ?',
  ).bind(nowISO, new Date(now - FAILURE_DECAY_MS).toISOString()).run();
}
