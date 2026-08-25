#!/usr/bin/env node
//
//   node scripts/set-backup-passphrase.mjs
//
// Generates a strong backup passphrase, shows it to you exactly once, and
// stores it as a Cloudflare secret. Nothing is written to disk.
//
// SAVE IT BEFORE YOU CLOSE THE TERMINAL. There is no recovery. The passphrase
// is the only thing that can open your backups - which is precisely what makes
// encrypting them worth doing.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';

// This passphrase defends a file sitting in cloud storage, so it has to
// survive an OFFLINE attack: someone who steals the backup can guess at it
// forever with as many GPUs as they care to rent. That is a very different
// bar from a login password, where the server rate-limits attempts.
//
// An earlier version of this script drew six words from a 48-word list, which
// is only ~34 bits - roughly a week of one GPU. Since the passphrase lives in
// a password manager and never has to be memorised, there is no reason to
// trade entropy for memorability.
//
// Crockford-style base32, minus the characters people mistype (I, L, O, U).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHARS = 24;
const GROUP = 4;

const raw = Array.from({ length: CHARS }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const passphrase = raw.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-');
const bits = Math.floor(CHARS * Math.log2(ALPHABET.length));

console.log('\nYour backup passphrase:\n');
console.log(`    ${passphrase}\n`);
console.log(`  (${bits} bits of entropy - built to withstand offline guessing)\n`);
console.log('Put it in your password manager NOW. It is shown once, it is not');
console.log('stored anywhere on this machine, and without it your encrypted');
console.log('backups cannot be opened - by you or by anyone else.\n');

const rl = createInterface({ input: stdin, output: stdout });
const confirm = await rl.question('Type "saved" once it is in your password manager: ');
rl.close();

if (confirm.trim().toLowerCase() !== 'saved') {
  console.error('\nNothing was stored. Run this again when you are ready.');
  exit(1);
}

// Piped on stdin, so the passphrase never appears in the process list or in
// your shell history.
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'BACKUP_PASSPHRASE'],
  { input: passphrase, stdio: ['pipe', 'inherit', 'inherit'] });

if (result.status !== 0) {
  console.error('\nCould not store the secret. Set it by hand with:');
  console.error('  npx wrangler secret put BACKUP_PASSPHRASE');
  exit(1);
}

console.log('\nStored. Deploy, then press "Back up to Drive now". The file in');
console.log('Drive should now end in .json.enc and be unreadable without that');
console.log('passphrase. Prove it to yourself by downloading it and running:\n');
console.log('  node scripts/decrypt-backup.mjs <the-downloaded-file>.json.enc\n');
