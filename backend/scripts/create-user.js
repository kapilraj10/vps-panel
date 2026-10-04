#!/usr/bin/env node
// Create a panel user (or reset an existing user's password). Run from the backend folder:
//   node scripts/create-user.js
import dotenv from 'dotenv';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const { users, audit, USERNAME_RE, CONTAINER_RE, MIN_PASSWORD } = await import('../db.js');

if (!process.stdin.isTTY) {
  console.error('Run this in an interactive terminal (it asks for the password without echoing it).');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

// Like ask(), but does not print what is typed
function askHidden(q) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => { if (s.includes(q)) write.call(rl, s); };
    rl.question(q, (a) => {
      rl._writeToOutput = write;
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

async function askUntil(q, check) {
  for (;;) {
    const a = await ask(q);
    const problem = check(a);
    if (!problem) return a;
    console.log(`  ${problem}`);
  }
}

async function askPassword() {
  for (;;) {
    const pw = await askHidden('Password: ');
    if (pw.length < MIN_PASSWORD) { console.log(`  At least ${MIN_PASSWORD} characters, please.`); continue; }
    if (Buffer.byteLength(pw) > 72) { console.log('  At most 72 bytes, please.'); continue; }
    if ((await askHidden('Repeat password: ')) !== pw) { console.log('  Passwords do not match.'); continue; }
    return pw;
  }
}

try {
  const username = (await askUntil('Username: ', (a) => (USERNAME_RE.test(a.toLowerCase())
    ? null : '2-32 lowercase letters, digits, _ or -, starting with a letter'))).toLowerCase();

  const existing = users.withHash(username);
  if (existing) {
    const yes = await ask(`User "${username}" exists (role ${existing.role}). Reset their password? [y/N] `);
    if (yes.toLowerCase() !== 'y') { console.log('Nothing changed.'); process.exit(0); }
    users.setPassword(existing.id, await bcrypt.hash(await askPassword(), 12));
    audit.log({ username: 'cli', action: 'user_password_reset', target: username, result: 'success' });
    console.log(`Password for "${username}" updated.`);
    process.exit(0);
  }

  const role = await askUntil('Role (admin/user): ', (a) => (['admin', 'user'].includes(a) ? null : 'Type admin or user'));
  const container = role === 'user'
    ? await askUntil('Container name (as in `lxc list`): ', (a) => (CONTAINER_RE.test(a) ? null : 'Letters, digits and dashes, starting with a letter'))
    : null;
  const passwordHash = await bcrypt.hash(await askPassword(), 12);

  users.create({ username, passwordHash, role, container });
  audit.log({ username: 'cli', action: 'user_create', target: username, result: 'success', detail: container ? `container ${container}` : 'admin' });
  console.log(`Created ${role} "${username}"${container ? ` for container "${container}"` : ''}.`);
} finally {
  rl.close();
}
