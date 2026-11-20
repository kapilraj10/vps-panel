# Sampanna Cloud: multi-tenant hosting plan (brief of 2026-11-20)

Phase 1 of the brief: what already exists, what is missing, and the order of work. Nothing in this brief replaces
working code; each phase extends it and keeps the e2e tests green.

## What exists (reused, not rebuilt)

| Area | Existing implementation |
|---|---|
| Auth, RBAC, tenancy | Sessions + CSRF, roles super_admin / admin / user, `ownsContainer` checks, 2FA, rate limits, audit log (`auth.js`, `users.js`) |
| Main server hosting | Per-user unprivileged LXD **app host** `apps-<user>` (`apphost.js`): created on the first app, resized by plan, deleted with the last app. Apps never run on the host itself |
| Deploys | Git clone/fetch, install, build, PM2 start inside the container; logs streamed live; deployment history (`apps.js`) |
| Ports, subdomains, SSL | Port picked automatically in the app host; `<app>-<user>.<suffix>` routed through the Cloudflare Tunnel with Cloudflare SSL (`domains.js`, `cloudflare.js`) |
| Managed databases | PostgreSQL / MySQL / MongoDB in Docker on the main server, owner-scoped, encrypted credentials, bridge-only binding, nightly dumps (`databases.js`, `system/panel-backup`) |
| Wallet + billing | NPR prepaid wallet, hourly settlement to the exact daily price, grace period, stop (never delete), resume on top-up (`billing.js`) |
| Servers | LXD containers with quotas and allocation checks; fleet of nodes with agents, metrics, SSH console (`servers.js`, `nodes.js`, `sshconsole.js`) |
| Admin | Users, servers, fleet, monitoring, backups, security center, billing & plans, audit |
| Public | Landing page, self sign-up |

## Gaps against the brief, and where they go

| # | Gap | Phase |
|---|---|---|
| G1 | Billing idempotency: two settlements racing could both charge the same hour | 2 |
| G2 | Hosting **packages** (Starter: 1 app, Professional: 5 apps, ...) instead of a price per app; plan limits `max_apps`, `max_databases` | 2 + 4 |
| G3 | Customer-owned VPS (`customer_servers`): SSH key/password encrypted, host key pinned, verify before save, never returned by the API | 2 + 5 |
| G4 | Databases: Redis engine, target (main / my VPS), restore from a dump, resource usage | 2 + 6 |
| G5 | Invoices (monthly statement per user) | 2 + 7 |
| G6 | Customer commands must not run as root: builds/starts in the app host run as an unprivileged `app` user | 4 |
| G7 | Docker runtime (Dockerfile in the repo) for main server and VPS | 4 / 5 |
| G8 | Validate Git access before saving (`git ls-remote` from the panel) | 4 |
| G9 | Per-app CPU / RAM on the dashboard | 4 / 7 |
| G10 | Deploy apps and databases to the customer's VPS over SSH (PM2 / Docker) | 5 / 6 |
| G11 | Admin dashboard: revenue, wallet stats, apps/databases/VPS totals; per-user view of apps, databases, VPS, wallet | 3 |
| G12 | Sidebars as in the brief (customer: Overview … Support; admin: Dashboard … System settings) | 3 |
| G13 | Admin: move an app between targets, change app resource limits | 7 |
| G14 | Domains: custom domain with DNS instructions + verification (TXT), per-app assignment | 8 |
| G15 | Low-balance notifications in the panel | 7 |
| G16 | API documentation, security review | 9 |

## Decisions

- **Main server isolation** stays the LXD app host per user (stronger than a directory per app: own PID/network/filesystem
  namespace, hard RAM limit). Inside it, apps get a directory each and run as user `app` (G6).
- **Packages**: an "app" plan is a hosting package: CPU/RAM/disk for the user's app host + `max_apps` + a daily price.
  A user has at most one package; changing it resizes the host. Billing is per package, not per app.
- **Customer VPS** are reached over SSH from the panel (no inbound port on the customer side besides SSH). The panel's
  own fleet (`nodes`) stays admin-only and separate, so no customer can ever reach an admin node.
- **Subdomains** stay one label deep (`<app>-<user>.<domain>`): Cloudflare's free certificate covers `*.domain`, while
  `user.apps.domain` would need a paid Advanced Certificate. The suffix is a setting, so `apps.<domain>` can be used later.
- **No TypeScript** in this project (plain ES modules); "fix TypeScript errors" maps to `node --check` + the test suites.

## Phase status

| Phase | Status |
|---|---|
| 1 Inspect + plan | ✅ this document |
| 2 Schema + authorization | ✅ migration 9 (packages: plans.max_apps/max_databases, users.hosting_plan_id; customer_servers; databases.target/server_id + Redis; invoices), idempotent settlement (test/billing-unit.test.js) |
| 3 Admin + customer panels | ✅ sidebars as in the brief (admin: Customers / Billing / Infrastructure / Tools / Administration; customer: Overview, Applications, Databases, My VPS, Cloud servers, Domains, Backups, Plans & billing, Usage, Settings, Support); admin dashboard: revenue this month, earning per day, wallets (empty / suspended), customer apps by target, databases, customer VPS, active packages; customer overview: wallet, apps, databases, VPS, quick actions; per-customer cloud view in Users; app search + target filter; Support page (contact set in Settings) |
| 4 Main server deployment engine | ✅ hosting packages (one per user, max apps, upgrade resizes the host, ends with the last app), customer commands run as user `app` (not root) in the app host, `git ls-remote` check before saving, live per-app CPU/RAM. Docker runtime: phase 5 (needs nesting decision) |
| 5 Customer VPS engine | ✅ `myservers.js` + `sshexec.js`: connect over SSH (key or password, verified before saving, sealed, host key pinned, public addresses only), health check every 5 min, Prepare (git/Node/PM2/Python/Docker), deploy/redeploy/start/stop/logs/stats over SSH (apps under ~/apps for non-root users); Docker (Dockerfile) runtime on VPS, own servers and the main server (nesting turned on in that user's app host). Tests: `myservers.test.js` (real SSH server running the scripts), `scripts.test.js` |
| 6 Managed databases | ✅ Redis engine (password via env, AOF), databases on the customer's VPS (Docker there, 127.0.0.1, docker group or sudo), live CPU/RAM per database, Download dump (fresh, gzip), Restore from an uploaded .sql/.archive(.gz) with typed confirmation (PostgreSQL/MySQL/MongoDB), Redis in nightly dumps. Plain admins read; owner or super admin act |
| 7 Billing + monitoring | ✅ monthly invoices in Nepal time (idempotent, printable), month-so-far statement, admin alerts (dashboard + webhook) when a wallet runs out / services stop, low-balance / grace / stopped banner for customers, hosting package card with upgrade, super admin moves apps between main server / customer VPS / cloud server. Live CPU/RAM per app and per database (phases 4, 6) |
| 8 Domains + SSL | ✅ custom domains: TXT `_sampanna-verify.<host>` proves ownership before an admin can route it; DNS instructions with copy buttons; domains for apps on any target incl. the customer's VPS (A record checked, SSL by certbot there); platform subdomains auto-routed with Cloudflare SSL (earlier); migration 10. Test: fake DNS server (`test/fake-dns.js`) |
| 9 Tests, security review, docs | ✅ see below; API in `docs/API.md`; new env settings in `backend/.env.example` |

## Security review (phase 9)

| Risk | Control |
|---|---|
| Tenant data leaks | Every route checks ownership (`ownsContainer` or `user_id`), other tenants' rows answer 404/403; tests try cross-tenant access for apps, databases, VPS, domains, credentials |
| Root execution of customer code | Main-server apps run as user `app` (runuser) in an unprivileged LXD container per customer; terminal and container tools are refused there for customers |
| Command injection | Scripts are fixed text; values travel as environment / `export NAME='quoted'` lines on stdin; `scripts.test.js` runs an injection attempt through the branch name |
| SSRF through the panel | Customer VPS and repository hosts must resolve to public addresses (no LXD bridge, localhost, link-local/metadata, CGNAT); the checked address is the one connected to |
| Password guessing via "Connect a VPS" | 10 attempts with new credentials per customer per hour; all attempts audited |
| Stolen credentials | SSH keys/passwords, DB passwords, git tokens, env values sealed with AES-256-GCM; never returned except DB credentials to the owner (audited) |
| Man-in-the-middle to a customer VPS | Host key pinned on first connect; a different key is refused (`host_key_changed`) |
| Double charging | Settlement only moves `billed_until` if it is unchanged (`billing-unit.test.js`); invoices unique per user + month |
| Unpaid services | Grace period, then stop — never delete; resume after top-up |
| Domain hijack | Custom domains need a TXT proof before an admin can route them |
| Open sign-up abuse | Per-IP limit, honeypot, unique email, reserved names, empty wallet (nothing runs without money), optional admin approval |

Known limits: Docker apps on the main server need nesting in that customer's app host (still unprivileged); apps on a
customer VPS are reached on the VPS's own address (the panel does not proxy them); live usage of VPS apps opens an
SSH connection per refresh.

## Deploying this

Migrations 7–10 run by themselves on the first start (a copy of the database is made first). On the server also:
re-run `sudo system/install-backups.sh` (Redis and in-container database dumps), make sure `git` and the `docker` CLI
are installed for the panel user, and set `CF_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_TUNNEL_ID` for automatic subdomains.
