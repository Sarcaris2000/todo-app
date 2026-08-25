// Generates the VAPID key pair used to authenticate push messages.
// Public key  -> shipped to the browser, used as applicationServerKey.
// Private key -> Worker secret, never leaves Cloudflare.
//
// Prints shell-friendly KEY=value lines so setup.sh can eval them.

import { webcrypto as crypto } from 'node:crypto';

const toBase64Url = (buffer) =>
  Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);

const publicRaw = await crypto.subtle.exportKey('raw', pair.publicKey);
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

if (publicRaw.byteLength !== 65) {
  throw new Error(`Unexpected public key length: ${publicRaw.byteLength}`);
}

process.stdout.write(`VAPID_PUBLIC_KEY=${toBase64Url(publicRaw)}\n`);
process.stdout.write(`VAPID_PRIVATE_KEY=${privateJwk.d}\n`);
