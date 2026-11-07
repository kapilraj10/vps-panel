# Kapil Cloud — Architecture

Guiding constraints: one modest master server (4 cores, 7.2 GB), keep the existing stack (Express + SQLite + React),
no microservices, no heavy daemons, nothing privileged exposed to the network, and every phase deployable on its own.

## 1. Big picture

```
                         Cloudflare (TLS, Access)            ┌──────────── kapil-server (master) ─────────────┐
 browser ── HTTPS ──────────────► tunnel ──────────────────► │ control plane: Node process, 127.0.0.1:4000     │
 CLI / API key ── HTTPS ─────────►   │                       │   HTTP API /api (session) + /api/v1 (API keys)  │
                                     │                       │   Socket.IO (UI live data, terminal)            │
                                     │                       │   SQLite (WAL) · job queue · notifier           │
                                     │                       │        ▲ ws (loopback)                          │
                                     │                       │   node agent (local) ── LXD socket, Docker sock │
                                     │                       │                        └ sudo panel-backup      │
                                     │                       └─────────────────────────────────────────────────┘
 node-2 ── agent ── outbound WSS ────┘ (agent dials the master; nodes open no inbound ports)
```

* **Control plane** = the existing panel process. It owns users, billing, plans, the job queue, the database and the UI.
* **Node agent** (`agent/kapil-agent.js`) runs on every node, **including the master**. It is the only process that touches
  LXD, Docker or the backup helper. It accepts a fixed list of typed operations from the control plane and refuses anything
  else. It never offers a shell or "run this command" operation.
* **Agents dial out** to the control plane over WSS (through the same Cloudflare hostname). Nodes behind NAT work, no
  management port is opened anywhere, and the LXD/Docker sockets stay local unix sockets.

### Migration path (no big bang)
Today the control plane calls LXD directly. Phase 2 introduces the node registry, agent, heartbeat and job queue, and
registers the master as node #1 (`kapil-server`, driver `local`). Remote nodes use driver `agent`. Phase 3 moves the master
onto its own local agent too. After that the web process drops the `lxd` and `docker` groups, which fixes audit finding S1.

## 2. Services (modules inside one process)

| Service (brief name) | Module | Notes |
|---|---|---|
| AuthService | `auth.js`, `twofa.js`, `apikeys.js` | sessions, CSRF, RBAC, TOTP 2FA, API keys with scopes |
| UserService | `users.js` | |
| NodeService | `nodes.js` | registry, enrollment, heartbeat, health, offline detection |
| ContainerService | `containers.js`, `servers.js`, `lxd.js` | per-node driver (`local` direct / `agent` RPC) |
| VPSProvisioningService | `provisioning.js` (Phase 3) | plan → node placement → job → state machine |
| ResourceAllocationService | `resources.js` | limits vs capacity **and** live pressure (MemAvailable, swap, PSI) |
| DockerService | `docker.js` via agent (Phase 3) | |
| ApplicationDeploymentService | `apps.js` | templates, releases, rollback (Phase 4) |
| FileManagerService | `files.js` (Phase 4) | LXD file API, instance-scoped |
| DomainService / DNSService / SSLService | `domains.js`, `cloudflare.js` | ownership TXT, record editor (Phase 5) |
| FirewallService | `firewall.js` + root helper (Phase 5) | plan/validate/apply with dead-man rollback |
| BackupService | `backups.js` + `panel-backup` | unchanged engine, per-tenant view |
| BillingService / SubscriptionService | `billing/*` (Phase 7) | provider abstraction, append-only ledger |
| MonitoringService | `monitoring.js` | |
| NotificationService | `notify.js` | persisted per-user notifications, email via queue |
| SupportService | `support.js` (Phase 7) | |
| AuditService | `db.js audit` | append-only, no update/delete route |
| JobService | `jobs.js` | persisted queue, idempotency keys, retries, crash recovery |

## 3. Node agent protocol

**Enrollment.** An admin creates a node in the UI and gets a one-time enrollment token: 32 random bytes, valid 1 hour,
stored hashed. On the node:

```
node agent/kapil-agent.js enroll --master https://panel.gyannportal.com --token <one-time token>
```

The agent sends its hostname and hardware facts. The master answers with `nodeId` + a 256-bit `nodeKey`, which the agent
stores in `/etc/kapil-agent/agent.json` (0600). The master stores only `sha256(nodeKey)`. The token is then spent.

**Session.** The agent opens `wss://<master>/agent/v1` with `Authorization: Bearer <nodeId>.<nodeKey>`. TLS comes from
Cloudflare; on the master itself the agent uses `ws://127.0.0.1:4000` (loopback). The master accepts one live connection per
node, and a revoked or removed node is refused. Frames are JSON:

| Direction | Frame | Purpose |
|---|---|---|
| agent → master | `hello {version, facts}` | capabilities: LXD version/extensions, Docker, KVM, pools, networks |
| agent → master | `heartbeat {metrics, instances}` every 15 s | CPU, RAM, MemAvailable, swap, PSI, disk, load, temperature, instance summaries |
| master → agent | `call {id, op, args}` | one whitelisted operation |
| agent → master | `result {id, ok, data \| error}` | |

Whitelisted operations are validated **on the agent** (names, sizes, enums) before LXD sees them:
`facts`, `instances.list`, `instance.state`, `instance.action {start,stop,restart,freeze,unfreeze}`,
`instance.snapshot.create/delete` (Phase 2). Create, delete, resize, exec streams and Docker follow in Phase 3 with the same pattern.

**Failure detection.** No heartbeat for 45 s → node `offline`, alert `node_offline` (critical), jobs for that node wait (they
are not lost). Reconnect → `online`, alert resolved. A node in `maintenance` receives no new placements.

**Removal.** Only when the node has no instances recorded, or with typed confirmation that leaves its instances
untouched (they simply stop being managed). The node key is revoked immediately.

**Not claimed:** high availability, live migration. Migration between nodes (export → transfer → import → verify → switch)
will be built only after storage and network compatibility checks exist (roadmap Phase 3+).

## 4. Jobs

A `jobs` table persists every long operation: `id, kind, node_id, target, payload, status (queued|running|succeeded|failed|cancelled),
attempts, max_attempts, idempotency_key UNIQUE, result, error, created_by, created_at, started_at, finished_at`.
An in-process worker (concurrency 2 per node) runs them. On restart, `running` jobs become `failed: interrupted` unless the
kind is marked safe to retry. Submitting the same idempotency key twice returns the first job (needed for payment webhooks and
retried API calls). Provisioning (Phase 3) is a job kind with steps and compensations, for example
`create → limits → start → ssh-keys`, and on failure: `stop → delete → release allocation`.

## 5. Tenancy and isolation

* Tenant = user account. Every instance, app, domain, key, file operation and job is checked against
  `user_containers` (ownership by instance name; names are globally unique across nodes).
* Instances are unprivileged LXD containers without nesting. **Customer Docker** runs *inside the customer's own container*
  (nesting enabled only for plans that include Docker, an explicit admin choice) and is reached through agent operations.
  The host Docker socket is never shared with tenants.
* File manager uses LXD's file API, which works inside the instance. A user can never name a host path. Paths are normalised
  and size-limited.
* Network: tenants get private IPs behind the master. Public exposure happens only through approved domains (tunnel routes
  to `container-ip:port`). Tenant firewall rules map to LXD network ACLs on the instance NIC (Phase 5; needs nftables
  support on the bridge, which the server audit will confirm).

## 6. API

* `/api/...` stays (browser, session cookie, CSRF).
* `/api/v1/...` mirrors the same routes for **API keys** (`Authorization: Bearer kc_<id>_<secret>`). Keys belong to a user,
  carry scopes (`read`, `servers:write`, `apps:write`, `domains:write`, `backups:write`), can expire, are stored hashed, and
  are revocable. A key can never do more than its user. Admin-only routes require an admin user **and** the `admin` scope.
* Rate limits apply per key. Usage is counted per key per day.

## 7. Billing (Phase 7)

Provider interface `{ initiate(order) → redirect; verify(callback) → {status, amount, ref} }`. eSewa ePay v2 is verified with the
server-side transaction status API, Khalti ePayment with the lookup API. A browser "success" redirect is never trusted.
`payments` and `ledger` are append-only (SQLite triggers reject UPDATE/DELETE). Webhooks/callbacks are idempotent on the
provider reference. **Disabled** until merchant credentials exist and sandbox verification has passed. Until then, orders go to
**admin approval**. Automatic suspension on non-payment is off by default.

## 8. Storage choice

SQLite stays. Write volume is small (one metrics row per scope per minute, a few audit rows per action), WAL mode handles
the concurrent readers, and backups are a single file. Moving to Postgres would only be considered if the control plane ever
runs on more than one process.

## 9. Resource awareness

Provisioning is refused if **any** of these holds (all configurable, defaults safe):
1. promised CPU > cores × CPU overcommit;
2. promised RAM > (RAM − host reserve) × memory overcommit;
3. promised disk > pool size × (1 − reserve);
4. the node's live `MemAvailable` minus the new limit falls below the host reserve;
5. memory pressure PSI `some avg60` > 10 % (the node is already thrashing);
6. swap usage > 50 %;
7. the node is offline or in maintenance.
