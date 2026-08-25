// Web Push, implemented directly against Web Crypto so the Worker has no
// npm dependencies. Two specs are in play:
//   RFC 8292 (VAPID)  - proves to the push service that we own the key pair.
//   RFC 8291 (aes128gcm) - encrypts the payload so only the device can read it.

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(input) {
  const bytes = new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// HKDF extract + expand. Every output we need is <= 32 bytes, so a single
// expand round is enough.
async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// The VAPID private key is stored as the raw 32-byte scalar (base64url) and the
// public key as the uncompressed point, so we rebuild the JWK from both halves.
async function importVapidKey(privateB64url, publicB64url) {
  const pub = b64urlToBytes(publicB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: privateB64url,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function vapidAuthorization(endpoint, publicKey, privateKey, subject) {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;

  const key = await importVapidKey(privateKey, publicKey);
  // Web Crypto returns the raw r||s form that JWS ES256 expects.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput),
  );

  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKey}`;
}

async function encryptPayload(plaintextString, p256dhB64url, authB64url) {
  const uaPublicRaw = b64urlToBytes(p256dhB64url);
  const authSecret = b64urlToBytes(authB64url);

  const uaPublicKey = await crypto.subtle.importKey(
    'raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );

  // Fresh ephemeral key pair per message, as the spec requires.
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPublicKey }, ephemeral.privateKey, 256,
  ));

  // RFC 8291 §3.4: mix the shared secret with the subscription's auth secret,
  // binding the result to both public keys.
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // 0x02 marks this as the final (and only) record.
  const padded = concat(enc.encode(plaintextString), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded,
  ));

  // aes128gcm framing: salt | record size | key id length | key id | ciphertext
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/**
 * Deliver one notification.
 * Returns { ok, status, gone } - `gone` means the subscription is dead and
 * should be deleted (the browser was uninstalled, or permission was revoked).
 */
export async function sendPush(subscription, payloadObject, env) {
  const body = await encryptPayload(
    JSON.stringify(payloadObject), subscription.p256dh, subscription.auth,
  );

  const authorization = await vapidAuthorization(
    subscription.endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT || 'mailto:admin@example.com',
  );

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });

  let detail = '';
  if (!response.ok) {
    detail = await response.text().catch(() => '');
  }

  return {
    ok: response.ok,
    status: response.status,
    gone: response.status === 404 || response.status === 410,
    detail: detail.slice(0, 300),
  };
}
