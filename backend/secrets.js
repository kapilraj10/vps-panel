// Encryption at rest for app secrets (env vars, git tokens): AES-256-GCM.
// Key: SECRETS_KEY (64 hex chars) if set, otherwise derived from SESSION_SECRET.
// If you rotate SESSION_SECRET without setting SECRETS_KEY, saved app secrets can no longer be read and must be entered again.
import crypto from 'node:crypto';

const fromEnv = process.env.SECRETS_KEY || '';
const KEY = /^[0-9a-f]{64}$/i.test(fromEnv)
  ? Buffer.from(fromEnv, 'hex')
  : Buffer.from(crypto.hkdfSync('sha256', process.env.SESSION_SECRET || '', 'kapil-cloud', 'app-secrets-v1', 32));

export function seal(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function open(sealed) {
  if (!sealed) return '';
  const buf = Buffer.from(String(sealed).replace(/^v1:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
