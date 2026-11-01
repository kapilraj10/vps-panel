# Kapil Cloud

Kapil Cloud is the upgraded VPS panel: one master server (`kapil-server`) with LXD containers handed out to users.
Admins get an infrastructure console. Every user gets their own cloud dashboard showing only their own servers.

It is the **same project and the same process** as before: Express + Socket.IO + SQLite (better-sqlite3) + React/Vite/Recharts,
port 4000 on 127.0.0.1, behind the Cloudflare Tunnel. No new database, framework or daemon was added. The only new runtime
dependencies are `ws` (backend: talks to LXD's exec websockets) and `@xterm/xterm` + `@xterm/addon-fit` (frontend terminal, lazy-loaded).

---

## 1. Audit of the existing project (before the upgrade)

What was there and kept:

| Area | Finding |
|---|---|
| Stack | Express 4, Socket.IO 4, better-sqlite3, systeminformation; React 18 + Vite 5 + Recharts. Single process on 127.0.0.1:4000, PM2. |
| Auth | bcrypt (12), 256-bit session token in an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie, only an HMAC stored, per-session CSRF token + Origin check, login rate limit, audit log. Solid. |
| LXD | REST over the unix socket (no shelling out). Monitoring + start/stop/restart only. |
| Backups | Root-owned helper (`/usr/local/sbin/panel-backup`) behind a one-line sudoers rule, argument whitelisting, systemd timer, manifests with sha256, verify, restore-as-new-name, retention. Solid; **not changed** (only hooked into alerts). |
| Network | Ping + Cloudflare speed test, admin-only. Kept as is. |

Gaps and issues found:

1. Only two roles (`admin`/`user`), and a user could own exactly one container (`users.container_name`).
2. No account suspension, no session metadata (IP/device), no "last login".
3. `INGEST_TOKEN` was compared with `!==` (timing leak). **Fixed** (constant-time compare).
4. No container lifecycle beyond power: no create/delete/snapshot/clone/resize/logs/terminal.
5. Metrics only in memory (1 hour), no alerts, no service checks.
6. No apps, domains or SSH key management. No resource accounting, so nothing stopped over-allocation.
7. Host network rate counted container `veth`/bridge traffic twice. **Fixed** (those interfaces are skipped).
8. Membership of the `lxd` group is root-equivalent. Unavoidable for LXD management. It is mitigated (see §4), and the socket stays local.

Things this upgrade does not change: Nginx config, SSH config, firewall, Cloudflare Tunnel config (only touched through
the API, for managed domains, if you enable it), the backup helper, existing containers.

---

## 2. Architecture

```
browser ──HTTPS──> Cloudflare ──tunnel──> cloudflared ──> 127.0.0.1:4000  Kapil Cloud (one Node process, PM2)
                                                                │
                     ┌──────────────────────────────────────────┼─────────────────────────────┐
                     │ auth.js (sessions, CSRF, RBAC, rate limit)│ db.js (SQLite + migrations) │
                     │ servers.js  containers.js  resources.js   │ monitoring.js (metrics, alerts, services)
                     │ terminal.js apps.js  domains.js  sshkeys.js users.js  backups.js  network.js │
                     └──────────────┬───────────────────────────┴───────────────┬─────────────┘
                     LXD unix socket (lxd.js, REST + exec websockets)     sudo -n panel-backup (root helper)
```

| Module | File | What it does |
|---|---|---|
| Authentication / RBAC | `auth.js` | Sessions, CSRF, `requireAdmin`, `requireSuperAdmin`, `ownsContainer`, API rate limit (600/min/session) |
| Users | `users.js` | Admin user management, quotas, suspend, own profile/password/sessions/activity |
| Containers | `containers.js`, `servers.js`, `lxd.js` | Live polling, tracked jobs, create/delete/rebuild/clone/snapshot/resize/IP/rename/protect/logs |
| Resource allocation | `resources.js` | Host capacity vs promised limits; refuses oversubscription |
| Monitoring + notifications | `monitoring.js` | Per-minute metrics in SQLite (7 days), threshold alerts, systemd + PM2 checks, socket notifications |
| Terminal | `terminal.js` | PTY inside one container via LXD exec, relayed over the authenticated socket |
| Applications | `apps.js`, `secrets.js` | Git deploys + PM2 inside the user's container; env vars encrypted (AES-256-GCM) |
| Domains | `domains.js`, `cloudflare.js` | Requests → admin approval → tunnel route + DNS; SSL checks; drift repair |
| SSH keys | `sshkeys.js` | Validated keys, written into a marked block of `authorized_keys` |
| Backups | `backups.js` (+ root helper) | Unchanged engine; adds alerts and a read-only per-user view |
| Audit | `db.js` `audit` | Every action, success and failure, with user and IP |

### Roles

| | super_admin | admin | user |
|---|---|---|---|
| Host overview, monitoring, network, backups, audit | ✓ | ✓ | – |
| Create / clone / resize servers, set IPs, owners | ✓ | ✓ | – |
| Delete / rebuild / rename servers, (un)protect | ✓ | – | – |
| Manage `user` accounts | ✓ | ✓ | – |
| Manage admins, change roles, platform settings | ✓ | – | – |
| Start / stop / restart own servers, snapshots, terminal, apps, domains (request), SSH keys | ✓ (all) | ✓ (all) | own only |

The existing `kapil` account (role `admin`) becomes **super_admin** during migration, so it has exactly the full power it had
before. Existing `user` accounts keep their container. Every backend route checks role and ownership itself; the frontend
only hides what the server would refuse anyway.

### Security model

- **No host shell, ever.** The terminal and app deploys run through LXD `exec` *inside* a container. Containers are created
  unprivileged without nesting. For non-admins the terminal is refused on privileged containers.
- **Fixed scripts.** Deploy/PM2/runtime scripts are constant text. User values (repo, branch, commands, env) are passed as
  environment variables, never spliced into a command line. User build/start commands run as root *inside their own
  container*, which they already fully control through the terminal, so they gain nothing new.
- **LXD socket** stays a local unix socket; the browser only ever talks to the panel.
- **Ownership checks** on every route, socket event (terminal re-reads the session from the DB on open) and metrics scope.
  Asking for someone else's server returns 403 whether it exists or not.
- **Destructive actions** need the right role plus typing the exact name. Servers that existed before Kapil Cloud
  (`animesh`, `sachin`) are automatically **protected**: delete/rebuild are refused until a super admin removes protection.
  Restoring a snapshot takes a safety snapshot first; rebuild takes one first too.
- **Secrets**: app env vars and git tokens are AES-256-GCM encrypted in SQLite (`SECRETS_KEY`). They are masked in the UI;
  revealing them is audited.
- **Cloudflare**: the panel edits only tunnel rules and DNS records for hostnames it created. Existing routes
  (`panel.`, `ssh.`, `animesh.`…) are never rewritten, and a hostname that already exists is refused.
- **Rate limits**: login (5 failures / 15 min / IP), API (600 req/min/session), terminals (3 per user), socket messages (256 KB).

---

## 3. Data migration

Migrations live in `backend/db.js` (`MIGRATIONS`) and run automatically at startup, once each, in a transaction.
**Before the first one runs, the database is copied** to `backend/data/panel.db.pre-migration-<timestamp>` (mode 600).

Migration 1:
- `users` rebuilt with roles `super_admin|admin|user`, `status`, profile, quotas, last login. `admin` → `super_admin`.
- `user_containers` (many servers per user) filled from the old `users.container_name`.
- `sessions` gains `ip`, `user_agent`, `last_seen_at` (existing logins stay valid).
- New tables: `settings`, `container_meta`, `metrics`, `alerts`, `ssh_keys`, `apps`, `deployments`, `domains`.

Migration 2: `apps.output_dir`.

This exact path is tested: `npm test` starts from a database in the **old** schema with `kapil`/`animesh`/`sachin`.

---

## 4. Risks and how they are handled

| Risk | Handling |
|---|---|
| Migration breaks logins | DB copied first; transaction; FK check; tested from the old schema. Rollback restores the copy. |
| Accidental deletion of `animesh` | Auto-protected; delete needs super admin + typed name + not protected + no live domains. LXD's own `security.protection.delete` is respected too. |
| Over-allocation crashes the host | `resources.js` refuses limits beyond capacity (cores × CPU overcommit; RAM − host reserve × memory overcommit; pool size − reserve). Unlimited containers count as the whole host. |
| **Your current state is already over-allocated on CPU** | `animesh` has 4 cores = all 4 host cores. Any new server is refused until you set **Settings → CPU overcommit** (e.g. 2) or lower `animesh`'s CPU. The UI shows this. RAM: 4 GiB of ~5.7 GiB usable (7.2 GiB − 1.5 GiB reserve), so ~1.7 GiB remain for new servers. |
| Panel RAM/CPU use | No new daemons. Metrics: one SQLite row per scope per minute; services checked once a minute; SSL every 6 h; backup disk every 10 min. The terminal chunk loads only when opened. |
| Cloudflare automation breaks existing routes | Off unless `CF_*` is set. When on: read-modify-write that preserves all other rules and the catch-all, and refuses hostnames it does not own. |
| Fixed IPs clash | IP must be inside the bridge subnet, not the gateway, and not used by any instance or lease. Clones drop fixed IPs. |
| Disk shrink destroys data | Refused. |
| User escapes the container | Unprivileged containers (root inside ≠ root outside), no nesting by default, terminal refused for users on privileged containers. |

---

## 5. Deploying to kapil-server

Run these **one at a time** as `kapil` on the server. Nothing here touches Nginx, SSH, the firewall or containers.

```bash
# 0. Where are we, and is everything healthy before we start?
cd ~/vps-panel && git status && git log --oneline -1
pm2 status && curl -s http://127.0.0.1:4000/login -o /dev/null -w '%{http_code}\n'

# 1. Backups BEFORE deploying (DB + code + env). Nothing is deleted.
mkdir -p ~/panel-predeploy && TS=$(date +%Y%m%d-%H%M%S)
(cd ~/vps-panel/backend && node -e "require('better-sqlite3')('data/panel.db').backup(process.argv[1]).then(()=>console.log('DB backed up'))" "$HOME/panel-predeploy/panel-$TS.db")
cp ~/vps-panel/backend/.env ~/panel-predeploy/env-$TS && chmod 600 ~/panel-predeploy/*
git -C ~/vps-panel rev-parse HEAD > ~/panel-predeploy/commit-$TS

# 2. Get the new code (branch kapil-cloud) and install
cd ~/vps-panel && git fetch && git checkout kapil-cloud && git pull
cd backend && npm ci --omit=dev
cd ../frontend && npm ci && npm run build

# 3. New secrets (once)
cd ~/vps-panel/backend
grep -q '^SECRETS_KEY=.\+' .env || echo "SECRETS_KEY=$(openssl rand -hex 32)" >> .env
chmod 600 .env

# 4. Restart. The first start migrates the DB (and copies it first). Watch the log:
pm2 restart vps-panel && pm2 logs vps-panel --lines 30 --nostream
#    expect: "Database copied to ...pre-migration-...", "Applied migration 1", "Kapil Cloud panel running on ..."

# 5. Health checks
curl -s http://127.0.0.1:4000/healthz          # {"ok":true,"lxd":true,...}
```

Then in the browser: log in as `kapil` → Overview shows the host, `animesh` and `sachin`. Servers → animesh → Settings shows **protected**.

**PM2 restart policy** (if not already set): `pm2 restart vps-panel --max-memory-restart 400M --exp-backoff-restart-delay 1000 && pm2 save`.
The process shuts down gracefully on SIGTERM.

### User dashboard at cloud.gyannportal.com
It is the same app. Add a Cloudflare published route `cloud.gyannportal.com → http://localhost:4000`.
If Cloudflare Access protects the panel with only your email, either add users' emails to an Access policy for
`cloud.gyannportal.com`, or leave that hostname without Access (the panel login, rate limit and audit still apply).

### Optional: automatic domain routes
Create a Cloudflare API token with **Account › Cloudflare Tunnel › Edit** and **Zone › DNS › Edit** (gyannportal.com),
then set `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_TUNNEL_ID` in `backend/.env` and restart. Domains → *Tunnel routes* then lists
every rule and marks the ones Kapil Cloud manages. This only works for a **remotely-managed** tunnel (configured in the
dashboard, as yours is). For a locally-managed `config.yml` tunnel, leave it off and add routes by hand.

---

## 6. Rollback

The migrated DB has a different `users` table, so **old code needs the old DB**:

```bash
pm2 stop vps-panel
cd ~/vps-panel && git checkout "$(cat ~/panel-predeploy/commit-<TS>)"
cp ~/vps-panel/backend/data/panel.db ~/panel-predeploy/panel-after-upgrade-$(date +%s).db   # keep, never delete
cp ~/panel-predeploy/panel-<TS>.db ~/vps-panel/backend/data/panel.db                        # or the pre-migration-* copy
rm -f ~/vps-panel/backend/data/panel.db-wal ~/vps-panel/backend/data/panel.db-shm
cd backend && npm ci --omit=dev && cd ../frontend && npm ci && npm run build
pm2 start vps-panel && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/login
```

Containers, backups and Cloudflare routes created meanwhile are not removed by a rollback.

---

## 7. Testing

| Suite | Command | Result (dev machine) |
|---|---|---|
| Backend end-to-end (real server process + fake LXD over a unix socket, incl. exec websockets) | `cd backend && npm test` | 34 / 34 pass |
| Backup helper unit tests | `node --test 'system/test/*.test.cjs'` | 16 / 16 pass |
| Frontend build | `cd frontend && npm run build` | builds, no errors |

The end-to-end suite covers: migration from the old schema, auth, CSRF, Origin check, login rate limit, isolation
(every user route against another user's server), admin-only routes, allocation refusal, quotas, create/resize/IP/clone/delete,
protection, suspend, last-super-admin guards, session revoke, SSH key validation and merge, app create/encrypt/deploy via exec,
domain approval flow, terminal ownership + data flow + audit, privileged-container refusal, ingest token, health check.
`test/fake-lxd.js` is test-only and never used by the panel.

**What still needs checking on the real server** (this was built on a dev machine without LXD):
1. Container create with the real image server (first image download takes minutes).
2. Terminal + deploy against real LXD exec (same protocol as the fake, but confirm).
3. `rebuild` needs LXD ≥ 5.19 (`lxc query /1.0 | grep instance_rebuild`). Without it the panel says so and refuses.
4. Disk quotas need a pool driver that enforces them (zfs/btrfs/lvm; `dir` only with project quotas). The allocation page warns on `dir`.

UI preview locally: `cd backend && node test/demo.js` → http://127.0.0.1:4600, `kapil` / `demo-password-1` (fake data, dev only).

---

## 8. Known limitations (honest list)

- **Docker-based apps** are not offered: Docker inside LXD needs `security.nesting`, which weakens isolation. Admins can enable it
  per container with `lxc config set`, but the panel deliberately does not.
- Laravel uses `php artisan serve` under PM2: fine for small sites, not a full PHP-FPM stack.
- Restoring an **off-disk** backup is admin-only and always creates a new container (existing engine behaviour). Users restore
  their own **snapshots** themselves.
- Metrics history is 7 days of one-minute averages; the live views are 5-second samples for the last hour.
- Terminal output goes through Socket.IO; very heavy output (e.g. `yes`) is throttled by the browser connection.
