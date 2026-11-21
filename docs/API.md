# Sampanna Cloud API (multi-tenant parts)

All routes are under `/api`, JSON in and out, session cookie + `x-csrf-token` header for anything that changes state.
Roles: **customer** (`user`), **admin** (read most things), **super admin** (everything). "Own" = rows of the
logged-in customer; other customers' rows answer 404/403. Money is in **paisa** (1/100 NPR). Older routes (servers,
fleet, PM2, Docker, backups, security) are unchanged; see the code next to each router.

## Public
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/public/info` | anyone | name, sign-up settings, active plans with prices, support contact |
| POST | `/register` | anyone | `{fullName, email, username, password}` → customer account (5/IP/hour, honeypot `website`) |

## Applications
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/apps` | all | own apps (admins: all) with `target` main / vps / server, package, VPS name |
| POST | `/apps` | all | create. `target: 'main'` + `planId` (first app picks the hosting package) · `target: 'vps'` + `serverId` · `target: 'server'` + `container`. Fields: `name, type (node, express, nestjs, nextjs, react, static, python, laravel, docker), repoUrl, branch, rootDir, outputDir, installCmd, buildCmd, startCmd, port, env, gitToken`. Repo + branch checked with `git ls-remote` |
| PUT | `/apps/:id` | owner | change settings (re-checks the repo when it changes) |
| POST | `/apps/:id/deploy` · `/runtime` · `/start` · `/stop` · `/restart` | owner | recorded deployments, live log over the socket (`app:log`). A deploy in an LXD container also forwards the port and health-checks it from the host (see PORT_FORWARDING.md) |
| GET | `/apps/:id` · `/apps/:id/deployments/:dep` · `/apps/:id/logs` · `/apps/:id/env` | owner | details, history, logs, env (masked; `?reveal=1` audited) |
| GET | `/apps/:id/stats` | owner | live CPU / RAM / restarts |
| GET | `/apps/:id/network` | owner | container, container IP, port, tunnel target `http://localhost:<port>`, proxy device state (`ok` / `other` / `different` / `missing`) and any host-port conflict |
| POST | `/apps/:id/forward` | owner | "Fix port forwarding": (re)creates the LXD proxy device `port<PORT>` and re-points the app's domains; returns `{log, network}` |
| POST | `/apps/:id/move` | super admin | `{target, planId?, serverId?, container?}` |
| DELETE | `/apps/:id` | owner | `{confirm: name}`; the last main-server app ends the package |
| GET / PUT | `/hosting` | customer | hosting package: current, apps used, available; change (resizes the app host) |

## Databases
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/databases` · `/databases/options` | all | own (admins: all); engines postgres, mysql, mongo, redis; plans |
| POST | `/databases` | customer / super admin | main: `planId` (customers) · VPS: `target: 'vps', serverId` |
| GET | `/databases/:id/credentials` | owner / super admin | connection details (audited) |
| GET | `/databases/:id/stats` · `/logs` | owner / admin | live usage, logs |
| POST | `/databases/:id/start` · `/stop` · `/restart` | owner / super admin | |
| GET | `/databases/:id/dump` | owner / super admin | fresh gzip dump (main server) |
| POST | `/databases/:id/restore?confirm=<name>` | owner / super admin | raw body = dump (.gz detected) |
| DELETE | `/databases/:id` | owner / super admin | `{confirm, deleteData?}` |

## My VPS servers (customer-owned)
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/my-servers` · `/my-servers/:id` | customer (own) / admin (all) | never includes keys or passwords |
| POST | `/my-servers` | customer | `{name, host, port, username, authType: key/password, privateKey/password}`; verified first; host key pinned; public addresses only; 10 attempts/hour |
| PUT | `/my-servers/:id` | owner | new credentials (verified, same host key) |
| POST | `/my-servers/:id/check` · `/prepare` | owner | health check; install git/Node/PM2/Python/Docker |
| DELETE | `/my-servers/:id` | owner / super admin | `{confirm}`; refused while apps/databases use it |

## Domains
| Method | Path | Who | What |
|---|---|---|---|
| GET / POST | `/domains` | all | request `{hostname, appId}` or `{hostname, container, port}`; custom domains get a TXT challenge |
| POST | `/domains/:id/verify` | owner | checks `_sampanna-verify.<host>` TXT (and the A record for VPS apps) |
| POST | `/domains/:id/approve` · `/reject` · `/resync` | admin | routes verified domains through the tunnel |

## Billing
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/billing/me` | customer | wallet, billed services, transactions |
| GET | `/billing/plans` | all | plans (customers: active only) |
| POST / PUT / DELETE | `/billing/plans[/:id]` · POST `/billing/plans/starter` | super admin | plans incl. `maxApps` for hosting packages |
| GET | `/billing/overview` · `/billing/users/:id` | admin | wallets, totals |
| POST | `/billing/users/:id/tx` | super admin | `{kind: topup/refund/adjust, amount, note}` (audited) |
| POST / DELETE | `/billing/resources[/:id]` | super admin | bill an existing server/database, change its price, stop billing it |
| PUT | `/billing/settings` | super admin | currency, grace hours, minimum days, low-balance days, rates |
| GET | `/billing/invoices[?user=]` · `/billing/invoices/:id` | own / admin | monthly invoices + month so far |
| POST | `/billing/invoices/run` | super admin | write last month's invoices now (idempotent) |

## Dashboards
| GET | `/overview` | all | admins: host + platform business numbers; customers: own totals + wallet |
|---|---|---|---|
| GET | `/admin/users/:id/cloud` | admin | a customer's apps, databases, VPS, package, wallet |
