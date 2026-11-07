# Purano version hatayera naya version deploy garne

Eutai port, eutai domain, eutai login. Code matra naya huncha.

| Kura | Ke huncha |
|---|---|
| Port, secrets, settings (`backend/.env`) | Jastai ko testai rahancha |
| Users, sessions, audit log (`backend/data`) | Rahancha. Naya version le pahilo start ma database aafai upgrade garcha |
| Folder (`~/vps-panel`) ra PM2 naam (`vps-panel`) | Same |
| Domain ra Cloudflare route (`panel.gyannportal.com` → `localhost:4000`) | Chhunna. Kei garnu pardaina |
| Aru PM2 apps, LXD containers, Nginx, firewall | Chhunna |
| Purano code | Live folder bata hatcha, `~/vps-panel.old-<time>` ma rakhcha. Naya thik bhayo bhane Step 6 le delete garcha |

Downtime: naya version tayar bhayepachi matra purano rokcha, tesaile dherai jaso kehi second matra (pahilo start ma database upgrade ko samaya thap huncha).

---

## 1. Build banaunus (laptop ma)

```bash
cd ~/Desktop/kapil/vps-panel
bash system/make-release.sh
```

`release/vps-panel-<version>.tar.gz` banaucha. Yasma `.env` ra database hudaina.

## 2. Server ma pathaunus (laptop ma)

```bash
scp release/vps-panel-<version>.tar.gz* kapil@ssh.gyannportal.com:~/
```

## 3. Server ma kholnus

```bash
ssh kapil@ssh.gyannportal.com
sha256sum -c vps-panel-*.tar.gz.sha256      # "OK" aaunu parcha
rm -rf ~/vps-panel-release
tar -xzf vps-panel-<version>.tar.gz
```

`sudo` nachalaunus. PM2 `kapil` user ko ho.

## 4. Check garnus (kei change gardaina)

```bash
bash ~/vps-panel-release/system/upgrade-panel.sh --check
```

Folder, port ra version print garcha. Ti thik chan ki herera matra agadi janus.

## 5. Upgrade garnus

```bash
bash ~/vps-panel-release/system/upgrade-panel.sh
```

Kramai yo garcha:

1. Naya version alag folder ma tayar garcha (`npm ci`). Purano chaliraknai huncha. Yaha fail bhayo bhane kehi change hudaina.
2. Purano rokcha, ani `.env` ra database `~/panel-predeploy/<time>/` ma save garcha.
3. Purano folder `~/vps-panel.old-<time>` ma sarcha, naya version `~/vps-panel` ma aaucha.
4. Naya start garcha ani `/healthz` ra `/login` check garcha.
5. **Naya healthy bhayena bhane purano version aafai farkincha**, purano database sanga.

## 6. Check garera purano delete garnus

Browser ma `https://panel.gyannportal.com` kholnus, login garnus, containers ra data herna. Sabai thik bhayo bhane:

```bash
bash ~/vps-panel/system/upgrade-panel.sh --cleanup     # DELETE type garnu parcha
rm -rf ~/vps-panel-release ~/vps-panel-*.tar.gz*
```

Yasle purano code permanently delete garcha. `~/panel-predeploy` rahancha (purano `.env` + database). Tyo pani chahindaina bhane aafai delete garna sakincha. Yesma secrets chan, kasailai nadinus.

---

## Samasya aayo bhane

**Purano version ma farkina** (`--cleanup` agadi matra hunchha):

```bash
bash ~/vps-panel/system/upgrade-panel.sh --rollback    # ROLLBACK type garnu parcha
```

Purano database pani farkincha. Upgrade pachi bhayeka database changes `~/vps-panel.rolledback-<time>` ma rahanchan.

| Dekhiyo | Ke garne |
|---|---|
| `Node ... is too old` | Node 20 wa mathi chahincha. `node -v` herera update garnus, ani feri chalaunus |
| `better-sqlite3 cannot load` | `sudo apt install -y build-essential python3`, ani feri chalaunus |
| `Something else still answers` | Tyo port arkai process le chiriraheko cha: `ss -ltnp \| grep :4000` |
| `DB_PATH ... outside` | Database `backend/data` bhitra sarnus, `.env` milaunus, ani feri chalaunus |
| `lxd` warning | `id \| grep lxd` check garnus, ani `sudo systemctl restart pm2-kapil` |
| Domain warning, tara panel healthy | `sudo systemctl status cloudflared`. Tunnel route `http://localhost:4000` nai hunu parcha |
| Backup helper warning | `sudo bash ~/vps-panel/system/install-backups.sh` |
| Log herna | `pm2 logs vps-panel --lines 50 --nostream` |

Panel ko naam wa domain farak bhaye: `PM2_NAME=mero-panel PANEL_DOMAIN=mero.example.com bash .../upgrade-panel.sh`.

## Naya features ko lagi (optional)

Upgrade ko lagi yo chahindaina. Chalaunu bhayo bhane matra:

- Nginx load balancer: `sudo bash ~/vps-panel/system/install-lb.sh` ([HOST_APPS.md](HOST_APPS.md))
- Agents ra multi-VPS: [FLEET.md](FLEET.md)
- Docker manager: `sudo usermod -aG docker kapil`, ani `sudo systemctl restart pm2-kapil`. `docker` group root barabar ho, chahiyo bhane matra thapnus.
