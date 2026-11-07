// Shared route helpers: async error handling and small input validators.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

// Lets async handlers throw; the central error handler in server.js answers
export const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

export function int(v, { min, max, name, optional = false }) {
  if (optional && (v === undefined || v === null || v === '')) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function str(v, { max, name, re = null, optional = false, trim = true }) {
  if (optional && (v === undefined || v === null || v === '')) return null;
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = trim ? v.trim() : v;
  if (!s || s.length > max) throw bad(`${name} must be 1-${max} characters`);
  if (re && !re.test(s)) throw bad(`${name} has invalid characters`);
  return s;
}

export const MiB = 1024 * 1024;
export const GiB = 1024 * MiB;
