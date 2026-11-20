// SSH execution on CUSTOMER servers (their own VPS), agentless: the panel connects with the credentials the customer
// gave (sealed in customer_servers.secret_enc), runs one fixed script and disconnects.
//
// Safety
// * Address guard: a customer server must resolve to PUBLIC addresses only. Otherwise a customer could make the panel
//   connect to the LXD bridge (10.10.10.x), localhost, the admin fleet or the cloud metadata service. Every resolved
//   address is checked, and the connection goes to the checked address (no second DNS lookup to race).
//   CUSTOMER_SSH_ALLOW_PRIVATE=1 lifts it (tests, or a panel that manages a private LAN on purpose).
// * Host key: pinned on first successful connect (trust on first use); a different key later is refused.
// * Scripts are fixed text. User values travel as `export NAME='value'` lines quoted by shQuote, sent on stdin,
//   never spliced into the command line.
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const { Client } = ssh2;
const KEEP = 256 * 1024;

const v4n = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const inV4 = (ip, cidr) => { const [b, bits] = cidr.split('/'); const size = 2 ** (32 - Number(bits)); return Math.floor(v4n(ip) / size) === Math.floor(v4n(b) / size); };
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/3'];

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) return !PRIVATE_V4.some((c) => inV4(ip, c));
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (m) return isPublicIp(m[1]);
    return !/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return false;
}

// Host name or IP -> one checked public address to connect to
export async function resolvePublic(host) {
  const list = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!list.length) throw Object.assign(new Error(`Cannot resolve ${host}`), { status: 400 });
  if (process.env.CUSTOMER_SSH_ALLOW_PRIVATE !== '1') {
    const bad = list.find((ip) => !isPublicIp(ip));
    if (bad) throw Object.assign(new Error(`${host} points to a private or reserved address (${bad}). Only servers on the public internet can be connected.`), { status: 400 });
  }
  return list[0];
}

export const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
export const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

// Opens a connection. creds: { host, port, username, authType: 'key'|'password', secret, hostKey (pinned or null) }
export async function connect(creds, { timeoutMs = 15_000 } = {}) {
  const address = await resolvePublic(creds.host);
  return new Promise((resolve, reject) => {
    const c = new Client();
    let seen = null;
    let mismatch = false;
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; try { c.end(); } catch { /* closed */ } reject(err); };
    c.on('ready', () => { if (settled) return; settled = true; resolve({ conn: c, hostKey: seen }); });
    // Always listened to: ssh2 reports a refused host key (and late socket errors) here, never as an uncaught throw
    c.on('error', (err) => {
      if (mismatch) return fail(Object.assign(new Error(`The server's host key changed (pinned ${creds.hostKey}, got ${seen}). If the server was reinstalled, remove it and connect it again.`), { status: 409 }));
      return fail(Object.assign(new Error(/authentication/i.test(err.message) ? 'SSH login failed: wrong user name, key or password' : `SSH: ${err.message}`), { status: 400 }));
    });
    c.connect({
      host: address, port: creds.port || 22, username: creds.username, readyTimeout: timeoutMs, keepaliveInterval: 15_000,
      ...(creds.authType === 'key' ? { privateKey: creds.secret } : { password: creds.secret, tryKeyboard: false }),
      hostVerifier: (key) => {
        seen = fingerprint(key);
        if (creds.hostKey && creds.hostKey !== seen) { mismatch = true; return false; }
        return true;
      },
    });
  });
}

// Runs `script` with `env` (exported first) through `bash -s` (or `sudo -n bash -s` when asRoot and not root).
// Resolves { code, output }. onOutput gets text as it arrives.
export function runScript(conn, script, { env = {}, asRoot = false, username = 'root', timeoutMs = 30 * 60_000, onOutput = () => {} } = {}) {
  const cmd = asRoot && username !== 'root' ? 'sudo -n bash -s' : 'bash -s';
  const prelude = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
    return `export ${k}=${shQuote(v)}`;
  }).join('\n');
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      const add = (d) => { const t = d.toString('utf8'); output = (output + t).slice(-KEEP); onOutput(t); };
      const timer = setTimeout(() => { add(`\n[Sampanna Cloud] Stopped after ${Math.round(timeoutMs / 60000)} minutes\n`); stream.close(); }, timeoutMs);
      stream.on('data', add);
      stream.stderr.on('data', add);
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
      stream.end(`${prelude}\n${script}\n`);
      return undefined;
    });
  });
}

// One-shot: connect, run, disconnect
export async function sshRun(creds, script, opts = {}) {
  const { conn, hostKey } = await connect(creds);
  try {
    return { ...(await runScript(conn, script, { ...opts, username: creds.username })), hostKey };
  } finally {
    conn.end();
  }
}

// Facts shown for a connected server (one line per fact, parsed below)
export const FACTS_SCRIPT = `echo "@@OS $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"
echo "@@KERNEL $(uname -r)"
echo "@@CPUS $(nproc 2>/dev/null || echo 0)"
echo "@@MEM $(awk '/MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0) $(awk '/MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)"
echo "@@DISK $(df -B1 --output=size,avail / 2>/dev/null | tail -1)"
echo "@@LOAD $(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
echo "@@ROOT $( [ "$(id -u)" = 0 ] && echo yes || (sudo -n true 2>/dev/null && echo sudo || echo no))"
echo "@@TOOLS git=$(command -v git >/dev/null && echo 1 || echo 0) node=$(command -v node >/dev/null && echo 1 || echo 0) pm2=$(command -v pm2 >/dev/null && echo 1 || echo 0) docker=$(command -v docker >/dev/null && echo 1 || echo 0)"
`;

export function parseFacts(out) {
  const get = (k) => new RegExp(`^@@${k} (.*)$`, 'm').exec(out)?.[1]?.trim() || '';
  const [memTotal, memAvail] = get('MEM').split(/\s+/).map(Number);
  const [diskSize, diskAvail] = get('DISK').split(/\s+/).map(Number);
  const tools = Object.fromEntries(get('TOOLS').split(/\s+/).filter(Boolean).map((p) => p.split('=')).map(([k, v]) => [k, v === '1']));
  return {
    os: get('OS') || null, kernel: get('KERNEL') || null, cpus: Number(get('CPUS')) || 0, memTotal: memTotal || 0, memAvailable: memAvail || 0,
    diskSize: diskSize || 0, diskAvailable: diskAvail || 0, load: Number(get('LOAD')) || 0, root: get('ROOT') || 'no', tools,
  };
}
