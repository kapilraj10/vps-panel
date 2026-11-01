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
