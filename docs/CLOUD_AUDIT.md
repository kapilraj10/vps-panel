# Kapil Cloud — Phase 1 Audit

Date: 2026-11-01 · Branch: `kapil-cloud` · Auditor scope: repository (complete) + server (pending, see §7)

This audit covers the repository **as it is now**: the original `vps-panel`, plus the first Kapil Cloud upgrade that sits
uncommitted on branch `kapil-cloud` (described in `docs/KAPIL_CLOUD.md`). It was done on the development machine, which has
no LXD and no `/mnt/backup`. **Nothing on kapil-server was inspected or changed.** The server half of the audit is
collected by the read-only script `system/audit-server.sh` (§7).

---

## 1. Repository

| Path | Purpose | Size |
|---|---|---|
| `backend/` | Node 24 ESM, Express 4, Socket.IO 4, better-sqlite3, systeminformation, ws, bcryptjs | ~5.3k lines, 17 modules |
| `backend/test/` | End-to-end suite (real server + fake LXD on a unix socket), demo launcher | 34 tests |
| `frontend/` | React 18, Vite 5, Recharts, socket.io-client, xterm (lazy) | ~4k lines, 20 components |
| `system/` | Root backup helper (`panel-backup`, plain Node, no deps), sudoers rule, systemd unit/timer, installer, helper tests | 1.3k + tests |
| `tracker/` | Express middleware other apps use to send request counts | small |
| `docs/` | `KAPIL_CLOUD.md` (first upgrade), this audit, architecture, roadmap | |

Git state: `main` = 4 commits (`966c98a ping test add`). The Kapil Cloud work (40 paths, ~9.8k lines) is **not committed**.
That has to be resolved before more phases are stacked on it (see roadmap, decision D1).

## 2. Runtime architecture today

One Node process (PM2 name `vps-panel`) on `127.0.0.1:4000`, reached only through the Cloudflare Tunnel.
It talks to LXD directly over `/var/snap/lxd/common/lxd/unix.socket` (REST + exec websockets), to the backup engine through
`sudo -n /usr/local/sbin/panel-backup` (single whitelisted root helper), to `systemctl`/`pm2`/`ping` with argument arrays,
and to Cloudflare's API (optional). State lives in SQLite (`backend/data/panel.db`, WAL, mode 600) with numbered migrations
that copy the DB before running.

### Modules

| Module | File(s) | Status |
|---|---|---|
| Auth, sessions, CSRF, RBAC, rate limit | `auth.js` | Done: 3 roles, HMAC'd session tokens, `__Host-` cookie, CSRF token + Origin, login lockout per IP, 600 req/min/session |
| Users, quotas, sessions, profile | `users.js` | Done: suspend/activate, last-super-admin guards, typed-confirm delete, own sessions list/revoke |
| Containers (LXD) | `lxd.js`, `containers.js`, `servers.js` | Done for **one node**: create/start/stop/restart/freeze/delete/rebuild/clone/snapshot/restore/resize/IP/rename/protect/logs |
| Resource allocation | `resources.js` | Done: limits vs capacity with overcommit settings. **Gap: ignores real usage, swap and memory pressure** |
| Monitoring + alerts | `monitoring.js` | Done: per-minute metrics 7 days, thresholds, systemd + PM2 checks, socket notifications |
| Terminal | `terminal.js` | Done: LXD exec PTY in one container, idle/max timeouts, audited |
| Apps | `apps.js`, `secrets.js` | Done: git deploy + PM2 inside the user's container, AES-GCM secrets, deploy history. **Gap: no rollback, no templates for DBs/WordPress/Django/Flask, no health checks** |
| Domains | `domains.js`, `cloudflare.js` | Done: request → approve → tunnel route + DNS, SSL check, drift repair. **Gap: no ownership verification, no DNS record editor** |
| SSH keys | `sshkeys.js` | Done |
| Backups | `backups.js` + `system/panel-backup` | Done (engine unchanged since before the upgrade): containers, host rsync, Docker DBs, PM2; verify; restore-as-new |
| Network tools | `network.js` | Done: ping, speed test (admin) |

### API inventory (current)
About 100 routes. All under `/api`, session cookie auth, no versioning. Public: `POST /api/login`, `POST /api/logout`,
`POST /api/ingest` (token), `GET /healthz`, `GET /login`. Socket events: `term:*`, `container:*`, `sample`, `alert`, `app:*`,
`backup:*`, `net:speed`, `services`. Full list is generated from code in `docs/API.md` (Phase 2 deliverable).

### Database (schema version 2)
`users`, `user_containers`, `sessions`, `audit`, `backup_jobs`, `schema_migrations`, `settings`, `container_meta`,
`metrics`, `alerts`, `ssh_keys`, `apps`, `deployments`, `domains`. Before the first start of the upgraded code, production
still has the original schema (`users.container_name`, roles `admin|user`). Migration 1 converts it and copies the DB first.

## 3. Security review

Severity: **H** high · **M** medium · **L** low. "Fixed" = already fixed in the `kapil-cloud` branch.

| # | Sev | Finding | Status / plan |
|---|---|---|---|
| S1 | **H** | The web process runs as `kapil`, who is in the `lxd` group (and, on the dev box, `docker`). Both groups are root-equivalent, so any RCE in the web app is host root. | Plan (Phase 2/3): move every privileged call into a **node agent** with a fixed job whitelist; the web process then leaves the `lxd`/`docker` groups. See architecture §3. |
| S2 | M | No second factor; a stolen password = full admin. | Phase 2: TOTP 2FA + recovery codes, enforceable for admins. |
| S3 | M | Login lockout and API rate limits are in memory (reset on restart). | Acceptable for one process; Phase 2 persists lockouts. |
| S4 | M | No ownership proof for custom domains (admin approval only). | Phase 5: TXT-record verification. |
| S5 | M | Admins may open a terminal in privileged containers. Root in a privileged container ≈ host root. | By design for admins; containers created by the panel are unprivileged. Audit script reports any privileged instance. |
| S6 | L | App build/start commands run as root inside the tenant's container. | Same trust as the tenant's terminal; no cross-tenant effect. Resource limits contain it. |
| S7 | L | No password reset / email verification (no mail transport). | Phase 2 (tokens) + needs SMTP credentials (decision D4). |
| S8 | L | `INGEST_TOKEN` compared with `!==`. | **Fixed** (constant-time). |
| S9 | L | Host network rate double-counted container veth traffic. | **Fixed**. |
| S10 | info | LXD socket, Docker socket, backup helper: all local only; nothing listens on a public interface (panel binds 127.0.0.1). | Keep. Verify with `ss -tln` from the audit script. |

Checked and fine: parameterised SQL everywhere; no `exec`/shell strings (all `execFile`/argv or fixed scripts with env
values); CSP `default-src 'self'`; `X-Frame-Options: DENY`; cookies `HttpOnly; Secure; SameSite=Strict`; socket handshake
origin check; every container route checks ownership before existence (no enumeration); audit log is append-only from the API
(no route edits or deletes it).

## 4. Resource reality (from the brief; to be confirmed by the server report)

| | Host | animesh | Left |
|---|---|---|---|
| CPU | 4 cores | `limits.cpu=4` | **0 cores** at overcommit 1 |
| RAM | 7.2 GB | `limits.memory=4GiB`, reported "high % used" | ≈1.7 GiB after a 1.5 GiB host reserve, **before** counting what the host itself (PM2 apps, Docker DBs, panel) really uses |
| Disk | ~177 GB free | 100 GB quota | depends on the LXD pool driver (thin pools only consume what is written) |

Consequences:
1. With the current safe defaults the panel will (correctly) refuse any new server. Capacity for customers needs either a
   second node or explicit overcommit decisions.
2. The allocator must also look at **real** memory: `MemAvailable`, swap in use, and `/proc/pressure/memory`
   (PSI). If the host is already under memory pressure, provisioning must stop even if the promised limits look fine.
   Planned for Phase 2.
3. If `sachin` (mentioned in the README) still exists without limits, it counts as "the whole host" and blocks everything.
   The server report shows this.

## 5. Brief vs. what exists

| Brief section | Exists | Missing |
|---|---|---|
| 3 Admin dashboard | host + fleet metrics, alerts, allocation | nodes, subscriptions, revenue |
| 4 VPS marketplace | admin provisioning, statuses via jobs | plans, customer ordering, approval queue, persisted provisioning state machine with idempotency |
| 5 Multi-node | – | everything (registry, agent, heartbeat, job queue, failure detection) |
| 6 Docker manager | Docker DB backups only | everything |
| 7 App marketplace | 8 runtime types, git deploy, logs, history | DB templates, WordPress, Django/Flask, health checks, rollback |
| 8 File manager | – | everything |
| 9 DNS & SSL | tunnel routes, SSL check | ownership verification, DNS record editor, Let's Encrypt for non-tunnel nodes |
| 10 Firewall & security | audit log, login history | UFW view/apply with rollback, tenant network ACLs, security reports |
| 11 Backups | full engine + snapshots | per-tenant schedules, Docker volume selection per tenant, offsite destinations |
| 12 Storage quotas | per-container disk quota, usage | per-user usage view for admin, large-directory finder |
| 13 Billing | – | everything |
| 14 Users | roles, suspend, sessions | registration, email verification, password reset, 2FA, API keys |
| 15 Support | – | everything |
| 16 Notifications | in-app alerts (socket) | notification center (persisted per user), email, job queue |
| 17 API & automation | – | API keys, scopes, versioning, webhooks, docs |

## 6. Infrastructure facts already known from the repository

- Cloudflare Tunnel publishes `panel.gyannportal.com` → `http://localhost:4000`. README step 11 advises Cloudflare Access
  restricted to Kapil's email; if that is in place, customers cannot reach the login page until a second hostname/policy exists.
- Backups: helper installed at `/usr/local/sbin/panel-backup`, config `/etc/panel-backup/config.json`, state
  `/var/lib/panel-backup`, timer `panel-backup.timer`; Docker DB containers are discovered and dumped.
- The panel user needs `lxd` group membership; PM2 runs under `kapil` (`pm2-kapil.service`).

## 7. Server audit — to run on kapil-server

`system/audit-server.sh` is **read-only**: no installs, restarts, writes or rule changes; it never prints passwords, keys,
tokens, env values or tunnel credentials (tested on the dev box: no secret values in the output).

```bash
sudo -v                                   # lets the few read-only sudo checks (ufw status, sshd -T, nginx -t, panel-backup disk-status) run
bash ~/vps-panel/system/audit-server.sh   # prints the report path: ~/kapil-cloud-audit-<time>.txt (mode 600)
```

It reports: CPU/RAM/swap/PSI, disks and `/mnt/backup`, KVM capability, LXD version/extensions/pools/networks/profiles,
each instance's limits, security flags, devices, live memory/swap/disk and snapshot count, Docker containers/volumes/networks,
PM2 processes (names/status only), panel git state, `.env` key names (not values), panel DB schema and users (no hashes),
backup disk status, Nginx server names/listeners/proxy targets, cloudflared mode (remote vs `config.yml`), listening ports,
UFW/nftables/iptables, effective sshd settings, fail2ban, failed units and recent errors.

**Open items until that report is in:** LXD version (rebuild support, network ACL support), pool driver (quota
enforcement), whether `sachin` exists, real host memory headroom, tunnel mode (remote API automation only works for
remotely-managed tunnels), current firewall and SSH policy (must be preserved exactly).
