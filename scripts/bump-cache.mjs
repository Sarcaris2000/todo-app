#!/usr/bin/env node
//
// Bump the service worker cache name.
//
//   node scripts/bump-cache.mjs
//
// Exists because hand-written `sed s/v36/v37/` bumps fail SILENTLY when the
// current version is not what you assumed - the command succeeds, nothing
// changes, and every later deploy leaves stale assets in people's browsers.
// This reads the current number instead of guessing it.

import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../public/sw.js', import.meta.url);
const source = readFileSync(path, 'utf8');
const match = source.match(/todo-shell-v(\d+)/);

if (!match) {
  console.error('No todo-shell-v<n> found in public/sw.js');
  process.exit(1);
}

const next = Number(match[1]) + 1;
writeFileSync(path, source.replace(/todo-shell-v\d+/g, `todo-shell-v${next}`));
console.log(`sw cache: v${match[1]} -> v${next}`);
