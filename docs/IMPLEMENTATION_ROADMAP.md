# Kapil Cloud — Implementation Roadmap

Status legend: ✅ done (tested) · 🟡 partial · ⬜ not started. "Tested" means executed in this repository's test suites;
nothing is tested against the real kapil-server until it is deployed there.

## Decisions needed from Kapil

| # | Decision | Why it blocks |
|---|---|---|
| D1 | Commit the `kapil-cloud` work so far (40 paths uncommitted) | Every later phase builds on it; uncommitted work can be lost |
| D2 | Run `system/audit-server.sh` on kapil-server and share the report | LXD version, pool driver, real memory headroom, tunnel mode, firewall/SSH baseline |
| D3 | Customer sign-up: public registration, or invite / admin approval only | Abuse risk on a 7 GB host |
| D4 | SMTP provider + sender address | Email verification, password reset, email notifications |
| D5 | eSewa / Khalti merchant (sandbox first) credentials | Billing can only be activated with real server-side verification |
| D6 | Docker for customers = nesting enabled in their container (weaker isolation) — allow on some plans? | Docker Manager for tenants |
| D7 | Second physical node (when) | Customers need capacity the master does not have |

## Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | First Kapil Cloud upgrade: RBAC (3 roles), multi-server users, quotas, container lifecycle, snapshots, allocation, terminal, apps (git + PM2), domains via tunnel, SSH keys, monitoring + alerts, premium UI, 34 e2e tests | ✅ (uncommitted, D1) |
| 1 | Audit: `CLOUD_AUDIT.md`, `CLOUD_ARCHITECTURE.md`, this roadmap, read-only `system/audit-server.sh` | ✅ repo · ⬜ server report (D2) |
| 2 | Core: persisted job queue with idempotency, node registry + enrollment + agent + heartbeat + offline alerts, TOTP 2FA + recovery codes, API keys + `/api/v1` + scopes, pressure-aware allocation, notification center (in-app), `docs/API.md` / `MULTI_NODE.md` / `SECURITY.md` | next |
| 3 | Plans + VPS marketplace (order → approval → provisioning job with rollback), per-node placement, full instance ops via agent, master moved onto its local agent (drop `lxd` group), Docker Manager (admin host + tenant-in-container) | ⬜ |
| 4 | App templates (Next/React/Node/Express/Nest/Laravel/Python/Django/Flask/static + Postgres/MySQL/Redis/Mongo/WordPress), releases + rollback, health checks, File Manager, Database Manager | ⬜ |
| 5 | Domain ownership (TXT), Cloudflare DNS record editor, SSL status/renewal (Let's Encrypt only for non-tunnel nodes), Firewall: UFW view + plan/apply with automatic rollback, tenant network ACLs, Security Center | ⬜ |
| 6 | Per-tenant backup schedules + retention, Docker volume backups per tenant, offsite destination interface (rclone/S3-compatible), restore history | ⬜ |
| 7 | Plans/subscriptions/invoices (PDF), eSewa + Khalti behind the provider interface (sandbox), coupons, ledger, support tickets, email notifications | ⬜ (needs D4, D5) |
| 8 | UI for everything above (same design system) | per phase |
| 9 | Tests per phase: unit + API + e2e against fake LXD/agent; payment providers against their sandboxes | per phase |
| 10 | Production rollout per phase: backup → deploy → verify → rollback plan (`docs/DEPLOYMENT.md`, `docs/ROLLBACK.md`) | per phase |

## Rules that hold for every phase
* No production change without a verified backup, a saved config, documented rollback commands and Kapil's approval.
* Never delete or recreate existing containers, users or backups; never reset passwords; never touch SSH or tunnel routing
  without approval.
* Billing stays disabled (admin approval flow) until a provider is configured **and** verified in its sandbox.
* A feature is "done" only when its buttons do the real thing against the real backend and its tests ran.

---

## Host management brief (2026-11-05): status per phase

The second brief asks for full control of the VPS itself (PM2, Docker, replicas, Nginx, backups, databases, deploys, SSL,
files, terminal, roles). Status against it. "Tested" means the e2e suites (fake PM2 / Docker / Nginx / LXD), not the real server.

| Brief phase | What exists | Status |
|---|---|---|
| 1 Audit | `CLOUD_AUDIT.md` (repo), `system/audit-server.sh` (server report still not run, D2) | ✅ repo · ⬜ server |
| 2 Schema / migrations | Numbered migrations with pre-migration DB copy; migration 4 = `host_apps`, `app_replicas`, `app_events` | ✅ for what is built |
| 3 VPS + SSH | Primary node (host metrics, services, LXD servers, SSH keys). Multi-node registry/agent | 🟡 single node |
| 4 PM2 + Docker | **PM2 Manager** (list/start/stop/restart/reload/delete/scale/logs/flush/save/resurrect/new) and **Docker Manager** (containers + live CPU/RAM, create/start/stop/restart/remove/logs/inspect, images pull/build/remove, volumes, networks, Compose projects) | ✅ tested · ⬜ container exec terminal |
| 5 Replicas + LB | Primary + replicas as real PM2 processes or Docker containers, conflict-free ports, Nginx upstream with weights / standby / disable, `nginx -t` + reload with rollback, health checks + automatic failover + alerts, rolling restart, Docker rolling update with per-instance rollback, traffic charts from Nginx logs | ✅ tested · needs `system/install-lb.sh` on the server |
| 6 Backups + DB manager | Backup engine (containers, host files, Docker DB dumps, PM2) existed before. Per-app schedules, S3/SFTP destinations, Postgres/MySQL user + permission manager | 🟡 / ⬜ next |
| 7 Deploy + rollback | LXD apps: git deploy. Host apps: Docker image rollout with rollback. Git pipeline for host apps (pull → build → test → deploy → health → switch → rollback) | 🟡 next |
| 8 Domains + SSL | Tunnel routes + DNS + SSL expiry check (LXD apps). Host-app domains via LB `server_name` + tunnel route by hand | 🟡 |
| 9 Monitoring + terminal | Host + container metrics 7 days, alerts, LXD terminal. File manager, host terminal | 🟡 / ⬜ |
| 10 Security | Sessions, CSRF, RBAC (super_admin/admin/user), audit, rate limits, encrypted secrets, restricted command runner. TOTP 2FA, DEVELOPER/VIEWER roles, configurable permissions | 🟡 next |
| 11 Production docs | `docs/HOST_APPS.md` (setup + rollback), `.env.example` | 🟡 |

Recommended next order: (a) run `audit-server.sh` + `install-lb.sh --check` on the server and deploy this phase;
(b) Database manager (Postgres/MySQL: create DB/user, least-privilege grants, native dumps) + per-app backup schedules;
(c) git deploy pipeline for host apps; (d) 2FA + DEVELOPER/VIEWER roles; (e) file manager + host terminal.

---

## Multi-VPS brief (2026-11-05, second pass): status

| Brief section | Status |
|---|---|
| 1 Multi-VPS registry (add/edit/remove, primary, connect/disconnect, test SSH/agent) | ✅ tested (docs/FLEET.md) |
| 2 Browser SSH console (tabs, resize, reconnect, timeouts, audit, full screen) | ✅ tested |
| 3 Real-time monitoring per VPS (CPU/per-core/RAM/swap/disks/IO/network/ports/processes/system) | ✅ tested; history per minute + hourly |
| 4 Network diagnostics (ping, traceroute/tracepath, DNS, TCP, HTTP(S), speed test, matrix) | ✅ tested (speed test not in CI) |
| 5 Uptime & incidents, alerts | ✅ tested; webhook ✅, email ⬜ (SMTP) |
| 6 Comparison dashboard | ✅ |
| 7 Main VPS as control plane, nodes independent | ✅ (agents dial out; apps never depend on the panel) |
| 8 PM2 across servers | ✅ list/logs/start/stop/restart/reload/delete/flush/save (scale ⬜) |
| 9 Docker across servers | 🟡 list/logs/start/stop/restart; create/remove/images/compose on remote nodes ⬜ |
| 10 Cross-server replicas | ⬜ next |
| 11 Global traffic management | ⬜ (single-host Nginx LB exists; global needs Cloudflare LB or an edge Nginx) |
| 12 Global backups | ⬜ |
| 13 App monitoring across servers | 🟡 PM2/Docker status per node; HTTP health of remote apps ⬜ |
| 16 Agent | ✅ (version reported; self-update ⬜) |

---

## Platform brief (2026-11-07): status

| Item | Status |
|---|---|
| Server count 0 / backups not running on cloude | cause: `STAGING_MODE=1` in its .env (containers, backups, monitoring off). Fix = remove it on the server |
| Master server, location Kathmandu | ✅ one-click setup (docs/PLATFORM.md) |
| Databases: PostgreSQL / MySQL / MongoDB from the panel | ✅ tested (Docker on the master; in daily backups) |
| Host terminal | ✅ via SSH console to the master (panel key, audited) |
| Firewall (UFW) manager | ✅ tested with a fake helper; real UFW ⬜ on the server |
| Fail2ban + panel login blocks | ✅ tested (fake helper) |
| 2FA (TOTP + recovery codes + require for admins) | ✅ tested |
| Security check page | ✅ tested (fake helper) |
