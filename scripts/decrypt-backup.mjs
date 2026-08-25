#!/usr/bin/env node
//
// Open an encrypted backup with nothing but Node and the passphrase.
//
//   node scripts/decrypt-backup.mjs todo-backup-2026-08-30.json.enc
//   node scripts/decrypt-backup.mjs backup.json.enc restored.json
//
// This exists because a backup you can only open through the app is not a
// backup. If the Worker is gone, the Cloudflare account is gone, or you are
// simply reading this in five years, the file still opens here.
//
// It deliberately imports src/backup-crypto.js rather than reimplementing the
// format: two implementations drift, and the day you discover the drift is the
// day you actually needed the file.

import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';
import { decryptBackup, isEncryptedBackup, fromBase64 } from '../src/backup-crypto.js';

const [input, output] = argv.slice(2);

if (!input) {
  console.error('Usage: node scripts/decrypt-backup.mjs <backup.json.enc> [output.json]');
  exit(1);
}

const armoured = await readFile(input, 'utf8');

let bytes;
try {
  bytes = fromBase64(armoured);
} catch {
  console.error(`\n${input} is not base64. Is this actually an encrypted backup?`);
  exit(1);
}

if (!isEncryptedBackup(bytes)) {
  console.error(`\n${input} is not an encrypted backup from this app.`);
  console.error('A plain .json backup needs no decrypting - open it directly.');
  exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const passphrase = await rl.question('Backup passphrase: ');
rl.close();

let plaintext;
try {
  plaintext = await decryptBackup(passphrase.trim(), bytes);
} catch (error) {
  console.error(`\n${error.message}`);
  exit(1);
}

// A decrypt that "succeeds" into garbage is worse than one that fails, so say
// what actually came out.
const summary = (() => {
  try {
    const data = JSON.parse(plaintext);
    const counts = Object.entries(data.counts ?? {})
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${n} ${table}`)
      .join(', ');
    return `exported ${String(data.exported_at).slice(0, 10)} - ${counts}`;
  } catch {
    return 'decrypted, but the contents are not the JSON this app writes';
  }
})();

if (output) {
  await writeFile(output, plaintext);
  console.log(`\nDecrypted to ${output}\n  ${summary}`);
} else {
  console.log(plaintext);
  console.error(`\n  ${summary}`);
}
