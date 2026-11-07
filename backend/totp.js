// TOTP (RFC 6238) and base32, without dependencies. Pure functions (tests import this file directly).
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function toBase32(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function fromBase32(s) {
  const clean = String(s).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let val = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
// Step of the matching code (window ±1 step), or null. Steps <= lastStep are replays.
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const cur = Math.floor(now / STEP_MS);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (s <= (lastStep || 0)) continue;
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, s)), Buffer.from(String(code)))) return s;
  }
  return null;
}
