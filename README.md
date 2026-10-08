# VPS Panel

Server ko CPU, RAM, disk, network, temperature, busiest processes, ra apps ma kati request aayo bhanne kura live herne panel.

- **backend/**: Node + Express + Socket.IO + systeminformation. Har 5 second ma data line, ani 1 ghanta ko history memory ma rakhcha.
- **frontend/**: React + Vite + Recharts dashboard. Build garepachi backend le nai serve garcha, tesaile eutai port (4000) matra chahincha.
- **tracker/panel-tracker.cjs**: Tapai ko aru Express apps ma halne middleware. Yasle request count panel ma pathaucha.

Panel ma login chahincha. **Admin** (kapil) le sabai kura dekhcha; **user** (sachin, animesh) le aafno LXD container matra dekhcha ra start / restart / power off garna sakcha. Hernus: [Users, login ra LXD containers](#users-login-ra-lxd-containers).

---

## Setup (kramai garnus)

Har command type/paste garnus, ani **Enter** thichnus.

### 1. Zip server ma pathaunus (laptop ko terminal ma)

```
scp ~/Downloads/vps-panel.zip kapil@ssh.gyannportal.com:~/
```
Password sodhyo bhane server ko password halnus, ani Enter thichnus.

### 2. Server ma login garnus

```
ssh kapil@ssh.gyannportal.com
```

### 3. Node ra unzip install garnus

```
sudo apt install -y unzip nodejs npm
```
Ani version check garnus. **18 wa tyo bhanda mathi** hunu parcha:
```
node -v
```

### 4. Unzip garnus

```
cd ~ && unzip vps-panel.zip
```

### 5. Frontend build garnus

```
cd ~/vps-panel/frontend && npm install && npm run build
```
`✓ built in ...` aayo bhane bhayo. "chunks are larger than 500 kB" warning aaucha, tyo normal ho.

### 6. Backend install garnus

```
cd ~/vps-panel/backend && npm install && cp .env.example .env
```

### 7. Secret token banaunus

```
openssl rand -hex 24
```
Lamo akshar ko line aaucha. Tyo copy garnus. Ani:
```
nano .env
```
`INGEST_TOKEN=` ko pachadi tyo token paste garnus (space bina). Save garna: **Ctrl + O** thichnus, ani **Enter** thichnus (kei type nagarnus). Ani **Ctrl + X** thichnus.

### 8. Test garnus

```
node server.js
```
`VPS panel running on http://127.0.0.1:4000` aayo bhane chalyo. Rokna **Ctrl + C** thichnus.

### 9. PM2 le sadhai chalne banaunus (restart pachi pani)

```
sudo npm install -g pm2
```
```
pm2 start server.js --name vps-panel
```
```
pm2 save
```
```
pm2 startup
```
Yo last command le `sudo env PATH=...` bata suru hune **euta lamo command print garcha**. Tyo pura line copy garnus, paste garnus, ani Enter thichnus.

### 10. Cloudflare ma route banaunus (browser ma)

Tunnel → **kapil-server** → **Published application routes** → **Add**:
- Subdomain: `panel`
- Domain: `gyannportal.com`
- Service URL: `http://localhost:4000`  (localhost ko spelling dhyan dinus)

**Save** thichnus. Ani browser ma `https://panel.gyannportal.com` kholnus.

### 11. Security: tapai ko email matra allow garnus (JARURI)

Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**:
- Domain: `panel.gyannportal.com`
- Policy: **Allow**, Include → **Emails** → tapai ko email

Aba panel kholda Cloudflare le email ma code pathaucha. Tapai bahek aru kasaile kholna sakdaina.

---

## Aru apps ko request count dekhaune

1. `tracker/panel-tracker.cjs` lai tapai ko Express app ko folder ma copy garnus.
2. App ko main file ma, `app.use(express.json())` bhanda mathi:
   ```js
   const panelTracker = require('./panel-tracker.cjs');
   app.use(panelTracker({ app: 'gyannportal-api' }));
   ```
   ESM / TypeScript app ho bhane:
   ```js
   import panelTracker from './panel-tracker.cjs';
   app.use(panelTracker({ app: 'gyannportal-api' }));
   ```
3. Tyo app ko `.env` ma panel ko jasto token halnus:
   ```
   PANEL_TOKEN=yaha-step-7-ko-token
   ```
4. App restart garnus. 5–10 second ma panel ko **Apps** table ma dekhaucha.

App ko naam ma akshar, number, `.`, `-`, `_` matra rakhnus.

---

## Useful commands

| Kaam | Command |
|---|---|
| Panel ko status herna | `pm2 status` |
| Logs herna (niskina Ctrl + C) | `pm2 logs vps-panel` |
| Code change pachi restart | `pm2 restart vps-panel` |
| Frontend change pachi | `cd ~/vps-panel/frontend && npm run build` |

## Settings (`backend/.env`)

| Naam | Default | Ke ho |
|---|---|---|
| `PORT` | 4000 | Panel ko port |
| `HOST` | 127.0.0.1 | Yo nachhunus. Panel tunnel bata matra khulos bhanera |
| `SAMPLE_MS` | 5000 | Kati millisecond ma data line |
| `HISTORY_MINUTES` | 60 | Kati minute ko history rakhne |
| `INGEST_TOKEN` | (khali) | Apps le request count pathauna chahine secret |

History memory ma matra cha, tesaile panel restart garda graph suru bata aaucha.

## Local ma develop garna (laptop ma)

Duita terminal kholnus:
```
cd backend && npm install && npm run dev
```
```
cd frontend && npm install && npm run dev
```
Ani `http://localhost:5173` kholnus.

---

## Users, login ra LXD containers

### What changed
- Every page and API route now needs a login (except `/login` and `/api/ingest`, which still uses `INGEST_TOKEN`).
- Roles: **admin** sees the host overview, all containers (with Start / Restart / Power off), **Users** and **Audit log** pages.
  **user** sees only the container mapped to them in the database. The server enforces this: for a user, the container
  always comes from their DB record, and asking for any other container returns `403`.
- Users, sessions and the audit log live in SQLite at `backend/data/panel.db` (created automatically, mode 600).
- Container stats and controls go through the LXD REST API on its unix socket. Nothing shells out.

### New `.env` variables (`backend/.env`)

| Name | Default | What it is |
|---|---|---|
| `SESSION_SECRET` | (required) | Signs login sessions. The panel refuses to start without it. `openssl rand -hex 32` |
| `SESSION_HOURS` | 12 | How long a login lasts |
| `COOKIE_SECURE` | true | Keep `true` in production (HTTPS via Cloudflare). `false` only for local dev over plain http |
| `DB_PATH` | `backend/data/panel.db` | SQLite file for users, sessions, audit log |
| `LXD_SOCKET` | `/var/snap/lxd/common/lxd/unix.socket` | LXD API socket |
| `SSH_HOST_TEMPLATE` | `{name}.gyannportal.com` | SSH hostname shown on each container card |

### Commands to run on the server (once)

```
# 1. Let the panel user talk to LXD (log out and back in afterwards so the group applies to your shell)
sudo usermod -aG lxd kapil

# 2. Get the new code onto the server, then install + build
cd ~/vps-panel/backend && npm install
cd ~/vps-panel/frontend && npm install && npm run build

# 3. Add the session secret
cd ~/vps-panel/backend
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
chmod 600 .env

# 4. Create users (asks for username, role, container and password; password is not shown while typing)
node scripts/create-user.js     # kapil   -> role admin
node scripts/create-user.js     # sachin  -> role user, container sachin
node scripts/create-user.js     # animesh -> role user, container animesh

# 5. Restart PM2 so the panel process picks up the new "lxd" group membership
#    (a plain `pm2 restart` keeps the old groups, because the PM2 daemon was started before usermod)
sudo systemctl restart pm2-kapil      # if you used `pm2 startup` (step 9 above)
#    or: pm2 kill && pm2 resurrect
pm2 logs vps-panel --lines 20         # should print "VPS panel running on ..."
```

Check LXD access after logging back in: `curl -s --unix-socket /var/snap/lxd/common/lxd/unix.socket lxd/1.0/instances` should list
`/1.0/instances/sachin` and `/1.0/instances/animesh`.

If `npm install` warns that `better-sqlite3` install scripts were not run (npm 11+), run
`npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`. If it has to compile, install `sudo apt install -y build-essential python3` first.

**Cloudflare Access (step 11 above):** if you only allowed your own email, sachin and animesh cannot reach the login page.
Add their emails to the Access policy (recommended: Access in front + panel login), or remove the Access app.

### Managing users
- In the panel: **Users** tab (admin) → create, reset password, delete. Resetting a password or deleting a user logs them out everywhere immediately.
- From the server: `cd ~/vps-panel/backend && node scripts/create-user.js`. If the username already exists it offers to reset the password
  (handy if you lock yourself out of the admin account).
- Everyone can change their own password from **Change password** in the top bar (other devices get logged out).

### Security notes
- Passwords: bcrypt (cost 12), minimum 10 characters. Never stored or printed in plain text.
- Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie; only an HMAC of it (keyed by `SESSION_SECRET`) is stored.
  Changing `SESSION_SECRET` logs everyone out.
- CSRF: every POST/PUT/DELETE needs the per-session `X-CSRF-Token` header and a same-site `Origin`. The live socket also rejects other origins.
- Login rate limit: 5 failed attempts per 15 minutes per client IP (from `CF-Connecting-IP`; this is only trustworthy because the panel
  listens on 127.0.0.1 behind the tunnel, so keep `HOST=127.0.0.1`). The limit is in memory and resets when the panel restarts.
- Audit log (**Audit log** tab): every login (success + failure, with IP), logout, password change, user create/reset/delete, and every
  start/restart/stop (when it was requested and whether it succeeded).
- Membership in the `lxd` group is effectively root on the host, so the panel process now has root-level power over LXD. Keep the panel
  updated, keep `.env` private, and keep Cloudflare Access in front if you can.

---

## Backups

The **Backups** tab (admin only) backs the server up to the HDD mounted at `/mnt/backup`:

- **LXD containers:** every container, found at run time, via `lxc export --instance-only` → `containers/<name>/<id>.tar.gz`
- **Host files:** incremental rsync snapshots (`--link-dest`, so unchanged files cost no space) → `host/<id>/...`
- **Databases:** Postgres / MySQL / MariaDB / MongoDB containers found in Docker, dumped with `docker exec` → `databases/<id>/*.gz`
- **PM2:** `pm2 save`, then `dump.pm2` is copied → `pm2/<id>/dump.pm2`

### How it fits together
- The panel never runs as root. Everything privileged goes through **one root-owned helper**, `/usr/local/sbin/panel-backup`
  (source: `system/panel-backup`, plain Node with no dependencies). The panel runs it with `sudo -n`, and `/etc/sudoers.d/panel-backup`
  allows `kapil` to run that one file and nothing else. The helper whitelists its subcommands and validates every argument
  (container names `^[a-z0-9][a-z0-9-]*$`, backup ids `YYYYMMDD-HHMMSS`, snapshot paths without `..` or symlinks). Every command it runs gets an argument array, never a shell string.
- Backups run in **`panel-backup.service`**, started by **`panel-backup.timer`** (daily) or by "Backup now". A backup therefore keeps going if the
  panel restarts, and the timer works while the panel is down. Only one job runs at a time (systemd plus a `flock` lock); a second request
  gets "already running".
- **Safety checks before every write:**
  - `/mnt/backup` must be a real mount (`findmnt`) on a different device than `/`, and carry the marker file `.panel-backup-id`.
  - The mount is re-checked before each step.
  - The estimated size must fit in 90% of the free space.
- Each backup is written as `*.partial` and renamed only when everything worked. `runs/<id>/manifest.json`, with the sha256 of every file,
  is written **last**, so a backup without one never counts as good. **Verify** re-checks all checksums.
- **Retention** (default 7 daily, 4 weekly, 3 monthly) runs only after a successful backup, and never removes the newest good backup.
- Settings live in `/etc/panel-backup/config.json`. Job records and logs (small text files) live in `/var/lib/panel-backup` on the SSD,
  readable by the panel. The panel copies them into SQLite (`backup_jobs`) and writes every start, finish, failure, settings change,
  verify, restore and download to the **Audit log**.
- **Restore:**
  - Containers are imported only under a **new** name, after you type that name. The copy gets new MAC addresses, is not started, and has autostart off.
  - Host files: browse a snapshot and download a file or folder as `.tar.gz`.
  - Database dumps are download-only.

### Backups: install (once, on the server)

Run these one at a time, as `kapil`. Lines starting with `#` are notes, not commands.

```
# 1. Tools (smartmontools gives the SMART health on the page; optional)
sudo apt install -y rsync smartmontools
# The helper needs Node at /usr/bin/node (apt "nodejs"). This must print a path, not an error:
ls -l /usr/bin/node

# 2. Find the HDD and its UUID (look for the ext4 partition on the HDD, e.g. sdb1)
lsblk -f

# 3. Mount point. chattr +i (while NOTHING is mounted there) makes the empty folder on the SSD read-only,
#    so nothing can ever be written to the SSD if the HDD is missing
sudo mkdir -p /mnt/backup
# Must say "/mnt/backup is not a mountpoint". If the HDD is mounted, run: sudo umount /mnt/backup
mountpoint /mnt/backup
sudo chattr +i /mnt/backup
echo 'UUID=PUT-THE-HDD-UUID-HERE /mnt/backup ext4 defaults,nofail,noatime 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /mnt/backup
findmnt /mnt/backup

# 4. Install the helper, its state folder and the default settings
cd ~/vps-panel
sudo install -o root -g root -m 0755 system/panel-backup /usr/local/sbin/panel-backup
sudo install -d -o root -g kapil -m 2750 /var/lib/panel-backup
sudo install -d -o root -g root -m 0755 /etc/panel-backup
sudo install -o root -g root -m 0644 system/config.example.json /etc/panel-backup/config.json

# 5. sudoers: check the file first, then install it, then check the whole sudo config
sudo visudo -cf system/panel-backup.sudoers
sudo install -o root -g root -m 0440 system/panel-backup.sudoers /etc/sudoers.d/panel-backup
sudo visudo -c
# Must print the settings as JSON without asking for a password:
sudo -n /usr/local/sbin/panel-backup get-config

# 6. Mark the HDD as the backup disk (also creates the folders and makes /mnt/backup root-only)
sudo panel-backup init-disk

# 7. systemd units. set-config writes the schedule and enables the timer
sudo install -o root -g root -m 0644 system/panel-backup.service system/panel-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo panel-backup set-config < /etc/panel-backup/config.json
systemctl list-timers panel-backup.timer

# 8. See what a backup would do, without writing anything
sudo panel-backup run --dry-run

# 9. Panel: build and restart (no new npm packages)
cd ~/vps-panel/frontend && npm run build
pm2 restart vps-panel
```

**After changing `system/panel-backup` later**, install it again (step 4, first `install` line). The panel never edits the installed copy.

**Disk space on the SSD during container exports:** LXD first builds each export tarball in `/var/snap/lxd/common/lxd/backups` (on the SSD),
then copies it to the HDD and deletes it. The helper checks there is room for the largest container and refuses otherwise.
To have LXD build them on the HDD instead (LXD then depends on the HDD being mounted when it starts):
```
lxc storage create hdd-backups dir source=/mnt/backup/lxd-tmp
lxc storage volume create hdd-backups backups
lxc config set storage.backups_volume hdd-backups/backups
```

**Database dumps** use the official images' environment variables (`POSTGRES_USER`, `MYSQL_ROOT_PASSWORD` / `MARIADB_ROOT_PASSWORD`,
`MONGO_INITDB_ROOT_USERNAME/PASSWORD`). If a dump fails, the error from `pg_dumpall` / `mysqldump` / `mongodump` is in the job log.
The whole backup counts as failed (and its partial files are removed) if any selected target fails.

### Useful commands

| Task | Command |
|---|---|
| Show what would happen | `sudo panel-backup run --dry-run` |
| Back up now from the shell | `sudo systemctl start panel-backup` |
| Follow a running backup | `journalctl -fu panel-backup` |
| Next scheduled run | `systemctl list-timers panel-backup.timer` |
| Disk / SMART status | `sudo panel-backup disk-status` |
| See what pruning would delete | `sudo panel-backup prune --dry-run` |
| Check a backup's checksums | `sudo panel-backup verify 20261009-023000` |

### Test plan

1. **Unit tests** (validation, path safety, retention rules, CLI rejects bad input). No root or disk needed:
   `node --test 'system/test/*.test.cjs'`
2. **Disk not mounted:** `sudo umount /mnt/backup`, then `sudo panel-backup run --dry-run` → "The backup disk is not mounted". Press
   **Backup now** in the panel → the same error. Remount with `sudo mount /mnt/backup`.
3. **Wrong disk:** mount a scratch disk with no `.panel-backup-id` at `/mnt/backup` → "…is missing. If this is the right backup disk, run init-disk".
4. **Too little space:** use a small loop disk as the target:
   `truncate -s 200M /tmp/small.img && mkfs.ext4 -q /tmp/small.img && sudo umount /mnt/backup && sudo mount -o loop /tmp/small.img /mnt/backup && sudo panel-backup init-disk`,
   then `sudo panel-backup run --dry-run` → "Not enough space". Afterwards: `sudo umount /mnt/backup && sudo mount /mnt/backup`.
5. **Dry run:** `sudo panel-backup run --dry-run` (or **Backup now → Dry run** in the panel) lists the disk check, size estimate, every command
   and what retention would remove. Check that nothing changed: `sudo find /mnt/backup -newer /etc/panel-backup/config.json` prints nothing new.
6. **First real backup:** **Backup now** → live progress and log appear, then Success in the history. `sudo ls /mnt/backup/runs/` has the id.
7. **Second backup is incremental:** run again; "New data" should be small, and `sudo du -sh /mnt/backup/host/*` shows the second snapshot is mostly hard links.
8. **Only one at a time:** press **Backup now** while one runs (button disabled), or run `sudo systemctl start panel-backup` and
   `sudo panel-backup verify <id>` together → "already running".
9. **Verify:** **Verify** on a backup → "All N files match". Then corrupt a copy: `sudo sh -c 'echo x >> /mnt/backup/databases/<id>/<file>'`,
   Verify again → reported as bad.
10. **Failure handling:** stop a database container's credentials from working (or `sudo umount -l /mnt/backup` during a run) → the job shows
    Failed with the error, the log stays readable, `sudo ls /mnt/backup/*/` shows no `.partial` leftovers after the next run.
11. **Restore:** Restore → Containers → `sachin` → name `sachin-test`, type it to confirm → a stopped `sachin-test` appears on the Containers page.
    Delete it afterwards with `lxc delete sachin-test`. Restoring to an existing name is refused.
12. **Files / databases:** browse a snapshot, download a file and a folder (`tar -tzf` the result), download a DB dump (`gunzip -t` it).
13. **Audit log:** every step above appears with your username (scheduled runs as `system`).
14. **Retention:** set Keep daily = 1, weekly = 0, monthly = 0, run two backups → after the second, only it remains (`sudo panel-backup list`).
    Put the settings back.
15. **Timer:** set the time two minutes ahead in Settings → `systemctl list-timers panel-backup.timer` shows it; the run appears as "Scheduled".
