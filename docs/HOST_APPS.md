# Host services: PM2 Manager, Docker Manager, Replicas & Load Balancer

These pages manage the **VPS itself** (kapil-server), not the LXD customer servers. Admins can view everything; only a
**super admin** can change anything. Every change is written to the audit log.

| Page | Backend | Talks to |
|---|---|---|
| PM2 Manager | `backend/pm2.js` → `/api/pm2/*` | `pm2` CLI of the panel user (argv only, no shell) |
| Docker Manager | `backend/docker.js` → `/api/docker/*` | Docker Engine API on `/var/run/docker.sock` |
| Replicas & LB | `backend/replicas.js` + `backend/loadbalancer.js` → `/api/infra/*` | PM2 / Docker + Nginx |

Shared: `backend/hostexec.js` (the only place host programs are run: fixed program list, argv arrays, timeouts, per-resource
locks so two conflicting changes never run at once, folder allow-list `HOST_APP_ROOTS`).

## Replicas & load balancing — how it works

```
 Cloudflare Tunnel  pos.example.com → http://localhost:8100
                                           │
                           Nginx  upstream kc_sampanna_pos  (127.0.0.1:8100)
                    ┌──────────────────────┼──────────────────────┐
             weight 50                weight 25               weight 25
        kc-sampanna-pos-0        kc-sampanna-pos-1        kc-sampanna-pos-2
         127.0.0.1:5000           127.0.0.1:5001           127.0.0.1:5002
           (primary)               (replica 1)              (replica 2)
                    └────────── same DATABASE_URL (one shared database) ──────────┘
```

* **Instances are real**: PM2 processes (`kc-<app>-<n>`, fork mode, `PORT` set per instance) or Docker containers with the
  same names (port published on 127.0.0.1 only, memory/CPU limits, `no-new-privileges`, never privileged).
* **Ports**: picked from `REPLICA_PORTS` (default 5000-5999), or from the "first port" you type. A port is refused if
  another Kapil Cloud app has it **or anything on the host is listening on it**.
* **Environment** is shared by all instances (so they all use the same database), stored AES-256-GCM encrypted, and never
  sent back to the browser. PM2 also keeps env in its own dump (`~/.pm2`) and the panel keeps the generated ecosystem file
  in `backend/data/pm2/` (mode 600) — both readable by the panel user only.
* **Health checks** every 10 s: `GET 127.0.0.1:<port><health path>`; < 500 = ok. 2 failures → *unhealthy* → marked `down`
  in Nginx (automatic failover) + `replica_down` alert. 2 successes → back in. If **every** instance is unhealthy they all stay
  in the pool (an empty pool is a guaranteed 502) and a critical `app_down` alert is raised. Nginx also retries a failed
  request on the next instance (`proxy_next_upstream`).
* **Traffic switching**: weights per instance (relative; 50/25/25 = 50 %/25 %/25 %), weight **0 = hot standby** (Nginx
  `backup`: gets traffic only when the others are down), or disable an instance entirely.
* **Every Nginx change**: write file → `sudo nginx -t` → `sudo systemctl reload nginx`. If the test fails, the old file is put
  back and nothing reloads. If the reload fails, the old file is put back and reloaded. The database change is rolled back
  too, so what the panel shows always matches what Nginx runs.
* **Rolling restart** (zero downtime with ≥ 2 healthy instances): one instance at a time is drained from Nginx, restarted,
  health-checked, put back.
* **Rolling update** (Docker): same, recreating each container with the new image. If an instance fails its health check,
  **that instance is rolled back** to the previous image and the rollout stops; instances after it are untouched.
  For PM2 apps, update the code in the app folder (git pull / build), then do a rolling restart.
* **Traffic numbers** come from Nginx itself: each app logs `$msec $status $request_time $upstream_addr` to
  `LB_LOG_DIR/<app>.access.log`; the panel reads new lines (requests/s, status codes, avg/p95 latency, share per instance).
  Active connections come from a local `stub_status` on `127.0.0.1:LB_STATUS_PORT` (Nginx counts these for all sites).

## Server setup (once)

Nothing below has been run on kapil-server yet. Run it yourself, in this order:

```bash
# 0. what is there today (read-only)
nginx -v; systemctl is-active nginx; sudo nginx -t
id kapil                      # Docker Manager needs kapil in the "docker" group
pm2 -v

# 1. Nginx include folder, log folder, sudo rule for exactly `nginx -t` and `systemctl reload nginx`
sudo bash ~/vps-panel/system/install-lb.sh --check   # shows what it would do
sudo bash ~/vps-panel/system/install-lb.sh           # backs up /etc/nginx first; undoes itself if nginx -t fails

# 2. (only if Docker Manager should work and kapil is not in the docker group yet; root-equivalent, like lxd)
sudo usermod -aG docker kapil && pm2 restart vps-panel --update-env   # a new login session may be needed

# 3. restrict where apps may run from (recommended)
echo 'HOST_APP_ROOTS=/home/kapil/apps' >> ~/vps-panel/backend/.env

# 4. deploy the panel (from the repo on the server)
cd ~/vps-panel && git pull && (cd backend && npm ci --omit=dev) && (cd frontend && npm ci && npm run build) && pm2 restart vps-panel
```

The panel copies its database before migration 4 runs (`panel.db.pre-migration-<time>`). Existing tables are not changed.

**Expose an app:** in Cloudflare Zero Trust → Tunnels → your tunnel → Public hostnames, route `pos.example.com` to
`http://localhost:<LB port>` (shown on the app page). The load balancer never listens on a public interface.

## Not done yet / honest limits

* The PM2 manager controls the PM2 daemon of the **panel user** (`kapil`). Processes under another user's PM2 (e.g. root)
  are not visible.
* No container terminal (`docker exec`) yet; use the Terminal page on the host.
* Git-based deployment pipeline (pull → install → build → test → deploy → health → switch → auto-rollback) for host apps is
  the next phase; today a PM2 rolling restart picks up whatever code is in the folder.
* Nginx counts active connections globally, not per app.
* Single node only. Replicas on a second VPS need the node agent (docs/CLOUD_ARCHITECTURE.md §3).

## Security notes

* All mutating routes: super admin + CSRF token + typed confirmation for anything destructive.
* No route accepts a command line. Programs are fixed (`hostexec.js`), arguments are validated (names, image refs, ports,
  absolute folders inside `HOST_APP_ROOTS`; `/etc`, `/root`, `/usr`, `/var/lib`, … are always refused).
* Docker containers created by the panel cannot bind-mount host folders (named volumes only), cannot be privileged, and
  publish ports on 127.0.0.1 only.
* Kapil Cloud replicas cannot be deleted from the PM2/Docker pages (only from their application, which keeps Nginx in sync).
* The panel user can write `/etc/nginx/kapil-cloud/`, and `sudo nginx -t` runs as root. Being in the `lxd` (and `docker`)
  group already makes that user root-equivalent, so this adds no new privilege, but keep the panel user's account protected.
