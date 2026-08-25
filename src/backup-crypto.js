// Encrypting a backup before it leaves the building.
//
// The live app cannot be end-to-end encrypted: the Worker has to read your
// task titles to write the morning brief. A backup is different. It is written
// once and read only during a restore, so it can be sealed here and land in
// Google Drive as a blob that Google - or anyone who gets into your Google
// account - cannot read.
//
// PBKDF2-SHA256 to a 256-bit key, AES-256-GCM for the payload. GCM is
// authenticated, so a file that has been altered by even one byte fails to
// decrypt rather than quietly restoring corrupted data.
//
// The format is deliberately self-describing: every parameter needed to
// decrypt sits in the header, so a file written today still opens years from
// now even if these defaults change.
//
//   magic       8 bytes   "TODOBK01"
//   iterations  4 bytes   uint32 big-endian
//   salt       16 bytes
//   iv         12 bytes
//   ciphertext  rest      includes the 16-byte GCM tag
//
// Losing the passphrase means losing the backups. That is the point, and it
// is why scripts/decrypt-backup.mjs exists - so the file can always be opened
// with nothing but Node and the passphrase, even if this app is gone.

export const MAGIC = 'TODOBK02';

/**
 * Sealed backups travel and are stored as base64 of the binary container.
 *
 * Not decoration: the Drive upload assembles its multipart body as a string,
 * and raw ciphertext bytes would be mangled by UTF-8 encoding on the way out.
 * Armouring keeps the file plain text end to end - the same reason PEM exists.
 */
export function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export const HEADER_BYTES = 8 + 4 + 16 + 12;

// OWASP's floor for PBKDF2-HMAC-SHA256. Derivation happens once per backup and
// once per restore, never per request, so the cost lands somewhere nobody waits.
export const DEFAULT_ITERATIONS = 600_000;

/**
 * Cloudflare refuses a single PBKDF2 call above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 *   are not supported (requested 600000).
 *
 * Local workerd does NOT enforce this, so it only appears in production.
 *
 * We reach the target by chaining rounds, each within the cap, feeding one
 * round's output in as the next round's input. The work is sequential and
 * unshortcuttable, so an attacker must perform the same total as a single
 * 600,000-iteration derivation would have cost.
 */
export const MAX_ITERATIONS_PER_ROUND = 100_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

async function deriveKey(passphrase, salt, totalIterations) {
  const rounds = Math.max(1, Math.ceil(totalIterations / MAX_ITERATIONS_PER_ROUND));
  const perRound = Math.ceil(totalIterations / rounds);

  let material = encoder.encode(passphrase);
  for (let round = 0; round < rounds; round++) {
    const base = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    material = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: perRound, hash: 'SHA-256' }, base, 256,
    ));
  }

  return crypto.subtle.importKey(
    'raw', material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/** True if these bytes are one of our encrypted backups. */
export function isEncryptedBackup(bytes) {
  if (!bytes || bytes.length < HEADER_BYTES) return false;
  return decoder.decode(bytes.slice(0, 8)) === MAGIC;
}

export async function encryptBackup(passphrase, plaintext, iterations = DEFAULT_ITERATIONS) {
  if (!passphrase) throw new Error('No backup passphrase set');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(plaintext),
  ));

  const iterBytes = new Uint8Array(4);
  new DataView(iterBytes.buffer).setUint32(0, iterations, false);

  return concatBytes(encoder.encode(MAGIC), iterBytes, salt, iv, ciphertext);
}

export async function decryptBackup(passphrase, bytes) {
  if (!passphrase) throw new Error('No backup passphrase set');
  if (!isEncryptedBackup(bytes)) {
    throw new Error('That file is not an encrypted backup from this app');
  }

  const iterations = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, false);
  // A corrupt header could otherwise ask us to burn minutes of CPU.
  if (iterations < 1000 || iterations > 5_000_000) {
    throw new Error('That backup has an implausible iteration count and may be corrupt');
  }

  const salt = bytes.slice(12, 28);
  const iv = bytes.slice(28, 40);
  const ciphertext = bytes.slice(40);
  const key = await deriveKey(passphrase, salt, iterations);

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    // GCM cannot tell these apart, and saying so is more useful than guessing.
    throw new Error('Wrong passphrase, or the file has been altered');
  }
  return decoder.decode(plaintext);
}
