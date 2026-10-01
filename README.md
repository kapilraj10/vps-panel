# VPS Panel

Server ko CPU, RAM, disk, network, temperature, busiest processes, ra apps ma kati request aayo bhanne kura live herne panel.

- **backend/**: Node + Express + Socket.IO + systeminformation. Har 5 second ma data line, ani 1 ghanta ko history memory ma rakhcha.
- **frontend/**: React + Vite + Recharts dashboard. Build garepachi backend le nai serve garcha, tesaile eutai port (4000) matra chahincha.
- **tracker/panel-tracker.cjs**: Tapai ko aru Express apps ma halne middleware. Yasle request count panel ma pathaucha.

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
