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
